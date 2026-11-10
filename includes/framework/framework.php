<?php
/**
 * The collaboration framework's server-side glue, carried by this plugin.
 *
 * Gutenberg (and WordPress core, once merged) keeps only the bare contract
 * this plugin needs: `wp_is_collaboration_enabled()` and its filter, the
 * post-type gate, the post-lock interplay, meta-box compat and the
 * autosaves controller. Everything else the engines and transports rely
 * on lives here: the sync-storage post type, the persisted-document post
 * meta, the storage factory, the single transport config value, the REST
 * route registration and the client announcement.
 *
 * Every declaration is guarded so an older Gutenberg that still ships these
 * pieces wins: it loads before this plugin boots (the plugin entry requires
 * the bundled copy, and a standalone Gutenberg sorts after this plugin in
 * the active-plugins list, both ahead of `plugins_loaded`). The hook
 * registrations are NOT in this file: `Gutenberg_Sync_Engines_Plugin`
 * adds them only when it supplied the framework itself (see
 * `register_framework_hooks()`), so a host that already registers the
 * post type, the meta, the routes and the announcement is not doubled.
 *
 * @package GutenbergSyncEngines
 */

if ( ! function_exists( 'wp_get_collaboration_transport' ) ) {
	/**
	 * The single config value that selects the active collaboration
	 * transport. One source of truth: the `WP_COLLABORATION_TRANSPORT`
	 * constant, else the environment variable of the same name, else the
	 * `wp_collaboration_transport` filter, defaulting to HTTP polling. The
	 * value must be a registered transport slug; an unknown value falls back
	 * to the default in the registry.
	 *
	 * @since 7.2.0
	 *
	 * @return string Configured transport slug.
	 */
	function wp_get_collaboration_transport(): string { // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedFunctionFound -- Framework name: the transport registry and an older Gutenberg both call it by this name.
		// Conventional default; only takes effect if a plugin registered a
		// transport by this slug.
		$transport = 'http-polling';
		if ( defined( 'WP_COLLABORATION_TRANSPORT' ) && is_string( WP_COLLABORATION_TRANSPORT ) && '' !== WP_COLLABORATION_TRANSPORT ) {
			$transport = WP_COLLABORATION_TRANSPORT;
		} else {
			$from_env = getenv( 'WP_COLLABORATION_TRANSPORT' );
			if ( is_string( $from_env ) && '' !== $from_env ) {
				$transport = $from_env;
			}
		}

		/**
		 * Filters the active collaboration transport slug.
		 *
		 * @since 7.2.0
		 *
		 * @param string $transport Transport slug.
		 */
		return (string) apply_filters( 'wp_collaboration_transport', $transport ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Framework hook name, kept so existing site configuration keeps working.
	}
}

if ( ! function_exists( 'wp_get_sync_storage' ) ) {
	/**
	 * The room/update storage the collaboration stack reads and writes.
	 *
	 * Filterable so a plugin can substitute a different backend (an object
	 * cache, Redis, a dedicated table, an external service) by returning
	 * its own WP_Sync_Storage implementation. All framework and
	 * engine-plugin access should obtain storage here rather than
	 * instantiating WP_Sync_Post_Meta_Storage directly, so a substitution
	 * applies everywhere at once. A substitute must uphold the storage
	 * contract documented on the WP_Sync_Storage interface: per-room
	 * cursors that only ever grow (and survive trims), a write
	 * acknowledged to one request visible to the next on any server, and
	 * a write-once engine lineage stamp.
	 *
	 * Built fresh per call, like the registries: the default storage keeps
	 * per-request in-memory caches that must not outlive a request.
	 *
	 * @since 7.4.0
	 *
	 * @return WP_Sync_Storage Storage implementation.
	 */
	function wp_get_sync_storage(): WP_Sync_Storage { // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedFunctionFound -- Framework name: the engines, the tools and an older Gutenberg all call it by this name.
		/**
		 * Filters the sync storage implementation for collaborative editing.
		 *
		 * Allows plugins to replace the default post meta storage with
		 * alternative backends. This plugin substitutes its own table storage
		 * here (`Gutenberg_Sync_Engines_Plugin::filter_sync_storage()`).
		 *
		 * The name is kept from the framework so a site's existing storage
		 * substitution keeps working.
		 *
		 * @since Gutenberg 21.x
		 *
		 * @param WP_Sync_Storage $sync_storage Storage implementation. Must implement
		 *                                      the WP_Sync_Storage interface.
		 */
		$storage = apply_filters( '__unstable_wp_sync_storage', new WP_Sync_Post_Meta_Storage() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Framework hook name, kept so existing storage substitutions keep working.

		if ( ! $storage instanceof WP_Sync_Storage ) {
			$storage = new WP_Sync_Post_Meta_Storage();
		}

		return $storage;
	}
}

if ( ! function_exists( 'wp_get_collaboration_transport_registry' ) ) {
	/**
	 * Builds a transport registry over the default storage and engine
	 * registry. Built fresh per call: the storage keeps per-request in-memory
	 * caches (room cursors, storage post ids) that must not outlive a
	 * request, so this is never memoized.
	 *
	 * @since 7.2.0
	 *
	 * @return WP_Sync_Transport_Registry Transport registry.
	 */
	function wp_get_collaboration_transport_registry(): WP_Sync_Transport_Registry { // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedFunctionFound -- Framework name: the transports and an older Gutenberg both call it by this name.
		$storage = wp_get_sync_storage();
		$engines = new WP_Sync_Engine_Registry( $storage );
		return new WP_Sync_Transport_Registry( $storage, $engines );
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_register_sync_storage_post_type' ) ) {
	/**
	 * Registers the hidden post type the default (post-meta) storage keeps
	 * each room's updates on.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_register_sync_storage_post_type(): void {
		if ( ! wp_is_collaboration_enabled() ) {
			return;
		}

		register_post_type(
			'wp_sync_storage', // phpcs:ignore WordPress.NamingConventions.ValidPostTypeSlug.ReservedPrefix -- The framework's post type name; rooms stored under it by an older Gutenberg must stay readable.
			array(
				'labels'             => array(
					'name'          => __( 'Sync Updates', 'gutenberg-sync-engines' ),
					'singular_name' => __( 'Sync Update', 'gutenberg-sync-engines' ),
				),
				'public'             => false,
				'hierarchical'       => false,
				'capabilities'       => array(
					'read'                   => 'do_not_allow',
					'read_private_posts'     => 'do_not_allow',
					'create_posts'           => 'do_not_allow',
					'publish_posts'          => 'do_not_allow',
					'edit_posts'             => 'do_not_allow',
					'edit_others_posts'      => 'do_not_allow',
					'edit_published_posts'   => 'do_not_allow',
					'delete_posts'           => 'do_not_allow',
					'delete_others_posts'    => 'do_not_allow',
					'delete_published_posts' => 'do_not_allow',
				),
				'map_meta_cap'       => false,
				'publicly_queryable' => false,
				'query_var'          => false,
				'rewrite'            => false,
				'show_in_menu'       => false,
				'show_in_rest'       => false,
				'show_ui'            => false,
				'supports'           => array( 'custom-fields' ),
			)
		);
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_register_crdt_post_meta' ) ) {
	/**
	 * Registers the post meta the persisted shared document is saved in.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_register_crdt_post_meta(): void {
		if ( ! wp_is_collaboration_enabled() ) {
			return;
		}

		register_meta(
			'post',
			WP_Sync_Save_Server::CRDT_DOC_META_KEY,
			array(
				'auth_callback'     => static function ( bool $_allowed, string $_meta_key, int $object_id, int $user_id ): bool {
					return user_can( $user_id, 'edit_post', $object_id );
				},

				/*
				 * Revisions must be disabled because we always want to preserve
				 * the latest persisted CRDT document, even when a revision is
				 * restored. This ensures that we can continue to apply updates
				 * to a shared document and peers can simply merge the restored
				 * revision like any other incoming update.
				 *
				 * If we want to persist CRDT documents alongside revisions in
				 * the future, we should do so in a separate meta key.
				 */
				'revisions_enabled' => false,
				'show_in_rest'      => array(
					'schema' => array(
						'type'    => 'string',
						'context' => array( 'edit' ),
					),
				),
				'single'            => true,
				'type'              => 'string',
			)
		);
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_register_collaboration_rest_routes' ) ) {
	/**
	 * Registers every transport's REST routes and the shared-document save
	 * route.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_register_collaboration_rest_routes(): void {
		if ( ! wp_is_collaboration_enabled() ) {
			return;
		}

		// Every registered transport's routes are reachable; the client uses
		// the one the server announces as active.
		wp_get_collaboration_transport_registry()->register_all_routes();

		$sync_save_server = new WP_Sync_Save_Server();
		$sync_save_server->register_routes();
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_inject_collaboration_announcement' ) ) {
	/**
	 * Tells the editor which engine and transports the server runs, after
	 * `wp-core-data` so the client reads it before this plugin's bundle
	 * starts.
	 *
	 * The client refuses to join sync rooms whose engine (or protocol
	 * version) its adapter registry cannot provide, or when no announced
	 * transport is supported, and degrades to the classic exclusive post
	 * lock instead of corrupting a session. Per-room engine overrides
	 * (`wp_sync_engine_for_room`) are enforced server-side by the 409
	 * mismatch check; this announcement covers the site default.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_inject_collaboration_announcement(): void {
		if ( ! wp_is_collaboration_enabled() ) {
			return;
		}

		$registry           = new WP_Sync_Engine_Registry( wp_get_sync_storage() );
		$engine             = $registry->get_engine_for_room( '' );
		$transport_registry = wp_get_collaboration_transport_registry();
		$active_transport   = $transport_registry->get_transport( $transport_registry->get_active_slug() );
		$sync               = array(
			'engine'            => $engine ? $engine->get_slug() : '',
			'engineProtocol'    => $engine ? $engine->get_protocol_version() : 0,
			// Announced active FIRST; the client picks the first slug it can
			// provide (see the single config value `wp_get_collaboration_transport`).
			'transports'        => $transport_registry->get_announced_slugs(),
			'transportProtocol' => $active_transport ? $active_transport->get_protocol_version() : 1,
		);

		/**
		 * Filters the transport-specific client configuration the editor
		 * receives, keyed by transport slug (e.g. a WebSocket socket URL),
		 * so the announcement itself carries no transport-specific
		 * knowledge.
		 *
		 * @since 7.2.0
		 *
		 * @param array    $config     Client config keyed by transport slug.
		 * @param string[] $transports Announced transport slugs.
		 */
		$transport_config = apply_filters( 'wp_sync_transport_client_config', array(), $sync['transports'] );

		wp_add_inline_script(
			'wp-core-data',
			'window._wpCollaborationSync = ' . wp_json_encode( $sync ) . ';' .
			// Informational half of the intent-log actor id; the server stamps
			// the authoritative value from the authenticated request.
			'window._wpCollaborationUserId = ' . wp_json_encode( get_current_user_id() ) . ';' .
			'window._wpCollaborationTransportConfig = ' . wp_json_encode( (object) $transport_config ) . ';' .
			// UI hint only: restore/approval is enforced at ingest per the
			// authoring user's capability regardless of what the client shows.
			'window._wpCollaborationCanUnfilteredHtml = ' . wp_json_encode( current_user_can( 'unfiltered_html' ) ) . ';',
			'after'
		);
	}
}
