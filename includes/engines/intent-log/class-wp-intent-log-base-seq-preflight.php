<?php
/**
 * Intent-log base-seq preflight for wp_update_post().
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Intent_Log_Base_Seq_Preflight' ) ) {
	/**
	 * The intent-log machine-writer lane: a `wp_update_post()` caller
	 * (WP-CLI, plugins, REST via the `base_seq` request param on posts and
	 * pages) passes `intent_log_base_seq` — the room seq whose
	 * materialization it read before editing — and its save is DIFFED
	 * against the document at that seq and authored as ordinary typed
	 * intents through the engine: transforms, per-intent dispositions, the
	 * kses lane, and the review lane all apply exactly as they do to a
	 * browser session's edits. The saved `post_content` is then replaced
	 * with the merged canonical materialization (identity metadata
	 * included), so post and room stay convergent.
	 *
	 * The diff is keyed by the `metadata.syncId` identity that
	 * `materialize()` persists into content — a round-tripping writer
	 * carries block identity for free, which is what makes the diff sound:
	 * changed fields become versioned `replace_attr_content` register
	 * writes (+ `format_text` replays for the new field's spans), changed
	 * attrs become versioned `set_attr`/`remove_attr` writes, structure
	 * becomes `insert_block`/`remove_block`/`move_block`. Concurrent edits
	 * since the declared base merge by transform; genuine collisions park
	 * for review — surfaced, never lost, never silently overwritten.
	 *
	 * Unlike de-rtc's base-version lane, conflicts never REJECT the save:
	 * intent-log's per-intent model lands the clean intents and parks the
	 * contested ones, which is the engine's normal policy. Only an
	 * unusable base (below the retained floor, ahead of head, or no
	 * intent-log room) aborts, retrievable via `last_error()`.
	 */
	class WP_Intent_Log_Base_Seq_Preflight {

		/**
		 * Client id attributed to base-seq writers in room rows.
		 */
		const WRITER_CLIENT_ID = 2000000003;

		/**
		 * Merged canonical awaiting the data filter, keyed by post ID.
		 *
		 * @var array<int, string>
		 */
		private static $merged_content = array();

		/**
		 * The last preflight rejection.
		 *
		 * @var WP_Error|null
		 */
		private static $last_error = null;

		/**
		 * Dispositions of the last preflighted save's intents.
		 *
		 * @var array|null
		 */
		private static $last_dispositions = null;

		/**
		 * Hooks the preflight.
		 *
		 * @since 0.5.0
		 *
		 * @return void
		 */
		public static function register(): void {
			add_filter( 'wp_insert_post_empty_content', array( __CLASS__, 'preflight' ), 10, 2 );
			add_filter( 'wp_insert_post_data', array( __CLASS__, 'apply_merged_content' ), 10, 2 );
			add_action( 'wp_after_insert_post', array( __CLASS__, 'cleanup' ) );
			foreach ( array( 'post', 'page' ) as $type ) {
				add_filter( "rest_pre_insert_{$type}", array( __CLASS__, 'map_rest_base_seq' ), 10, 2 );
			}
		}

		/**
		 * The last preflight rejection, or null.
		 *
		 * @since 0.5.0
		 *
		 * @return WP_Error|null Rejection reason.
		 */
		public static function last_error(): ?WP_Error {
			return self::$last_error;
		}

		/**
		 * Per-intent dispositions of the last preflighted save — how each
		 * of the writer's edits settled (applied / escalated / voided).
		 *
		 * @since 0.5.0
		 *
		 * @return array|null Dispositions.
		 */
		public static function last_dispositions(): ?array {
			return self::$last_dispositions;
		}

		/**
		 * Maps a REST request's `base_seq` param onto the prepared post.
		 *
		 * @since 0.5.0
		 *
		 * @param stdClass        $prepared Prepared post object.
		 * @param WP_REST_Request $request  Request.
		 * @return stdClass Prepared post.
		 */
		public static function map_rest_base_seq( $prepared, $request ) {
			$base_seq = $request['base_seq'] ?? null;
			if ( is_numeric( $base_seq ) ) {
				$prepared->intent_log_base_seq = (int) $base_seq;
			}
			return $prepared;
		}

		/**
		 * Diffs and ingests a save carrying `intent_log_base_seq`.
		 *
		 * @since 0.5.0
		 *
		 * @param bool  $maybe_empty Whether the post is considered empty.
		 * @param array $postarr     Slashed, sanitized post data.
		 * @return bool True aborts the write.
		 */
		public static function preflight( $maybe_empty, $postarr ) {
			if ( $maybe_empty || ! is_array( $postarr ) || ! isset( $postarr['intent_log_base_seq'] ) || ! is_numeric( $postarr['intent_log_base_seq'] ) ) {
				return $maybe_empty;
			}
			$post_id = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
			if ( $post_id <= 0 || ! interface_exists( 'WP_Sync_Storage' ) ) {
				return $maybe_empty;
			}

			self::$last_error        = null;
			self::$last_dispositions = null;

			$post_type = isset( $postarr['post_type'] ) ? (string) $postarr['post_type'] : (string) get_post_type( $post_id );
			$room      = 'postType/' . $post_type . ':' . $post_id;

			if ( 'intent-log' !== self::room_engine( $room ) ) {
				self::$last_error = new WP_Error(
					'intent_log_base_seq_no_room',
					__( 'This post has no intent-log room to merge with.', 'gutenberg' ),
					array( 'status' => 409 )
				);
				return true;
			}

			$engine   = new WP_Intent_Log_Engine( gutenberg_sync_engines_storage() );
			$base_seq = (int) $postarr['intent_log_base_seq'];
			$base_doc = $engine->document_at( $room, $base_seq );
			if ( null === $base_doc ) {
				self::$last_error = new WP_Error(
					'intent_log_base_seq_stale',
					__( 'The given base seq is outside the room\'s retained window. Re-read the post and retry against its current state.', 'gutenberg' ),
					array( 'status' => 409 )
				);
				return true;
			}

			$content = (string) wp_unslash( $postarr['post_content'] ?? '' );
			$specs   = WP_Intent_Log_Engine::blocks_to_specs( parse_blocks( $content ), $post_id, array() );
			$intents = self::diff_to_intents( $base_doc, $specs );

			if ( array() !== $intents ) {
				$updates = array();
				foreach ( $intents as $index => $intent ) {
					$updates[] = array(
						'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
						'data' => wp_json_encode(
							array(
								'intentId' => 'ext-' . md5( $content . '|' . $base_seq ) . '-' . $index,
								'baseSeq'  => $base_seq,
								'type'     => $intent['type'],
								'payload'  => $intent['payload'],
							)
						),
					);
				}
				$result = $engine->handle_updates( $room, self::WRITER_CLIENT_ID, 0, $updates, array() );
				if ( is_wp_error( $result ) ) {
					self::$last_error = $result;
					return true;
				}
				self::$last_dispositions = $result['dispositions'];
			}

			// The save lands as the merged canonical (identity metadata
			// included) — post and room stay convergent, and any parked
			// collisions surface in the review lane rather than the post.
			$merged = $engine->materialize( $room );
			if ( is_string( $merged ) ) {
				self::$merged_content[ $post_id ] = $merged;
			}

			return $maybe_empty;
		}

		/**
		 * Replaces the content being saved with the merged canonical.
		 *
		 * @since 0.5.0
		 *
		 * @param array $data    Slashed post data about to be saved.
		 * @param array $postarr Raw post array.
		 * @return array Post data.
		 */
		public static function apply_merged_content( array $data, array $postarr ): array {
			$post_id = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
			if ( $post_id > 0 && isset( self::$merged_content[ $post_id ] ) ) {
				$data['post_content'] = wp_slash( self::$merged_content[ $post_id ] );
				unset( self::$merged_content[ $post_id ] );
			}
			return $data;
		}

		/**
		 * Clears leftover per-request state after a save completes.
		 *
		 * @since 0.5.0
		 *
		 * @return void
		 */
		public static function cleanup(): void {
			self::$merged_content = array();
		}

		/**
		 * The room's engine lineage WITHOUT creating storage (the
		 * framework storage's non-creating read).
		 *
		 * @since 0.5.0
		 *
		 * @param string $room Room identifier.
		 * @return string|null Engine slug, or null.
		 */
		private static function room_engine( string $room ): ?string {
			$storage = gutenberg_sync_engines_storage();
			if ( ! method_exists( $storage, 'peek_room_engine' ) ) {
				// A storage without a non-creating read gives no safe way
				// to look; treat the room as absent rather than create it.
				return null;
			}
			return $storage->peek_room_engine( $room );
		}

		/**
		 * Flattens a block tree (engine-doc nodes or specs — same shape)
		 * into document-ordered id => placement records.
		 *
		 * @param array       $map       Accumulator (by reference).
		 * @param array       $nodes     Sibling nodes.
		 * @param string|null $parent_id Parent syncId.
		 * @return void
		 */
		private static function flatten( array &$map, array $nodes, ?string $parent_id ): void {
			$prev = null;
			foreach ( $nodes as $node ) {
				if ( ! is_array( $node ) || ! is_string( $node['syncId'] ?? null ) ) {
					continue;
				}
				$map[ $node['syncId'] ] = array(
					'node'   => $node,
					'parent' => $parent_id,
					'after'  => $prev,
				);
				self::flatten( $map, is_array( $node['children'] ?? null ) ? $node['children'] : array(), $node['syncId'] );
				$prev = $node['syncId'];
			}
		}

		/**
		 * Diffs the saved specs against the base document into typed
		 * intents (document identity via syncIds).
		 *
		 * @param array $base_doc Engine document at the declared base seq.
		 * @param array $specs    Block specs parsed from the saved content.
		 * @return array<int, array{type: string, payload: array}> Intents.
		 */
		private static function diff_to_intents( array $base_doc, array $specs ): array {
			$base_map = array();
			$new_map  = array();
			self::flatten( $base_map, is_array( $base_doc['root'] ?? null ) ? $base_doc['root'] : array(), null );
			self::flatten( $new_map, $specs, null );

			$intents = array();

			// Removals: topmost only (a removed subtree goes with its root).
			foreach ( $base_map as $id => $info ) {
				if ( isset( $new_map[ $id ] ) ) {
					continue;
				}
				if ( null !== $info['parent'] && ! isset( $new_map[ $info['parent'] ] ) ) {
					continue;
				}
				$intents[] = array(
					'type'    => 'remove_block',
					'payload' => array( 'syncId' => $id ),
				);
			}

			foreach ( $new_map as $id => $info ) {
				if ( ! isset( $base_map[ $id ] ) ) {
					// Insertions: topmost only (the block spec carries its
					// subtree). Document order guarantees an inserted
					// afterSibling already landed.
					if ( null === $info['parent'] || isset( $base_map[ $info['parent'] ] ) ) {
						$intents[] = array(
							'type'    => 'insert_block',
							'payload' => array(
								'block'          => $info['node'],
								'parentId'       => $info['parent'],
								'afterSiblingId' => $info['after'],
							),
						);
					}
					continue;
				}

				$base_node = $base_map[ $id ]['node'];
				$new_node  = $info['node'];
				$versions  = is_array( $base_node['attrVersions'] ?? null ) ? $base_node['attrVersions'] : array();

				// Content field: a versioned whole-field register write,
				// with the new field's format spans replayed after it
				// (replace_attr_content resets formats by design).
				$base_field = is_array( $base_node['fields']['content'] ?? null )
					? $base_node['fields']['content']
					: array(
						'text'    => '',
						'formats' => array(),
					);
				$new_field  = is_array( $new_node['fields']['content'] ?? null )
					? $new_node['fields']['content']
					: array(
						'text'    => '',
						'formats' => array(),
					);
				if ( wp_json_encode( $base_field ) !== wp_json_encode( $new_field ) ) {
					$intents[] = array(
						'type'    => 'replace_attr_content',
						'payload' => array(
							'syncId'          => $id,
							'field'           => 'content',
							'newText'         => (string) $new_field['text'],
							'observedVersion' => (int) ( $versions['content'] ?? 0 ),
						),
					);
					foreach ( is_array( $new_field['formats'] ?? null ) ? $new_field['formats'] : array() as $span ) {
						if ( ! is_array( $span ) || (int) ( $span['end'] ?? 0 ) <= (int) ( $span['start'] ?? 0 ) ) {
							continue;
						}
						$intents[] = array(
							'type'    => 'format_text',
							'payload' => array(
								'syncId' => $id,
								'field'  => 'content',
								'start'  => (int) $span['start'],
								'end'    => (int) $span['end'],
								'format' => (string) $span['format'],
								'on'     => true,
							),
						);
					}
				}

				// Attribute registers (identity and wrapper internals are
				// not writer-owned).
				$base_attrs = is_array( $base_node['attrs'] ?? null ) ? $base_node['attrs'] : array();
				$new_attrs  = is_array( $new_node['attrs'] ?? null ) ? $new_node['attrs'] : array();
				unset( $base_attrs['_wrapper'], $base_attrs['metadata'], $new_attrs['_wrapper'], $new_attrs['metadata'] );
				foreach ( $new_attrs as $key => $value ) {
					if ( array_key_exists( $key, $base_attrs ) && wp_json_encode( $base_attrs[ $key ] ) === wp_json_encode( $value ) ) {
						continue;
					}
					$intents[] = array(
						'type'    => 'set_attr',
						'payload' => array(
							'syncId'          => $id,
							'key'             => (string) $key,
							'value'           => $value,
							'observedVersion' => (int) ( $versions[ $key ] ?? 0 ),
						),
					);
				}
				foreach ( array_keys( $base_attrs ) as $key ) {
					if ( array_key_exists( $key, $new_attrs ) ) {
						continue;
					}
					$intents[] = array(
						'type'    => 'remove_attr',
						'payload' => array(
							'syncId'          => $id,
							'key'             => (string) $key,
							'observedVersion' => (int) ( $versions[ $key ] ?? 0 ),
						),
					);
				}

				// Placement changes.
				if ( $info['parent'] !== $base_map[ $id ]['parent'] || $info['after'] !== $base_map[ $id ]['after'] ) {
					$intents[] = array(
						'type'    => 'move_block',
						'payload' => array(
							'syncId'         => $id,
							'newParentId'    => $info['parent'],
							'afterSiblingId' => $info['after'],
						),
					);
				}
			}

			return $intents;
		}
	}
}
