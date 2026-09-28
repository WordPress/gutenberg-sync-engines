<?php
/**
 * DE-RTC durable block identity (syncId).
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_De_RTC_Block_Identity' ) ) {
	/**
	 * Gives every block in a de-rtc room a durable identity.
	 *
	 * The scheme is the one intent-log already uses: each block carries
	 * `metadata.syncId` in its comment delimiter, so the id lives in the
	 * saved post_content, survives kses, and is visible to every writer.
	 * Two minting regimes, per the sync spec:
	 *
	 * - GENESIS (deterministic): blocks of the saved post get ids computed
	 *   from (postId, 0, block path) — the exact function the editor-side
	 *   stamper (includes/engines/intent-log/sync-id.js) and the intent-log
	 *   room genesis use, so every independent minter agrees without any
	 *   coordination.
	 * - CREATION (random): blocks that reach the server without an id
	 *   (engine-unaware writers, a proposal that beat the editor stamper)
	 *   get a random id when they land in canonical content.
	 *
	 * Stamping is a TEXTUAL splice into the opening delimiter, never a
	 * parse-and-reserialize of the document: PHP's serializer escapes
	 * slashes and non-ASCII differently from the editor's, so a round trip
	 * would rewrite the bytes of every block with attributes and make each
	 * client's first commit look like an edit of the whole document. The
	 * splice appends `metadata` LAST in the attribute JSON, which is where
	 * the editor puts it (the metadata attribute is registered after every
	 * block's own attributes), so a stamped delimiter is byte-identical to
	 * what the editor would serialize for the same block.
	 *
	 * Safety: the splice pairs each opening delimiter (document order) with
	 * the block tree's pre-order walk and verifies the block name at every
	 * step; any disagreement leaves the content untouched. Identity is
	 * optional — a block without an id merges exactly as it does today.
	 *
	 * @since 0.0.1
	 */
	class WP_De_RTC_Block_Identity {

		/**
		 * The block delimiter tokenizer (WP_Block_Parser::next_token's
		 * pattern): every opening delimiter in document order is one
		 * block of the parsed tree, in pre-order.
		 */
		const DELIMITER_PATTERN = '/<!--\s+(?P<closer>\/)?wp:(?P<namespace>[a-z][a-z0-9_-]*\/)?(?P<name>[a-z][a-z0-9_-]*)\s+(?P<attrs>{(?:(?:[^}]+|}+(?=})|(?!}\s+\/?-->).)*+)?}\s+)?(?P<void>\/)?-->/s';

		/**
		 * Stamps deterministic genesis ids onto every block that lacks one.
		 *
		 * @since 0.0.1
		 *
		 * @param string $content Stripped post content.
		 * @param int    $post_id Post ID (genesis id input).
		 * @return string Content with every block identified.
		 */
		public static function stamp_genesis( string $content, int $post_id ): string {
			if ( $post_id <= 0 || ! class_exists( 'WP_Intent_Log_Planner' ) ) {
				return $content;
			}
			return self::stamp(
				$content,
				static function ( array $path ) use ( $post_id ): string {
					return WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, $path );
				}
			);
		}

		/**
		 * Stamps random creation ids onto every block that lacks one (or
		 * duplicates an earlier one).
		 *
		 * @since 0.0.1
		 *
		 * @param string $content Stripped content about to become canonical.
		 * @return string Content with every block identified.
		 */
		public static function stamp_creations( string $content ): string {
			return self::stamp(
				$content,
				static function (): string {
					return wp_generate_uuid4();
				}
			);
		}

		/**
		 * Carries identity over from a base document onto a proposal that
		 * lacks it.
		 *
		 * Engine-unaware writers (scripts, plain saves, a tab that read the
		 * post before its first aware save) round-trip post_content without
		 * ids. Their proposal must still line up with the identified base,
		 * so an id-less block adopts the base's id at the same path when the
		 * block names match — the writer never touched identity, so the
		 * block at that path IS that block. Blocks with no counterpart, and
		 * ids already present elsewhere in the proposal, are left alone
		 * (creation stamping handles them).
		 *
		 * @since 0.0.1
		 *
		 * @param string $proposed Proposed stripped content.
		 * @param string $base     Base stripped content (identified).
		 * @return string Proposed content with base identity adopted.
		 */
		public static function adopt( string $proposed, string $base ): string {
			if ( ! self::needs_stamping( $proposed ) ) {
				return $proposed;
			}
			$by_path = array();
			foreach ( self::collect( $base ) as $block ) {
				if ( null !== $block['syncId'] && ! $block['duplicate'] ) {
					$by_path[ implode( '.', $block['path'] ) ] = $block;
				}
			}
			if ( array() === $by_path ) {
				return $proposed;
			}
			$used = array();
			foreach ( self::collect( $proposed ) as $block ) {
				if ( null !== $block['syncId'] ) {
					$used[ $block['syncId'] ] = true;
				}
			}
			$names = array();
			foreach ( self::collect( $proposed ) as $block ) {
				$names[ implode( '.', $block['path'] ) ] = $block['name'];
			}
			return self::stamp(
				$proposed,
				static function ( array $path ) use ( $by_path, &$used, $names ): ?string {
					$key       = implode( '.', $path );
					$candidate = $by_path[ $key ] ?? null;
					if ( null === $candidate || ( $names[ $key ] ?? null ) !== $candidate['name'] || isset( $used[ $candidate['syncId'] ] ) ) {
						return null;
					}
					$used[ $candidate['syncId'] ] = true;
					return $candidate['syncId'];
				}
			);
		}

		/**
		 * Whether content has a block without an id, or two blocks sharing
		 * one — i.e. whether stamping would change it.
		 *
		 * @since 0.0.1
		 *
		 * @param string $content Stripped content.
		 * @return bool Whether any block needs an id.
		 */
		public static function needs_stamping( string $content ): bool {
			if ( false === strpos( $content, 'wp:' ) ) {
				return false;
			}
			foreach ( self::collect( $content ) as $block ) {
				if ( null === $block['syncId'] || $block['duplicate'] ) {
					return true;
				}
			}
			return false;
		}

		/**
		 * Lists every named block in pre-order with its path and id.
		 *
		 * @since 0.0.1
		 *
		 * @param string $content Stripped content.
		 * @return array<int, array{name: string, path: int[], syncId: string|null, duplicate: bool, attrs: array}> Blocks.
		 */
		public static function collect( string $content ): array {
			$seen = array();
			return self::walk( parse_blocks( $content ), array(), $seen );
		}

		/**
		 * Stamps ids from a minter onto the blocks that need one.
		 *
		 * @since 0.0.1
		 *
		 * @param string   $content Stripped content.
		 * @param callable $mint    function( int[] $path ): ?string — the id
		 *                          for a block, or null to leave it unstamped.
		 * @return string Stamped content, or the input when nothing needed
		 *                stamping or the delimiters could not be paired.
		 */
		public static function stamp( string $content, callable $mint ): string {
			if ( ! self::needs_stamping( $content ) ) {
				return $content;
			}

			$plan  = self::collect( $content );
			$index = 0;
			$ok    = true;

			$stamped = preg_replace_callback(
				self::DELIMITER_PATTERN,
				static function ( array $token ) use ( &$index, &$ok, $plan, $mint ): string {
					if ( ! $ok || ! empty( $token['closer'] ) ) {
						return $token[0];
					}
					$entry = $plan[ $index ] ?? null;
					++$index;
					$name = ( $token['namespace'] ?? '' ) . $token['name'];
					if ( false === strpos( $name, '/' ) ) {
						$name = 'core/' . $name;
					}
					if ( null === $entry || $entry['name'] !== $name ) {
						$ok = false;
						return $token[0];
					}
					if ( null !== $entry['syncId'] && ! $entry['duplicate'] ) {
						return $token[0];
					}
					$sync_id = $mint( $entry['path'] );
					if ( ! is_string( $sync_id ) || '' === $sync_id ) {
						return $token[0];
					}
					return self::splice( $token, $entry['attrs'], $sync_id );
				},
				$content
			);

			if ( ! $ok || null === $stamped || count( $plan ) !== $index ) {
				return $content;
			}
			return $stamped;
		}

		/**
		 * Pre-order walk of a parsed block tree.
		 *
		 * Path indices follow the editor's block order: named blocks and
		 * non-empty classic (freeform) runs occupy an index, whitespace-only
		 * fragments do not — the same rule intent-log's genesis applies, so
		 * the editor stamper, intent-log, and de-rtc derive identical ids.
		 *
		 * @param array    $blocks Output of parse_blocks() (or innerBlocks).
		 * @param int[]    $path   Path of the parent.
		 * @param string[] $seen   Ids seen so far, by reference.
		 * @return array Pre-order entries for the named blocks.
		 */
		private static function walk( array $blocks, array $path, array &$seen ): array {
			$entries = array();
			$index   = 0;
			foreach ( $blocks as $block ) {
				if ( empty( $block['blockName'] ) ) {
					if ( '' !== trim( (string) ( $block['innerHTML'] ?? '' ) ) ) {
						++$index;
					}
					continue;
				}
				$block_path = array_merge( $path, array( $index ) );
				++$index;
				$attrs   = is_array( $block['attrs'] ?? null ) ? $block['attrs'] : array();
				$sync_id = $attrs['metadata']['syncId'] ?? null;
				$sync_id = is_string( $sync_id ) && '' !== $sync_id ? $sync_id : null;

				$duplicate = null !== $sync_id && isset( $seen[ $sync_id ] );
				if ( null !== $sync_id && ! $duplicate ) {
					$seen[ $sync_id ] = true;
				}

				$entries[] = array(
					'name'      => (string) $block['blockName'],
					'path'      => $block_path,
					'syncId'    => $sync_id,
					'duplicate' => $duplicate,
					'attrs'     => $attrs,
				);

				if ( ! empty( $block['innerBlocks'] ) && is_array( $block['innerBlocks'] ) ) {
					$entries = array_merge( $entries, self::walk( $block['innerBlocks'], $block_path, $seen ) );
				}
			}
			return $entries;
		}

		/**
		 * Rewrites one opening delimiter so its attributes carry the id.
		 *
		 * @param array  $token   Delimiter match (named groups).
		 * @param array  $attrs   The block's decoded attributes.
		 * @param string $sync_id The id to stamp.
		 * @return string The rewritten delimiter.
		 */
		private static function splice( array $token, array $attrs, string $sync_id ): string {
			$delimiter = $token[0];
			$fragment  = self::escape( '"metadata":{"syncId":' . wp_json_encode( $sync_id ) . '}' );

			if ( empty( $token['attrs'] ) ) {
				// `<!-- wp:name -->` or `<!-- wp:name /-->`: insert the
				// attribute JSON right after the name.
				$needle   = 'wp:' . ( $token['namespace'] ?? '' ) . $token['name'];
				$position = strpos( $delimiter, $needle );
				if ( false === $position ) {
					return $delimiter;
				}
				$position += strlen( $needle );
				return substr( $delimiter, 0, $position ) . ' {' . $fragment . '}' . substr( $delimiter, $position );
			}

			$json     = rtrim( $token['attrs'] );
			$position = strpos( $delimiter, $json );
			if ( false === $position ) {
				return $delimiter;
			}

			if ( isset( $attrs['metadata'] ) ) {
				// Metadata exists without an id (or with a duplicated one):
				// re-encode this block's attributes with the id in place.
				$attrs['metadata']           = is_array( $attrs['metadata'] ) ? $attrs['metadata'] : array();
				$attrs['metadata']['syncId'] = $sync_id;
				$new_json                    = serialize_block_attributes( $attrs );
			} else {
				$body     = substr( $json, 1, -1 );
				$new_json = '' === trim( $body )
					? '{' . $fragment . '}'
					: '{' . $body . ',' . $fragment . '}';
			}

			return substr_replace( $delimiter, $new_json, $position, strlen( $json ) );
		}

		/**
		 * The delimiter-safe escaping serialize_block_attributes() applies.
		 *
		 * @param string $json Attribute JSON fragment.
		 * @return string Escaped fragment.
		 */
		private static function escape( string $json ): string {
			return str_replace(
				array( '--', '<', '>', '&', '\\"' ),
				array( '\\u002d\\u002d', '\\u003c', '\\u003e', '\\u0026', '\\u0022' ),
				$json
			);
		}
	}
}
