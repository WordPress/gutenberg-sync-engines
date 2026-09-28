<?php
/**
 * DE-RTC identity-keyed three-way merge (nested blocks).
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_De_RTC_Identity_Merge' ) ) {
	/**
	 * Three-way merges a proposal against the current canonical content by
	 * BLOCK IDENTITY at every depth, instead of by top-level position.
	 *
	 * The frozen merge core lines blocks up by their top-level index and
	 * treats a container (Group, Columns, List…) as one opaque record, so
	 * two people editing different paragraphs inside the same Group both
	 * "changed the same block" and one of them parked. With every block
	 * carrying a durable `metadata.syncId` (WP_De_RTC_Block_Identity), the
	 * three documents can be matched block-for-block:
	 *
	 * - A block changed on one side only takes that side's form.
	 * - A block changed on both sides gets the core's single-block merge
	 *   (rich text, table cells); a genuine conflict keeps the canonical
	 *   form and parks the proposal's form of JUST that block.
	 * - Each parent's child list merges by identity: insertions land next
	 *   to the sibling they followed, a deletion wins over a concurrent
	 *   edit (which parks, on whichever side it was made), a move follows
	 *   the block. Clashing reorders of one parent keep the canonical
	 *   order and park the proposal's form of that container.
	 *
	 * Containers are rebuilt from their own inner content (prefix, child
	 * separator, suffix — the shape the editor's serializer always
	 * produces) around the merged children, so untouched blocks keep their
	 * exact bytes. The merge DECLINES (returns null) whenever it cannot be
	 * sure — a block without an id, a duplicated id, classic content
	 * between blocks, an irregular container, a document that does not
	 * survive the parser round trip — and the positional core runs as
	 * before. Identity therefore only ever adds merges; it never changes
	 * what the core would have decided on its own.
	 *
	 * @since 0.0.1
	 */
	class WP_De_RTC_Identity_Merge {

		/**
		 * Merges a proposal by block identity.
		 *
		 * @since 0.0.1
		 *
		 * @param string $base     Accepted-base stripped content.
		 * @param string $current  Current canonical stripped content.
		 * @param string $proposed Proposed stripped content.
		 * @return array|null array{merged_content: string, conflicts: array,
		 *                    merge_strategy: string} or null to decline.
		 */
		public static function merge( string $base, string $current, string $proposed ): ?array {
			$base     = wp_de_rtc_canonicalize_post_content_core_block_names( $base );
			$current  = wp_de_rtc_canonicalize_post_content_core_block_names( $current );
			$proposed = wp_de_rtc_canonicalize_post_content_core_block_names( $proposed );

			$b = self::model( $base );
			$c = self::model( $current );
			$p = self::model( $proposed );
			if ( null === $b || null === $c || null === $p ) {
				return null;
			}

			$ids = array_unique( array_merge( array_keys( $b['nodes'] ), array_keys( $c['nodes'] ), array_keys( $p['nodes'] ) ) );

			$winner    = array(); // Which side each surviving block takes its own content from.
			$parent    = array(); // The parent each surviving block ends up under (empty string at the root).
			$conflicts = array(); // Parked proposal subtrees.
			$park      = static function ( string $id ) use ( $p, &$conflicts ): void {
				if ( ! isset( $p['nodes'][ $id ] ) ) {
					return;
				}
				$conflicts[ $id ] = array(
					'syncId' => $id,
					'path'   => $p['nodes'][ $id ]['path'],
					'html'   => $p['nodes'][ $id ]['subtree'],
				);
			};

			foreach ( $ids as $id ) {
				$bn = $b['nodes'][ $id ] ?? null;
				$cn = $c['nodes'][ $id ] ?? null;
				$pn = $p['nodes'][ $id ] ?? null;

				if ( $bn && ! $cn && $pn ) {
					// Deleted on the server: the deletion wins, and an edit
					// the proposal made to the block parks for review.
					if ( $pn['subtree'] !== $bn['subtree'] ) {
						$park( $id );
					}
					continue;
				}
				if ( $bn && $cn && ! $pn ) {
					// Deleted by the proposal. A deletion beats a
					// concurrent edit on either side (the core's
					// deleted-block-changed rule, resolved per block): the
					// block goes, and the peer's edited form parks so it is
					// reviewable rather than silently lost.
					if ( $cn['subtree'] !== $bn['subtree'] ) {
						$conflicts[ $id ] = array(
							'syncId' => $id,
							'path'   => $cn['path'],
							'html'   => $cn['subtree'],
						);
					}
					continue;
				}
				if ( ! $bn && $cn && ! $pn ) {
					$winner[ $id ] = array( 'from' => 'c' );
					$parent[ $id ] = $cn['parent'];
					continue;
				}
				if ( ! $bn && ! $cn && $pn ) {
					$winner[ $id ] = array( 'from' => 'p' );
					$parent[ $id ] = $pn['parent'];
					continue;
				}
				if ( ! $bn && $cn && $pn ) {
					// The same new block on both sides (a re-sent proposal).
					$winner[ $id ] = array( 'from' => 'c' );
					$parent[ $id ] = $cn['parent'];
					if ( $cn['own'] !== $pn['own'] ) {
						$park( $id );
					}
					continue;
				}
				if ( ! $bn || ! $cn || ! $pn ) {
					continue; // Deleted on both sides.
				}

				// Present everywhere: own-content three-way.
				$server_changed = $cn['own'] !== $bn['own'];
				$local_changed  = $pn['own'] !== $bn['own'];
				if ( ! $local_changed ) {
					$winner[ $id ] = array( 'from' => 'c' );
				} elseif ( ! $server_changed || $cn['own'] === $pn['own'] ) {
					$winner[ $id ] = array( 'from' => $server_changed ? 'c' : 'p' );
				} else {
					$merged = self::merge_leaf( $bn, $cn, $pn );
					if ( null !== $merged ) {
						$winner[ $id ] = array(
							'from' => 'm',
							'html' => $merged,
						);
					} else {
						$winner[ $id ] = array( 'from' => 'c' );
						$park( $id );
					}
				}

				// Placement: a move follows the block; clashing moves keep
				// the canonical placement and park the proposal's form.
				$server_moved = $cn['parent'] !== $bn['parent'];
				$local_moved  = $pn['parent'] !== $bn['parent'];
				if ( $local_moved && $server_moved && $cn['parent'] !== $pn['parent'] ) {
					$parent[ $id ] = $cn['parent'];
					$park( $id );
				} else {
					$parent[ $id ] = $local_moved ? $pn['parent'] : $cn['parent'];
				}
			}

			// A block placed under a parent that did not survive is parked
			// (its subtree has nowhere to go).
			foreach ( $parent as $id => $parent_id ) {
				if ( '' !== $parent_id && ! isset( $winner[ $parent_id ] ) ) {
					$park( $id );
					unset( $winner[ $id ], $parent[ $id ] );
				}
			}

			// Child order per parent.
			$children = array();
			foreach ( $parent as $id => $parent_id ) {
				$children[ $parent_id ][] = $id;
			}
			$order = array();
			foreach ( array_merge( array( '' ), array_keys( $winner ) ) as $parent_id ) {
				$survivors = $children[ $parent_id ] ?? array();
				if ( array() === $survivors ) {
					$order[ $parent_id ] = array();
					continue;
				}
				$merged_order = self::merge_order(
					self::children_of( $c, $parent_id, $survivors ),
					self::children_of( $p, $parent_id, $survivors ),
					$survivors
				);
				if ( null === $merged_order ) {
					if ( '' === $parent_id ) {
						return null; // Root order clash: the positional core decides.
					}
					// Canonical order wins inside this container; the
					// proposal's form of the container parks for review.
					$merged_order = self::children_of( $c, $parent_id, $survivors );
					foreach ( $survivors as $id ) {
						if ( ! in_array( $id, $merged_order, true ) ) {
							$merged_order[] = $id;
						}
					}
					$park( $parent_id );
				}
				$order[ $parent_id ] = $merged_order;
			}

			$built = array();
			foreach ( $order[''] as $id ) {
				$html = self::build( $id, $winner, $order, $b, $c, $p );
				if ( null === $html ) {
					return null;
				}
				$built[] = $html;
			}
			$merged_content = implode( "\n\n", $built );

			$conflict_rows = array();
			foreach ( $conflicts as $conflict ) {
				// Drop parked descendants of a parked ancestor (one row
				// carries the whole subtree).
				$ancestor_parked = false;
				$cursor          = $p['nodes'][ $conflict['syncId'] ]['parent'] ?? '';
				while ( '' !== $cursor ) {
					if ( isset( $conflicts[ $cursor ] ) ) {
						$ancestor_parked = true;
						break;
					}
					$cursor = $p['nodes'][ $cursor ]['parent'] ?? '';
				}
				if ( $ancestor_parked ) {
					continue;
				}
				$conflict['index'] = self::top_level_index( $merged_content, $conflict['syncId'], $conflict['path'] );
				$conflict_rows[]   = $conflict;
			}

			return array(
				'merged_content' => $merged_content,
				'conflicts'      => $conflict_rows,
				'merge_strategy' => 'block_identity_tree_three_way',
			);
		}

		/**
		 * Sequesters a filtered author's kses-risky blocks by identity, at
		 * every depth: a risky block that exists in the base reverts its OWN
		 * form (name and attributes; the proposal's children stay), a risky
		 * new block drops with its subtree, and every risky block is listed
		 * for review. A block is risky when the kses post filter would alter
		 * its own form, unless that form is unchanged from the base or its
		 * exact subtree was previously approved.
		 *
		 * @since 0.0.1
		 *
		 * @param string $base     Base stripped content.
		 * @param string $proposed Proposed stripped content.
		 * @param array  $approved Approved subtree hashes (see the engine's
		 *                         approved-blocks record).
		 * @return array|null array{laundered: string, risky: array} or null
		 *                    to decline (the positional lane applies).
		 */
		public static function sequester( string $base, string $proposed, array $approved = array() ): ?array {
			$b = self::model( wp_de_rtc_canonicalize_post_content_core_block_names( $base ) );
			$p = self::model( wp_de_rtc_canonicalize_post_content_core_block_names( $proposed ) );
			if ( null === $b || null === $p ) {
				return null;
			}
			$winner  = array();
			$dropped = array();
			$risky   = array();
			foreach ( $p['nodes'] as $id => $node ) {
				$ancestor = $node['parent'];
				while ( '' !== $ancestor && ! isset( $dropped[ $ancestor ] ) ) {
					$ancestor = $p['nodes'][ $ancestor ]['parent'];
				}
				if ( '' !== $ancestor ) {
					continue; // Inside a dropped subtree.
				}
				$base_node = $b['nodes'][ $id ] ?? null;
				$own_html  = self::own_html( $node );
				$is_risky  = wp_kses_post( $own_html ) !== $own_html
					&& ! ( $base_node && $base_node['own'] === $node['own'] )
					&& ! isset( $approved[ wp_de_rtc_hash_content( $node['subtree'] ) ] );
				if ( ! $is_risky ) {
					$winner[ $id ] = array( 'from' => 'p' );
					continue;
				}
				$risky[] = array(
					'index'  => (int) $node['path'][0],
					'syncId' => $id,
					'path'   => $node['path'],
					'html'   => $node['subtree'],
				);
				if ( $base_node && $base_node['name'] === $node['name'] ) {
					$winner[ $id ] = array( 'from' => 'b' );
				} else {
					$dropped[ $id ] = true;
				}
			}
			$order = array();
			foreach ( array_merge( array( '' ), array_keys( $winner ) ) as $parent_id ) {
				$list                = '' === $parent_id ? $p['roots'] : $p['nodes'][ $parent_id ]['children'];
				$order[ $parent_id ] = array_values(
					array_filter(
						$list,
						static function ( $child_id ) use ( $winner ) {
							return isset( $winner[ $child_id ] );
						}
					)
				);
			}
			$built = array();
			foreach ( $order[''] as $id ) {
				$html = self::build( $id, $winner, $order, $b, $p, $p );
				if ( null === $html ) {
					return null;
				}
				$built[] = $html;
			}
			return array(
				'laundered' => implode( "\n\n", $built ),
				'risky'     => $risky,
			);
		}

		/**
		 * A block's own serialized form: the block with its children
		 * removed (a leaf is itself).
		 *
		 * @param array $node Model node.
		 * @return string Serialized own form.
		 */
		private static function own_html( array $node ): string {
			if ( $node['layout']['leaf'] ) {
				return $node['subtree'];
			}
			$block                 = $node['block'];
			$block['innerBlocks']  = array();
			$block['innerContent'] = array( $node['layout']['prefix'] . $node['layout']['suffix'] );
			return serialize_block( $block );
		}

		/**
		 * Substitutes one identified block of a base document with that
		 * block's form in another version (the per-block true-base rule of
		 * `blockBaseVersions`, by identity: the block may sit anywhere).
		 *
		 * @since 0.0.1
		 *
		 * @param string $base    Base content to rewrite.
		 * @param string $sync_id The block's identity.
		 * @param string $source  The version holding the block's true base form.
		 * @return string|null The rewritten base, or null when either side
		 *                     lacks the block or cannot be modelled.
		 */
		public static function substitute( string $base, string $sync_id, string $source ): ?string {
			$b = self::model( wp_de_rtc_canonicalize_post_content_core_block_names( $base ) );
			$s = self::model( wp_de_rtc_canonicalize_post_content_core_block_names( $source ) );
			if ( null === $b || null === $s || ! isset( $b['nodes'][ $sync_id ], $s['nodes'][ $sync_id ] ) ) {
				return null;
			}
			$winner = array();
			$order  = array();
			foreach ( $b['nodes'] as $id => $node ) {
				$winner[ $id ] = array( 'from' => 'b' );
				$order[ $id ]  = $node['children'];
			}
			$order['']          = $b['roots'];
			$winner[ $sync_id ] = array(
				'from' => 'm',
				'html' => $s['nodes'][ $sync_id ]['subtree'],
			);
			$order[ $sync_id ]  = array();
			$built              = array();
			foreach ( $order[''] as $id ) {
				$html = self::build( $id, $winner, $order, $b, $b, $b );
				if ( null === $html ) {
					return null;
				}
				$built[] = $html;
			}
			return implode( "\n\n", $built );
		}

		/**
		 * The identity of the top-level block at an index of a document.
		 *
		 * @since 0.0.1
		 *
		 * @param string $content Content.
		 * @param int    $index   Top-level index.
		 * @return string|null The syncId, or null.
		 */
		public static function top_level_id_at( string $content, int $index ): ?string {
			$model = self::model( wp_de_rtc_canonicalize_post_content_core_block_names( $content ) );
			return $model['roots'][ $index ] ?? null;
		}

		/**
		 * Builds the identity model of a document, or null to decline.
		 *
		 * @param string $content Canonicalized content.
		 * @return array|null array{nodes: array<string, array>, roots: string[]}.
		 */
		private static function model( string $content ): ?array {
			$blocks    = parse_blocks( $content );
			$roundtrip = '';
			$roots     = array();
			foreach ( $blocks as $block ) {
				$roundtrip .= serialize_block( $block );
				if ( empty( $block['blockName'] ) ) {
					if ( '' !== trim( (string) $block['innerHTML'] ) ) {
						return null; // Classic content between blocks.
					}
					continue;
				}
				$roots[] = $block;
			}
			if ( $roundtrip !== $content ) {
				return null;
			}
			$nodes    = array();
			$root_ids = array();
			foreach ( $roots as $index => $block ) {
				$id = self::index_node( $block, '', array( $index ), $nodes );
				if ( null === $id ) {
					return null;
				}
				$root_ids[] = $id;
			}
			return array(
				'nodes' => $nodes,
				'roots' => $root_ids,
			);
		}

		/**
		 * Indexes one parsed block (and its subtree) into the node map.
		 *
		 * @param array  $block  Parsed block.
		 * @param string $parent_id Parent id ('' at the root).
		 * @param int[]  $path   Path from the root.
		 * @param array  $nodes  Node map (by reference).
		 * @return string|null The block's id, or null to decline.
		 */
		private static function index_node( array $block, string $parent_id, array $path, array &$nodes ): ?string {
			$attrs = is_array( $block['attrs'] ?? null ) ? $block['attrs'] : array();
			$id    = $attrs['metadata']['syncId'] ?? null;
			if ( ! is_string( $id ) || '' === $id || isset( $nodes[ $id ] ) ) {
				return null; // No identity, or a duplicated one.
			}
			$layout = self::layout( $block );
			if ( null === $layout ) {
				return null;
			}
			$children = array();
			foreach ( $block['innerBlocks'] as $index => $child ) {
				$child_id = self::index_node( $child, $id, array_merge( $path, array( $index ) ), $nodes );
				if ( null === $child_id ) {
					return null;
				}
				$children[] = $child_id;
			}
			$nodes[ $id ] = array(
				'name'     => (string) $block['blockName'],
				'block'    => $block,
				'parent'   => $parent_id,
				'path'     => $path,
				'children' => $children,
				'layout'   => $layout,
				'own'      => wp_json_encode( array( $block['blockName'], $attrs, $layout ) ),
				'subtree'  => serialize_block( $block ),
			);
			return $id;
		}

		/**
		 * A block's own inner layout, separated from its children: for a
		 * leaf its inner HTML; for a container the prefix before the first
		 * child, the separator between children, and the suffix after the
		 * last — the shape the editor's serializer always produces. Null for
		 * an irregular container (text between children that is not one
		 * repeated separator).
		 *
		 * @param array $block Parsed block.
		 * @return array|null Layout.
		 */
		private static function layout( array $block ): ?array {
			$inner = is_array( $block['innerContent'] ?? null ) ? $block['innerContent'] : array();
			if ( array() === $block['innerBlocks'] ) {
				return array(
					'leaf' => true,
					'html' => implode( '', array_filter( $inner, 'is_string' ) ),
				);
			}
			$prefix    = '';
			$suffix    = '';
			$separator = null;
			$seen_null = 0;
			$chunk     = '';
			foreach ( $inner as $piece ) {
				if ( is_string( $piece ) ) {
					$chunk .= $piece;
					continue;
				}
				if ( 0 === $seen_null ) {
					$prefix = $chunk;
				} elseif ( null === $separator ) {
					$separator = $chunk;
				} elseif ( $chunk !== $separator ) {
					return null;
				}
				$chunk = '';
				++$seen_null;
			}
			$suffix = $chunk;
			if ( count( $block['innerBlocks'] ) !== $seen_null ) {
				return null;
			}
			return array(
				'leaf'      => false,
				'prefix'    => $prefix,
				'separator' => null === $separator ? "\n\n" : $separator,
				'suffix'    => $suffix,
			);
		}

		/**
		 * Attempts the core's single-block merge for a both-changed leaf.
		 *
		 * @param array $bn Base node.
		 * @param array $cn Current node.
		 * @param array $pn Proposed node.
		 * @return string|null Merged serialized block, or null on conflict.
		 */
		private static function merge_leaf( array $bn, array $cn, array $pn ): ?string {
			if ( ! $bn['layout']['leaf'] || ! $cn['layout']['leaf'] || ! $pn['layout']['leaf'] ) {
				return null;
			}
			$result = wp_de_rtc_get_automerge_retry_save_result( $bn['subtree'], $cn['subtree'], $pn['subtree'], null );
			if ( is_wp_error( $result ) || ! is_string( $result['merged_content'] ?? null ) ) {
				return null;
			}
			$parsed = parse_blocks( $result['merged_content'] );
			$named  = array_values(
				array_filter(
					$parsed,
					static function ( $block ) {
						return ! empty( $block['blockName'] );
					}
				)
			);
			if ( 1 !== count( $named ) || ( $named[0]['attrs']['metadata']['syncId'] ?? null ) !== ( $bn['block']['attrs']['metadata']['syncId'] ?? null ) ) {
				return null;
			}
			return serialize_block( $named[0] );
		}

		/**
		 * A parent's child ids in one document, restricted to survivors.
		 *
		 * @param array    $model     Document model.
		 * @param string   $parent_id Parent id ('' for the root).
		 * @param string[] $survivors Surviving ids under this parent.
		 * @return string[] Ordered ids.
		 */
		private static function children_of( array $model, string $parent_id, array $survivors ): array {
			$list = '' === $parent_id ? $model['roots'] : ( $model['nodes'][ $parent_id ]['children'] ?? array() );
			return array_values( array_intersect( $list, $survivors ) );
		}

		/**
		 * Merges two orderings of one parent's children: the canonical
		 * order carries, the proposal's newcomers land after the sibling
		 * they followed. Null when the two sides order their common
		 * blocks differently.
		 *
		 * @param string[] $current   Canonical order (survivors only).
		 * @param string[] $proposed  Proposed order (survivors only).
		 * @param string[] $survivors Every surviving id under this parent.
		 * @return string[]|null Merged order.
		 */
		private static function merge_order( array $current, array $proposed, array $survivors ): ?array {
			$common_c = array_values( array_intersect( $current, $proposed ) );
			$common_p = array_values( array_intersect( $proposed, $current ) );
			if ( $common_c !== $common_p ) {
				return null;
			}
			$merged = $current;
			foreach ( $proposed as $position => $id ) {
				if ( in_array( $id, $merged, true ) ) {
					continue;
				}
				// Anchor: the nearest preceding sibling in the proposal
				// that made it into the merged list.
				$insert_at = 0;
				for ( $back = $position - 1; $back >= 0; $back-- ) {
					$anchor_at = array_search( $proposed[ $back ], $merged, true );
					if ( false !== $anchor_at ) {
						$insert_at = $anchor_at + 1;
						break;
					}
				}
				array_splice( $merged, $insert_at, 0, array( $id ) );
			}
			foreach ( $survivors as $id ) {
				if ( ! in_array( $id, $merged, true ) ) {
					$merged[] = $id;
				}
			}
			return $merged;
		}

		/**
		 * Serializes one merged block and its subtree.
		 *
		 * @param string $id     Block id.
		 * @param array  $winner Winner map.
		 * @param array  $order  Child order map.
		 * @param array  $b      Base model.
		 * @param array  $c      Current model.
		 * @param array  $p      Proposed model.
		 * @return string|null Serialized block, or null to decline.
		 */
		private static function build( string $id, array $winner, array $order, array $b, array $c, array $p ): ?string {
			$choice = $winner[ $id ] ?? null;
			if ( null === $choice ) {
				return null;
			}
			$children = $order[ $id ] ?? array();
			if ( 'm' === $choice['from'] ) {
				return $choice['html']; // A leaf merge: no children by construction.
			}
			$models = array(
				'b' => $b,
				'c' => $c,
				'p' => $p,
			);
			$node   = $models[ $choice['from'] ]['nodes'][ $id ] ?? null;
			if ( null === $node ) {
				return null;
			}
			$block  = $node['block'];
			$layout = $node['layout'];
			if ( array() === $children ) {
				if ( $layout['leaf'] ) {
					return $node['subtree'];
				}
				$block['innerBlocks']  = array();
				$block['innerContent'] = array( $layout['prefix'] . $layout['suffix'] );
				return serialize_block( $block );
			}
			if ( $layout['leaf'] ) {
				return null; // Children moved into a block that has no place for them.
			}
			$inner_blocks  = array();
			$inner_content = array( $layout['prefix'] );
			foreach ( $children as $position => $child_id ) {
				$child_html = self::build( $child_id, $winner, $order, $b, $c, $p );
				if ( null === $child_html ) {
					return null;
				}
				$parsed = parse_blocks( $child_html );
				$named  = null;
				foreach ( $parsed as $candidate ) {
					if ( ! empty( $candidate['blockName'] ) ) {
						$named = $candidate;
						break;
					}
				}
				if ( null === $named ) {
					return null;
				}
				if ( $position > 0 ) {
					$inner_content[] = $layout['separator'];
				}
				$inner_content[] = null;
				$inner_blocks[]  = $named;
			}
			$inner_content[]       = $layout['suffix'];
			$block['innerBlocks']  = $inner_blocks;
			$block['innerContent'] = $inner_content;
			return serialize_block( $block );
		}

		/**
		 * The top-level index a parked block falls under in the merged
		 * document (its top-level ancestor's position; a hint for clients
		 * that still address blocks positionally).
		 *
		 * @param string $merged  Merged content.
		 * @param string $sync_id Parked block id.
		 * @param int[]  $path    The block's path in the proposal.
		 * @return int Top-level index.
		 */
		private static function top_level_index( string $merged, string $sync_id, array $path ): int {
			$model = self::model( $merged );
			if ( null !== $model ) {
				$cursor = $sync_id;
				while ( isset( $model['nodes'][ $cursor ] ) ) {
					$node = $model['nodes'][ $cursor ];
					if ( '' === $node['parent'] ) {
						return (int) $node['path'][0];
					}
					$cursor = $node['parent'];
				}
			}
			return (int) ( $path[0] ?? 0 );
		}
	}
}
