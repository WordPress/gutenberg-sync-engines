<?php
/**
 * Gutenberg_Sync_Engines_Plugin class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Plugin' ) ) {

	/**
	 * Plugin bootstrap: loads and registers the sync engines and transports
	 * this plugin provides, and the admin settings screen for selecting them.
	 *
	 * Gutenberg (WordPress core) keeps only a bare contract: the
	 * `wp_is_collaboration_enabled()` gate and its filter, the post-type
	 * gate, the post-lock interplay, meta-box compat, the autosaves
	 * controller, and on the client the private `registerEntitySyncProvider`
	 * seam in core-data. The collaborative-editing FRAMEWORK that used to
	 * live beside it — the WP_Sync_Engine / WP_Sync_Transport /
	 * WP_Sync_Storage contracts, the two registries, room config, the
	 * default storage, the save route and the client announcement — ships
	 * in this plugin (`includes/framework/`), guarded so an older Gutenberg
	 * that still carries it wins. The engines and transports register
	 * through the framework's filters (`wp_sync_engines`,
	 * `wp_sync_transports`). With this plugin inactive nothing registers a
	 * provider, so real-time collaboration degrades to the classic post
	 * lock — effectively disabled.
	 *
	 * @since 0.1.0
	 */
	final class Gutenberg_Sync_Engines_Plugin {
		/**
		 * Singleton instance.
		 *
		 * @since 0.1.0
		 * @var Gutenberg_Sync_Engines_Plugin|null
		 */
		private static ?Gutenberg_Sync_Engines_Plugin $instance = null;

		/**
		 * Whether the collaborative-editing framework is present.
		 *
		 * @since 0.1.0
		 * @var bool
		 */
		private bool $framework_available = false;

		/**
		 * Whether the host (an older Gutenberg) declared the framework
		 * before this plugin booted. When it did, the host also registers
		 * the sync-storage post type, the document meta, the REST routes
		 * and the client announcement, so this plugin must not.
		 *
		 * @since n.e.x.t
		 * @var bool
		 */
		private bool $host_provides_framework = false;

		/**
		 * Returns the singleton instance.
		 *
		 * @since 0.1.0
		 *
		 * @return Gutenberg_Sync_Engines_Plugin Instance.
		 */
		public static function instance(): Gutenberg_Sync_Engines_Plugin {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}

		/**
		 * Private constructor (use instance()).
		 *
		 * @since 0.1.0
		 */
		private function __construct() {}

		/**
		 * Boots the plugin: feature-detects the framework, then loads and
		 * registers implementations. A missing framework is not an error —
		 * the plugin simply stays dormant and surfaces an admin notice.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function boot(): void {
			/*
			 * The storage tables come first and do not depend on the
			 * framework: a plugin update that ships a newer schema upgrades
			 * here (activation hooks do not fire on updates), and the
			 * lifecycle CLI (`wp collaboration storage …`) must work on a
			 * site whose framework is missing. A site that cannot create
			 * the tables keeps working on the framework's post-meta storage
			 * (see filter_sync_storage()) and is told so.
			 */
			if ( ! WP_Sync_Table_Schema::maybe_upgrade() ) {
				add_action( 'admin_notices', array( $this, 'render_storage_unavailable_notice' ) );
			}
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/storage/class-wp-sync-table-storage-cli-command.php';
			}

			/*
			 * An older Gutenberg declares the framework contracts at its own
			 * load, ahead of `plugins_loaded`; a newer one (and WordPress
			 * core) does not, and the copies under includes/framework/ fill
			 * the gap. Remember which happened: it decides who registers
			 * the framework's hooks.
			 */
			$this->host_provides_framework = interface_exists( 'WP_Sync_Engine' )
				&& interface_exists( 'WP_Sync_Transport' )
				&& interface_exists( 'WP_Sync_Storage' );
			$this->load_framework();

			// The collaboration gate is the one PHP function this plugin
			// needs from Gutenberg / WordPress core.
			$this->framework_available = function_exists( 'wp_is_collaboration_enabled' );

			if ( ! $this->framework_available ) {
				add_action( 'admin_notices', array( $this, 'render_missing_framework_notice' ) );
				return;
			}

			$this->load();
			$this->register();
		}

		/**
		 * Requires the framework contracts, registries, config, default
		 * storage, save route and glue functions. Every file guards its own
		 * declaration, so a host that already declared a piece keeps its
		 * copy.
		 *
		 * @since n.e.x.t
		 *
		 * @return void
		 */
		private function load_framework(): void {
			$framework = GUTENBERG_SYNC_ENGINES_PATH . 'includes/framework/';
			require_once $framework . 'interface-wp-sync-storage.php';
			require_once $framework . 'class-wp-sync-post-meta-storage.php';
			require_once $framework . 'interface-wp-sync-engine.php';
			require_once $framework . 'class-wp-sync-engine-registry.php';
			require_once $framework . 'interface-wp-sync-transport.php';
			require_once $framework . 'class-wp-sync-transport-registry.php';
			require_once $framework . 'class-wp-sync-config.php';
			require_once $framework . 'class-wp-sync-save-server.php';
			require_once $framework . 'framework.php';
		}

		/**
		 * Requires the plugin's PHP classes.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		private function load(): void {
			// Room storage over the plugin's own tables (the schema class is
			// loaded by the plugin entry, ahead of activation).
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/storage/class-wp-sync-table-storage.php';

			// Shared concurrency primitives (Core-style lock + optimistic
			// CAS), each with a filterable drop-in backend seam.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-lock-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-cas-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-room-lock.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-atomic-option.php';

			// Awareness and the tab list, behind the same kind of drop-in seam as the lock.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-awareness-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-awareness.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-presence-api-awareness-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-tab-list-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-presence-api-tab-list-backend.php';

			// Code the base provides to more than one engine.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/class-wp-sync-block-identity.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/class-wp-sync-post-genesis-props.php';

			$engines = GUTENBERG_SYNC_ENGINES_PATH . 'includes/engines/';
			require_once $engines . 'intent-log/class-wp-intent-log-document.php';
			require_once $engines . 'intent-log/class-wp-intent-log-planner.php';
			require_once $engines . 'intent-log/class-wp-intent-log-rich-text.php';
			require_once $engines . 'intent-log/class-wp-intent-log-engine.php';
			require_once $engines . 'intent-log/class-wp-intent-log-base-seq-preflight.php';
			require_once $engines . 'yjs-server/class-wp-yjs-server-engine.php';

			$transports = GUTENBERG_SYNC_ENGINES_PATH . 'includes/transports/';
			require_once $transports . 'class-wp-sync-connection.php';
			require_once $transports . 'class-wp-http-polling-sync-server.php';
			require_once $transports . 'sse/interface-wp-sync-change-waiter.php';
			require_once $transports . 'sse/class-wp-sync-storage-change-waiter.php';
			require_once $transports . 'sse/class-wp-sync-redis.php';
			require_once $transports . 'sse/class-wp-sync-redis-notifications.php';
			require_once $transports . 'sse/class-wp-sync-sse-server.php';
			require_once $transports . 'sse/class-wp-sync-sse-connection.php';
			require_once $transports . 'sse/class-wp-sync-sse-daemon-transport.php';
			WP_Sync_Redis_Notifications::register();
			require_once $transports . 'websocket/class-wp-websocket-access-token.php';
			require_once $transports . 'websocket/class-wp-websocket-token-controller.php';
			require_once $transports . 'websocket/class-wp-websocket-connection.php';
			require_once $transports . 'websocket/class-wp-websocket-sync-server.php';
			require_once $transports . 'websocket/class-wp-websocket-sync-transport.php';
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				require_once $transports . 'websocket/class-wp-sync-server-cli-command.php';
			}
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-gutenberg-sync-engines-advisory-presence.php';

			/*
			 * Diagnostics are development tools, deliberately kept OUT of the
			 * production path: these files only load on local/development
			 * sites (wp-env reports 'local'), or when a site opts in
			 * explicitly by defining the GUTENBERG_SYNC_ENGINES_DIAGNOSTICS
			 * constant. The room CLI is WP-CLI-only; session capture and the
			 * per-request benchmark log hook web requests too (both are
			 * no-ops until a capture session is started / a request carries
			 * the X-RTC-Test tag).
			 */
			$diagnostics_allowed = in_array( wp_get_environment_type(), array( 'local', 'development' ), true )
				|| ( defined( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS' ) && GUTENBERG_SYNC_ENGINES_DIAGNOSTICS );
			if ( $diagnostics_allowed ) {
				$diagnostics = GUTENBERG_SYNC_ENGINES_PATH . 'includes/diagnostics/';
				require_once $diagnostics . 'class-gutenberg-sync-engines-request-log.php';
				require_once $diagnostics . 'class-gutenberg-sync-engines-session-capture.php';
				( new Gutenberg_Sync_Engines_Request_Log() )->register();
				( new Gutenberg_Sync_Engines_Session_Capture() )->register();
				if ( defined( 'WP_CLI' ) && WP_CLI ) {
					require_once $diagnostics . 'class-gutenberg-sync-engines-rooms-cli-command.php';
					require_once $diagnostics . 'class-gutenberg-sync-engines-capture-cli-command.php';
					require_once $diagnostics . 'class-gutenberg-sync-engines-bench-log-cli-command.php';
				}
			}

			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/admin/class-gutenberg-sync-engines-settings.php';
		}

		/**
		 * Registers engines and transports through the framework's filters,
		 * and wires the admin settings screen.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		private function register(): void {
			/*
			 * A site that runs this plugin wants collaboration: force the
			 * gate on (a newer Gutenberg filters it; an older one, which
			 * reads the experiment directly, is covered by the
			 * activation-time experiment flip in the plugin entry).
			 */
			add_filter( 'wp_is_collaboration_enabled', '__return_true' );

			if ( ! $this->host_provides_framework ) {
				$this->register_framework_hooks();
			}

			add_filter( '__unstable_wp_sync_storage', array( $this, 'filter_sync_storage' ) );
			add_filter( 'wp_sync_awareness_backend', array( $this, 'filter_awareness_backend' ) );
			add_filter( 'wp_sync_tab_list_backend', array( $this, 'filter_tab_list_backend' ) );
			add_filter( 'wp_sync_engines', array( $this, 'register_engines' ), 10, 2 );
			WP_Intent_Log_Base_Seq_Preflight::register();
			add_filter( 'wp_sync_transports', array( $this, 'register_transports' ), 10, 3 );
			add_filter( 'wp_sync_transport_client_config', array( $this, 'filter_transport_client_config' ), 10, 2 );
			add_action( 'enqueue_block_editor_assets', array( $this, 'enqueue_editor_assets' ) );
			( new Gutenberg_Sync_Engines_Advisory_Presence() )->register();

			( new Gutenberg_Sync_Engines_Settings() )->register();
		}

		/**
		 * Registers the framework's own hooks (`includes/framework/framework.php`)
		 * when this plugin supplied the framework: the sync-storage post
		 * type and the document meta on `init`, the transport and save
		 * routes on `rest_api_init`, and the engine/transport announcement
		 * on `admin_init`. All run before `enqueue_editor_assets()` adds
		 * this plugin's bundle.
		 *
		 * @since n.e.x.t
		 *
		 * @return void
		 */
		private function register_framework_hooks(): void {
			add_action( 'init', 'gutenberg_sync_engines_register_sync_storage_post_type' );
			add_action( 'init', 'gutenberg_sync_engines_register_crdt_post_meta' );
			add_action( 'rest_api_init', 'gutenberg_sync_engines_register_collaboration_rest_routes' );
			add_action( 'admin_init', 'gutenberg_sync_engines_inject_collaboration_announcement' );
		}

		/**
		 * Whether the host declared the framework before this plugin booted.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True when an older Gutenberg supplied the framework.
		 */
		public function host_provides_framework(): bool {
			return $this->host_provides_framework;
		}

		/**
		 * Substitutes the plugin's table storage for the framework's
		 * post-meta default (`__unstable_wp_sync_storage`).
		 *
		 * Only the DEFAULT is replaced: a storage another plugin has
		 * already substituted, at any priority, is respected. And only
		 * when the tables are usable (the recorded schema version is
		 * current — an autoloaded option, since this runs on every
		 * `wp_get_sync_storage()` call): a site that could not create them
		 * keeps collaborating on post meta rather than failing every
		 * request, with an admin notice saying so.
		 *
		 * @since 0.0.1
		 *
		 * @param WP_Sync_Storage $storage The storage the framework built.
		 * @return WP_Sync_Storage Storage to use.
		 */
		public function filter_sync_storage( $storage ) {
			if ( $storage instanceof WP_Sync_Post_Meta_Storage && WP_Sync_Table_Schema::is_ready() ) {
				return new WP_Sync_Table_Storage();
			}
			return $storage;
		}

		/**
		 * Hands awareness to the Presence API plugin when that plugin is
		 * active and recording, replacing only the default the way storage
		 * does, so another plugin's backend is respected.
		 *
		 * @since 0.0.2
		 *
		 * @param WP_Sync_Awareness_Backend|null $backend The backend so far.
		 * @return WP_Sync_Awareness_Backend|null Backend to use.
		 */
		public function filter_awareness_backend( $backend ) {
			if ( null === $backend && WP_Sync_Presence_API_Awareness_Backend::is_available() ) {
				return new WP_Sync_Presence_API_Awareness_Backend();
			}
			return $backend;
		}

		/**
		 * Hands the tab list to the Presence API when it is available.
		 *
		 * @since n.e.x.t
		 *
		 * @param WP_Sync_Tab_List_Backend|null $backend The backend so far.
		 * @return WP_Sync_Tab_List_Backend|null Backend to use.
		 */
		public function filter_tab_list_backend( $backend ) {
			if ( null === $backend && WP_Sync_Presence_API_Tab_List_Backend::is_available() ) {
				return new WP_Sync_Presence_API_Tab_List_Backend();
			}
			return $backend;
		}

		/**
		 * Adds this plugin's engines to the framework's engine registry.
		 *
		 * @since 0.1.0
		 *
		 * @param WP_Sync_Engine[] $engines Engines to register.
		 * @param WP_Sync_Storage  $storage Storage backend.
		 * @return WP_Sync_Engine[] Engines including this plugin's.
		 */
		public function register_engines( array $engines, WP_Sync_Storage $storage ): array {
			// The framework's conventional default is intent-log
			// (WP_Sync_Engine_Registry::DEFAULT_ENGINE), used when the
			// wp_sync_engine option is unset. Registration order only
			// matters as the fallback when a CONFIGURED slug is not
			// registered (misconfiguration degrades to the first engine).
			$engines[] = new WP_Yjs_Server_Engine( $storage );
			$engines[] = new WP_Intent_Log_Engine( $storage );
			return $engines;
		}

		/**
		 * Adds this plugin's transports to the framework's transport registry.
		 *
		 * @since 0.1.0
		 *
		 * @param WP_Sync_Transport[]     $transports Transports to register.
		 * @param WP_Sync_Storage         $storage    Storage backend.
		 * @param WP_Sync_Engine_Registry $engines    Engine registry.
		 * @return WP_Sync_Transport[] Transports including this plugin's.
		 */
		public function register_transports( array $transports, WP_Sync_Storage $storage, WP_Sync_Engine_Registry $engines ): array {
			$transports[] = new WP_HTTP_Polling_Sync_Server( $storage, $engines );
			$transports[] = new WP_Sync_SSE_Server( $storage, $engines );
			$transports[] = new WP_Sync_SSE_Daemon_Transport( $storage, $engines );
			$transports[] = new WP_WebSocket_Sync_Transport( $storage, $engines );
			return $transports;
		}

		/**
		 * Supplies transport-specific client connection metadata for the
		 * framework's collaboration announcement
		 * (`window._wpCollaborationTransportConfig`): the framework carries no
		 * transport-specific knowledge, so the WebSocket transport's socket
		 * URL must be announced from here. Without it the client's socket
		 * provider has no URL to connect to and the websocket transport
		 * cannot establish a session.
		 *
		 * @since 0.1.0
		 *
		 * @param array    $config     Client config keyed by transport slug.
		 * @param string[] $transports Announced transport slugs.
		 * @return array Config including the socket URL when announced.
		 */
		public function filter_transport_client_config( $config, $transports ): array {
			$config = is_array( $config ) ? $config : array();
			if ( in_array( WP_WebSocket_Sync_Transport::TRANSPORT_SLUG, (array) $transports, true ) ) {
				$config[ WP_WebSocket_Sync_Transport::TRANSPORT_SLUG ] = array(
					'url' => WP_WebSocket_Sync_Transport::get_socket_url(),
				);
			}
			if ( in_array( WP_Sync_SSE_Daemon_Transport::TRANSPORT_SLUG, (array) $transports, true ) ) {
				$config[ WP_Sync_SSE_Daemon_Transport::TRANSPORT_SLUG ] = array(
					'url' => WP_Sync_SSE_Daemon_Transport::get_stream_url(),
				);
			}
			return $config;
		}

		/**
		 * Enqueues the client engine/transport bundle in the editor when
		 * collaboration is enabled, plus the intent-log block-identity stamper
		 * when intent-log is the active engine.
		 *
		 * The bundle owns its engine adapters and transports and registers one
		 * entity provider with core-data. The server selects the engine. If
		 * this bundle is missing, the editor returns to standard post locking.
		 *
		 * The stamper fills `metadata.syncId` for blocks that lack one and
		 * re-mints duplicates directly in the editor store, making block
		 * identity durable. It is a raw script (no build), specific to the
		 * intent-log engine.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function enqueue_editor_assets(): void {
			if ( ! wp_is_collaboration_enabled() ) {
				return;
			}

			$bundle = GUTENBERG_SYNC_ENGINES_PATH . 'build/sync-engines.js';
			$asset  = GUTENBERG_SYNC_ENGINES_PATH . 'build/sync-engines.asset.php';
			if ( file_exists( $bundle ) && file_exists( $asset ) ) {
				$meta = require $asset;

				/*
				 * Plugin-owned client settings (the framework announcement
				 * stays untouched): the short-polling interval and the
				 * slow awareness mode, both
				 * stored in seconds and passed in milliseconds for the
				 * client's timers.
				 */
				$polling_interval   = 0;
				$awareness_interval = 0;
				$awareness_channel  = 'sync';
				if ( class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
					$polling_interval   = Gutenberg_Sync_Engines_Settings::polling_interval();
					$awareness_interval = Gutenberg_Sync_Engines_Settings::awareness_interval();
					$awareness_channel  = Gutenberg_Sync_Engines_Settings::awareness_channel();
				}

				// Slow awareness over Heartbeat rides the advisory channel's
				// discovery probe and needs wp.heartbeat on the page.
				$dependencies   = isset( $meta['dependencies'] ) ? $meta['dependencies'] : array();
				$dependencies[] = 'wp-sync'; // Supplies the shared Yjs instance.
				if ( $awareness_interval > 0 && 'heartbeat' === $awareness_channel ) {
					$dependencies[] = 'heartbeat';
				}

				wp_enqueue_script(
					'gutenberg-sync-engines',
					GUTENBERG_SYNC_ENGINES_URL . 'build/sync-engines.js',
					$dependencies,
					isset( $meta['version'] ) ? $meta['version'] : GUTENBERG_SYNC_ENGINES_VERSION,
					true
				);

				$settings = array(
					'httpPollingIntervalMs' => max( 0, min( 25, $polling_interval ) ) * 1000,
					'awarenessIntervalMs'   => $awareness_interval * 1000,
					'awarenessChannel'      => $awareness_channel,
				);

				/*
				 * The advisory channel's per-tab settings: this tab's
				 * presence token (stamped now, so a joiner is visible to the
				 * first tab's next heartbeat), whether anyone else is already
				 * there, and the WebRTC configuration. Only on a single-post
				 * editor screen; other block-editor screens (widgets, site
				 * editor) have no per-post room to discover peers in, and
				 * keep the always-on polling cadence.
				 */
				$post = get_post();
				if ( $post instanceof WP_Post ) {
					$advisory = ( new Gutenberg_Sync_Engines_Advisory_Presence() )->editor_settings( $post );
					if ( null !== $advisory ) {
						$settings['advisory'] = $advisory;
					}
				}

				wp_add_inline_script(
					'gutenberg-sync-engines',
					'window._gutenbergSyncEnginesSettings = ' . wp_json_encode( $settings ) . ';',
					'before'
				);
			}

			$storage = gutenberg_sync_engines_storage();
			$engines = new WP_Sync_Engine_Registry( $storage );
			// The editor-side identity stamper serves every engine whose
			// blocks carry `metadata.syncId` — intent-log.
			if ( 'intent-log' !== $engines->get_engine_slug_for_room( '' ) ) {
				return;
			}
			$stamper = GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/sync-id.js';
			wp_enqueue_script(
				'gutenberg-sync-engines-block-identity-stamper',
				GUTENBERG_SYNC_ENGINES_URL . 'includes/shared/sync-id.js',
				array( 'wp-data' ),
				file_exists( $stamper ) ? (string) filemtime( $stamper ) : GUTENBERG_SYNC_ENGINES_VERSION,
				true
			);
		}

		/**
		 * Admin notice shown when Gutenberg's collaboration support (the
		 * `wp_is_collaboration_enabled()` gate) is not available.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function render_missing_framework_notice(): void {
			if ( ! current_user_can( 'activate_plugins' ) ) {
				return;
			}
			echo '<div class="notice notice-warning"><p>';
			echo esc_html__( 'Gutenberg Sync Engines needs the collaboration support in Gutenberg (or a supporting WordPress version). Real-time collaboration is inactive until it is available.', 'gutenberg-sync-engines' );
			echo '</p></div>';
		}

		/**
		 * Admin notice shown when the storage tables could not be created:
		 * collaboration keeps working on the framework's post-meta storage
		 * until they can be.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_storage_unavailable_notice(): void {
			if ( ! current_user_can( 'activate_plugins' ) ) {
				return;
			}
			echo '<div class="notice notice-error"><p>';
			echo esc_html__( 'Gutenberg Sync Engines could not create its collaboration storage tables (the database user may lack the CREATE TABLE privilege). Real-time collaboration is running on the slower post-meta storage until they exist; run "wp collaboration storage install" once the privilege is granted.', 'gutenberg-sync-engines' );
			echo '</p></div>';
		}
	}
}
