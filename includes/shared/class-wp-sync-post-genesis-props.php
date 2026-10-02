<?php
/**
 * WP_Sync_Post_Genesis_Props class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Sync_Post_Genesis_Props' ) ) {

	/**
	 * Entity property values seeded into a post room's genesis, shared by
	 * every engine that seeds fields.
	 *
	 * Mirrors the scalar subset of the framework's synced-property contract
	 * with values in REST shape, gated on the same post-type supports the
	 * REST schema uses. The gating matters: a property seeded here that the
	 * client's REST record lacks would push a spurious edit (and mark the
	 * post dirty) the moment a client joins. Reads only the post row and its
	 * derived state, so racing initializers build identical documents.
	 *
	 * Extracted verbatim from the intent-log engine's genesis so yjs-server
	 * and de-rtc genesis seed the identical property set — field parity
	 * starts at the seed.
	 *
	 * @since 0.4.0
	 */
	class WP_Sync_Post_Genesis_Props {

		/**
		 * Builds the property name => REST-shaped value map for a post.
		 *
		 * Includes the scalar whitelist (gated on post-type supports),
		 * attached show_in_rest taxonomies keyed by rest_base as
		 * numerically-sorted term-ID arrays, and registered post meta as
		 * `meta.<key>` entries serialized by WP_REST_Post_Meta_Fields
		 * (excluding the persisted-CRDT transport key).
		 *
		 * @since 0.4.0
		 *
		 * @param WP_Post $post The room's post.
		 * @return array Property name => raw scalar value.
		 */
		public static function for_post( WP_Post $post ): array {
			$props = array();

			if ( post_type_supports( $post->post_type, 'title' ) ) {
				$title = $post->post_title;

				/*
				 * A fresh auto-draft stores the placeholder "Auto Draft"
				 * title while the editor shows an empty field; seeding the
				 * placeholder would push it to every client as a title
				 * change.
				 */
				if (
					'auto-draft' === $post->post_status
					&& ( 'Auto Draft' === $title || __( 'Auto Draft', 'default' ) === $title )
				) {
					$title = '';
				}
				$props['title'] = $title;
			}
			if ( post_type_supports( $post->post_type, 'excerpt' ) ) {
				$props['excerpt'] = $post->post_excerpt;
			}
			if ( post_type_supports( $post->post_type, 'author' ) ) {
				$props['author'] = (int) $post->post_author;
			}
			if ( post_type_supports( $post->post_type, 'thumbnail' ) ) {
				$props['featured_media'] = (int) get_post_thumbnail_id( $post->ID );
			}
			if ( post_type_supports( $post->post_type, 'comments' ) ) {
				$props['comment_status'] = $post->comment_status;
				$props['ping_status']    = $post->ping_status;
			}
			if ( post_type_supports( $post->post_type, 'post-formats' ) ) {
				$format          = get_post_format( $post->ID );
				$props['format'] = $format ? $format : 'standard';
			}
			// The REST schema exposes `sticky` for the built-in post type only.
			if ( 'post' === $post->post_type ) {
				$props['sticky'] = is_sticky( $post->ID );
			}
			// An auto-draft status is invalid in the editor and never syncs.
			if ( 'auto-draft' !== $post->post_status ) {
				$props['status'] = $post->post_status;
			}
			// An empty slug means the auto-generated default and never syncs.
			if ( '' !== $post->post_name ) {
				$props['slug'] = $post->post_name;
			}

			/*
			 * A zeroed date_gmt is a "floating" (publish immediately) date;
			 * the REST record serves null for it, so seed only real dates,
			 * in the REST record's RFC3339 shape.
			 */
			if ( '0000-00-00 00:00:00' !== $post->post_date_gmt ) {
				$props['date'] = mysql_to_rfc3339( $post->post_date );
			}
			$props['template'] = (string) get_page_template_slug( $post->ID );

			/*
			 * Attached taxonomies, keyed by rest_base like the REST record
			 * (show_in_rest taxonomies only; rest_base falls back to the
			 * taxonomy name): whole term-ID arrays as registers, in
			 * CANONICAL numeric order. Term bindings are sets — the editor
			 * appends IDs in click order while REST serializes name order —
			 * so both the client and genesis normalize to one order and
			 * compare order-insensitively; without that, the same set read
			 * as a change and escalated spurious property conflicts.
			 */
			$taxonomies = get_object_taxonomies( $post->post_type, 'objects' );
			foreach ( $taxonomies as $taxonomy ) {
				if ( empty( $taxonomy->show_in_rest ) ) {
					continue;
				}
				$base     = ! empty( $taxonomy->rest_base ) ? $taxonomy->rest_base : $taxonomy->name;
				$terms    = get_the_terms( $post->ID, $taxonomy->name );
				$term_ids = is_array( $terms )
					? array_map( 'intval', array_values( wp_list_pluck( $terms, 'term_id' ) ) )
					: array();
				sort( $term_ids, SORT_NUMERIC );
				$props[ $base ] = $term_ids;
			}

			/*
			 * Registered post meta as per-key registers (`meta.<key>`),
			 * serialized by the SAME code path the REST record's `meta`
			 * object uses (WP_REST_Post_Meta_Fields) so a joining client's
			 * echo suppression sees byte-identical values — defaults,
			 * single/multiple shapes, and prepare callbacks included. The
			 * persisted-CRDT snapshot key is transport state and never
			 * syncs (framework parity: disallowedPostMetaKeys).
			 */
			if ( class_exists( 'WP_REST_Post_Meta_Fields' ) ) {
				$meta_fields = new WP_REST_Post_Meta_Fields( $post->post_type );
				$meta_values = $meta_fields->get_value( $post->ID, new WP_REST_Request() );
				foreach ( (array) $meta_values as $meta_key => $meta_value ) {
					if ( '_crdt_document' === $meta_key ) {
						continue;
					}
					$props[ 'meta.' . $meta_key ] = $meta_value;
				}
			}

			return $props;
		}
	}
}
