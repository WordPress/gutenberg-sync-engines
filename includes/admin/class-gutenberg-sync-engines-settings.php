<?php
/**
 * Gutenberg_Sync_Engines_Settings class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {

	/**
	 * The Settings → Collaboration admin screen: choose the active sync
	 * ENGINE, how editor tabs get each other's changes (the TRANSPORT and,
	 * with it, the advisory channel), and the unsaved-changes policy.
	 *
	 * The engine choice is stored in the framework's own `wp_sync_engine`
	 * option (read by WP_Sync_Engine_Registry). The transport choice is
	 * stored here and fed to the framework through the
	 * `wp_collaboration_transport` filter, so a single screen drives both
	 * axes of the swappable stack.
	 *
	 * The screen shows ONE "Transport" list, but stores two options: the
	 * transport slug and the advisory channel. Each entry in the list is
	 * one pair (see delivery_choices()), so the screen can never select
	 * the pairs that would silently conflict (a WebSocket transport with a
	 * WebSocket advisory channel). WP-CLI, the fuzzer, and the e2e specs
	 * keep setting the two options directly.
	 *
	 * @since 0.1.0
	 */
	final class Gutenberg_Sync_Engines_Settings {
		/**
		 * Settings group / page slug.
		 *
		 * @since 0.1.0
		 * @var string
		 */
		const PAGE = 'gutenberg-sync-engines';

		/**
		 * Option storing the active transport slug.
		 *
		 * @since 0.1.0
		 * @var string
		 */
		const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';

		/**
		 * The form field behind the "Transport" list. NOT an option: its
		 * sanitize callback writes the transport and advisory options and
		 * the value itself is never stored (see register()).
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const DELIVERY_FIELD = 'gutenberg_sync_engines_delivery';

		const DELIVERY_POLLING           = 'polling';
		const DELIVERY_POLLING_WEBRTC    = 'polling-webrtc';
		const DELIVERY_POLLING_WEBSOCKET = 'polling-websocket';
		const DELIVERY_SSE               = 'sse';
		const DELIVERY_SSE_DAEMON        = 'sse-daemon';
		const DELIVERY_WEBSOCKET         = 'websocket';

		/**
		 * Option storing the de-rtc commit cadence in SECONDS. 0 commits
		 * whenever edits settle (pseudo-realtime); unset means
		 * DE_RTC_COMMIT_INTERVAL_DEFAULT, the Distributed Editing vision's
		 * operating point.
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const DE_RTC_COMMIT_INTERVAL_OPTION = 'gutenberg_sync_engines_de_rtc_commit_interval';

		/**
		 * The de-rtc commit cadence in seconds when none is set.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const DE_RTC_COMMIT_INTERVAL_DEFAULT = 10;

		/**
		 * Option storing the HTTP short-polling interval in SECONDS: how
		 * often a tab asks the server for changes while collaborating
		 * without an advisory channel covering every peer. Unset (or 0,
		 * the first release's "built-in") means POLLING_INTERVAL_DEFAULT.
		 * Capped at 25 so polling always beats the server's 30-second
		 * awareness timeout.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const POLLING_INTERVAL_OPTION = 'gutenberg_sync_engines_polling_interval';

		/**
		 * The polling interval in seconds when none is set.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const POLLING_INTERVAL_DEFAULT = 5;

		/**
		 * Option holding the advisory channel choice: `webrtc-advisory` (the
		 * default browser-to-browser link), `websocket-advisory` (one socket
		 * per tab to a WebSocket server, which relays between the tabs in a
		 * room) or the empty string for off. `web-rtc`, the slug the first
		 * release stored, still reads as `webrtc-advisory`.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const ADVISORY_OPTION        = 'gutenberg_sync_engines_advisory_channel';
		const ADVISORY_WEBRTC        = 'webrtc-advisory';
		const ADVISORY_WEBSOCKET     = 'websocket-advisory';
		const ADVISORY_LEGACY_WEBRTC = 'web-rtc';
		const ADVISORY_DEFAULT       = self::ADVISORY_WEBRTC;

		/**
		 * Option: the WebSocket URL editor tabs connect to for the
		 * WebSocket TRANSPORT — the plugin's sync daemon. Empty (the
		 * default) means `ws://<WP_SYNC_WEBSOCKET_HOST>:<WP_SYNC_WEBSOCKET_PORT>`;
		 * the `wp_sync_websocket_url` filter still applies last.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const WEBSOCKET_URL_OPTION = 'gutenberg_sync_engines_websocket_url';

		/**
		 * Option: the WebSocket URL editor tabs connect to for the
		 * WebSocket ADVISORY channel — the sync daemon or a host's own
		 * relay (examples/advisory-relay). Empty (the default) means the
		 * transport's URL, i.e. the daemon.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const ADVISORY_WEBSOCKET_URL_OPTION = 'gutenberg_sync_engines_advisory_websocket_url';

		/**
		 * Option holding the unsaved-changes policy: `discard` (the saved post
		 * is the only durable copy; a room nobody is in is reset to it) or
		 * `keep` (rooms live on as a shared working copy). See
		 * docs/room-lifetime.md.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const UNSAVED_OPTION  = 'gutenberg_sync_engines_unsaved_changes';
		const UNSAVED_DISCARD = 'discard';
		const UNSAVED_KEEP    = 'keep';
		const UNSAVED_DEFAULT = self::UNSAVED_DISCARD;

		/**
		 * Option holding the slow awareness interval in SECONDS. 0 keeps the
		 * framework's built-in awareness (live cursors). Any other value
		 * switches every editor tab to block-level presence exchanged once
		 * per interval: each tab names the block its selection is in and
		 * peers draw an outline and an avatar on it. See
		 * docs/awareness-high-latency.md.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const AWARENESS_INTERVAL_OPTION = 'gutenberg_sync_engines_awareness_interval';

		/**
		 * The largest awareness interval, in seconds. Under the Heartbeat
		 * channel the beat is what keeps this tab's advisory presence token
		 * alive (a five-minute lease), so the interval stays well inside
		 * that; it is also Heartbeat's own ceiling for a hidden tab.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const AWARENESS_INTERVAL_MAX = 120;

		/**
		 * Option holding the channel the slow awareness beacon travels on:
		 * `sync` (one more field on the sync transport's awareness, so it
		 * rides the same requests as content) or `heartbeat` (the WordPress
		 * Heartbeat request, a separate stream with its own cadence).
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const AWARENESS_CHANNEL_OPTION    = 'gutenberg_sync_engines_awareness_channel';
		const AWARENESS_CHANNEL_SYNC      = 'sync';
		const AWARENESS_CHANNEL_HEARTBEAT = 'heartbeat';

		/**
		 * Registers the admin page, settings, and the transport filter.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function register(): void {
			add_action( 'admin_menu', array( $this, 'add_menu' ) );
			add_action( 'init', array( $this, 'register_options' ) );
			add_action( 'admin_init', array( $this, 'register_settings' ) );

			// The "Transport" list writes two options and stores nothing
			// itself: answering with the old value makes update_option()
			// a no-op for the field's own name.
			add_filter(
				'pre_update_option_' . self::DELIVERY_FIELD,
				static function ( $value, $old_value ) {
					unset( $value );
					return $old_value;
				},
				10,
				2
			);

			// Feed the stored transport choice to the framework.
			add_filter(
				'wp_collaboration_transport',
				function ( $default_slug ) {
					$stored = self::stored_transport();
					return '' !== $stored ? $stored : $default_slug;
				}
			);
		}

		/**
		 * The stored transport slug, with the retired long-polling transport
		 * read as SSE: the same held request, now a stream (sites that chose
		 * it before the change keep push delivery without a visit to the
		 * settings screen).
		 *
		 * @since 0.0.2
		 *
		 * @return string The transport slug, or '' when none is stored.
		 */
		public static function stored_transport(): string {
			$stored = (string) get_option( self::TRANSPORT_OPTION, '' );
			return 'http-long-polling' === $stored ? 'sse' : $stored;
		}

		/**
		 * The engines this plugin provides, as slug => name. Filterable so
		 * additional engine plugins can appear on the screen (see
		 * engine_descriptions() for the text shown under the chosen one).
		 *
		 * @since 0.1.0
		 * @since 0.0.1 Names only; the descriptions moved to engine_descriptions().
		 *
		 * @return array<string, string> Engine choices.
		 */
		public static function engine_choices(): array {
			$choices = array(
				'intent-log' => __( 'Intent log', 'gutenberg-sync-engines' ),
				'yjs-server' => __( 'Yjs server', 'gutenberg-sync-engines' ),
				'de-rtc'     => __( 'DE-RTC', 'gutenberg-sync-engines' ),
			);

			/**
			 * Filters the sync engine choices shown on the settings screen.
			 *
			 * @since 0.1.0
			 *
			 * @param array<string, string> $choices Engine slug => name.
			 */
			return (array) apply_filters( 'gutenberg_sync_engines_engine_choices', $choices );
		}

		/**
		 * One sentence per engine, shown under the select for the engine
		 * chosen. Filterable so additional engine plugins can describe
		 * themselves.
		 *
		 * @since 0.0.1
		 *
		 * @return array<string, string> Engine slug => description.
		 */
		public static function engine_descriptions(): array {
			$descriptions = array(
				'intent-log' => __( 'The server combines everyone\'s changes. When two people change the same thing, it sets the change aside for someone to review. The cheapest engine to run, and the default.', 'gutenberg-sync-engines' ),
				'yjs-server' => __( 'The server combines changes automatically, even when two people change the same thing: the later change wins and nobody is told. Two people can type in the same sentence. It costs the most per edit.', 'gutenberg-sync-engines' ),
				'de-rtc'     => __( 'Each editor sends the whole post and names the version it started from. The server merges it into the current version, block by block. When two people change the same block, it sets that block aside for someone to review. Scripts and plugins that save a post join the merge too.', 'gutenberg-sync-engines' ),
			);

			/**
			 * Filters the sync engine descriptions shown on the settings
			 * screen.
			 *
			 * @since 0.0.1
			 *
			 * @param array<string, string> $descriptions Engine slug => description.
			 */
			return (array) apply_filters( 'gutenberg_sync_engines_engine_descriptions', $descriptions );
		}

		/**
		 * The transport choices, read from the framework's transport registry
		 * so every registered transport appears.
		 *
		 * @since 0.1.0
		 *
		 * @return array<string, string> Transport choices (slug => label).
		 */
		public static function transport_choices(): array {
			$labels  = array(
				'http-polling' => __( 'Short-polling (default)', 'gutenberg-sync-engines' ),
				'sse'          => __( 'Server-sent events', 'gutenberg-sync-engines' ),
				'sse-daemon'   => __( 'Server-sent events (sync daemon)', 'gutenberg-sync-engines' ),
				'websocket'    => __( 'WebSocket', 'gutenberg-sync-engines' ),
			);
			$choices = array();

			if ( function_exists( 'wp_get_collaboration_transport_registry' ) ) {
				foreach ( array_keys( wp_get_collaboration_transport_registry()->get_transports() ) as $slug ) {
					$choices[ $slug ] = $labels[ $slug ] ?? $slug;
				}
			}
			if ( empty( $choices ) ) {
				$choices = $labels;
			}
			return $choices;
		}

		/**
		 * The "Transport" list: each entry is one (transport, advisory
		 * channel) pair. SSE and the WebSocket transport carry
		 * everything themselves while connected; the WebRTC advisory
		 * channel they store is what serves when the connection is down
		 * and tabs fall back to polling.
		 *
		 * @since 0.0.1
		 *
		 * @return array<string, array{transport: string, advisory: string, label: string, description: string}> Choices.
		 */
		public static function delivery_choices(): array {
			$sse_description = __( 'Receives updates over an HTTP stream held open by the server, one PHP worker per stream. Streams wake on Redis notices when a Redis address is configured or a Redis object cache is in use, and by checking a per-room version number every half second otherwise. Peers fall back to polling on failure.', 'gutenberg-sync-engines' );
			if ( class_exists( 'WP_Sync_Redis_Notifications' ) && '' === WP_Sync_Redis_Notifications::url() ) {
				$sse_description .= ' ' . __( 'No Redis is configured on this site (WP_SYNC_SSE_REDIS_URL, or a Redis object cache): streams check the version number instead, one small lookup per stream twice a second.', 'gutenberg-sync-engines' );
			}
			return array(
				self::DELIVERY_POLLING           => array(
					'transport'   => 'http-polling',
					'advisory'    => '',
					'label'       => __( 'Polling', 'gutenberg-sync-engines' ),
					'description' => __( 'The editor polls the server on an interval.', 'gutenberg-sync-engines' ),
				),
				self::DELIVERY_POLLING_WEBRTC    => array(
					'transport'   => 'http-polling',
					'advisory'    => self::ADVISORY_WEBRTC,
					'label'       => __( 'Polling with a WebRTC advisory channel (default)', 'gutenberg-sync-engines' ),
					'description' => __( 'Peers connect to each other to share announcements and poll for updates only when needed. WebRTC connectivity is not guaranteed. Peers fall back to polling on failure.', 'gutenberg-sync-engines' ),
				),
				self::DELIVERY_POLLING_WEBSOCKET => array(
					'transport'   => 'http-polling',
					'advisory'    => self::ADVISORY_WEBSOCKET,
					'label'       => __( 'Polling with a WebSocket advisory channel', 'gutenberg-sync-engines' ),
					'description' => __( 'Peers connect via a socket to share announcements and poll for updates only when needed. Peers fall back to polling on failure.', 'gutenberg-sync-engines' ),
				),
				self::DELIVERY_SSE               => array(
					'transport'   => 'sse',
					'advisory'    => self::ADVISORY_WEBRTC,
					'label'       => __( 'Server-sent events', 'gutenberg-sync-engines' ),
					'description' => $sse_description,
				),
				self::DELIVERY_SSE_DAEMON        => array(
					'transport'   => 'sse-daemon',
					'advisory'    => self::ADVISORY_WEBRTC,
					'label'       => __( 'Server-sent events (sync daemon)', 'gutenberg-sync-engines' ),
					'description' => __( 'The same HTTP event stream, served by the sync daemon instead of a web worker, so no PHP worker is held per stream. Needs the daemon running. Peers fall back to polling on failure.', 'gutenberg-sync-engines' ),
				),
				self::DELIVERY_WEBSOCKET         => array(
					'transport'   => 'websocket',
					'advisory'    => self::ADVISORY_WEBRTC,
					'label'       => __( 'WebSocket', 'gutenberg-sync-engines' ),
					'description' => __( 'Updates are exchanged over a persistent socket connection to WordPress. Peers fall back to polling on failure.', 'gutenberg-sync-engines' ),
				),
			);
		}

		/**
		 * The list entry the stored transport and advisory options amount
		 * to. SSE and the WebSocket transport map to their entry whatever
		 * advisory channel is stored (it only serves as fallback).
		 *
		 * @since 0.0.1
		 *
		 * @return string A DELIVERY_* value.
		 */
		public static function delivery(): string {
			$transport = self::stored_transport();
			if ( 'sse-daemon' === $transport ) {
				return self::DELIVERY_SSE_DAEMON;
			}
			if ( 'sse' === $transport ) {
				return self::DELIVERY_SSE;
			}
			if ( 'websocket' === $transport ) {
				return self::DELIVERY_WEBSOCKET;
			}
			switch ( self::advisory_channel() ) {
				case self::ADVISORY_WEBSOCKET:
					return self::DELIVERY_POLLING_WEBSOCKET;
				case self::ADVISORY_WEBRTC:
					return self::DELIVERY_POLLING_WEBRTC;
				default:
					return self::DELIVERY_POLLING;
			}
		}

		/**
		 * Adds the Settings → Collaboration submenu.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function add_menu(): void {
			add_options_page(
				__( 'Collaboration', 'gutenberg-sync-engines' ),
				__( 'Collaboration', 'gutenberg-sync-engines' ),
				'manage_options',
				self::PAGE,
				array( $this, 'render_page' )
			);
		}

		/**
		 * Registers the engine + transport options.
		 *
		 * Hooked to `init` (not `admin_init`) so the options are registered
		 * during REST requests too: `show_in_rest` makes the engine swap
		 * scriptable (`POST /wp/v2/settings`, e2e fixtures), and REST never
		 * runs `admin_init`. This is the sole registration of
		 * `wp_sync_engine` — the framework does not register it.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function register_options(): void {
			register_setting(
				self::PAGE,
				'wp_sync_engine',
				array(
					'type'              => 'string',
					'description'       => __( 'Collaborative editing sync engine', 'gutenberg-sync-engines' ),
					'sanitize_callback' => 'sanitize_key',
					'show_in_rest'      => true,
				)
			);

			/*
			 * The transport and advisory options are NOT in the page's
			 * settings group: options.php writes every option of the group
			 * on save, posted or not (an unposted one arrives as null and
			 * would be sanitized to its default), and these two are written
			 * by the "Transport" list's sanitize callback instead.
			 */
			register_setting(
				self::PAGE . '-stored',
				self::TRANSPORT_OPTION,
				array(
					'type'              => 'string',
					'sanitize_callback' => array( $this, 'sanitize_transport' ),
				)
			);
			register_setting(
				self::PAGE,
				self::DELIVERY_FIELD,
				array(
					'type'              => 'string',
					'sanitize_callback' => array( $this, 'sanitize_delivery' ),
				)
			);
			register_setting(
				self::PAGE . '-stored',
				self::ADVISORY_OPTION,
				array(
					'type'              => 'string',
					'description'       => __( 'Advisory channel between editor tabs (webrtc-advisory, websocket-advisory, or empty for off)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_advisory' ),
					'show_in_rest'      => true,
					'default'           => self::ADVISORY_DEFAULT,
				)
			);
			register_setting(
				self::PAGE,
				self::WEBSOCKET_URL_OPTION,
				array(
					'type'              => 'string',
					'description'       => __( 'WebSocket transport server URL (ws:// or wss://; empty for the default host and port)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( __CLASS__, 'sanitize_websocket_url' ),
					'show_in_rest'      => true,
					'default'           => '',
				)
			);
			register_setting(
				self::PAGE,
				self::ADVISORY_WEBSOCKET_URL_OPTION,
				array(
					'type'              => 'string',
					'description'       => __( 'WebSocket advisory server URL (ws:// or wss://; empty for the transport server)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( __CLASS__, 'sanitize_websocket_url' ),
					'show_in_rest'      => true,
					'default'           => '',
				)
			);
			register_setting(
				self::PAGE,
				self::UNSAVED_OPTION,
				array(
					'type'              => 'string',
					'description'       => __( 'What happens to unsaved changes when the last editor leaves a post (discard or keep)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_unsaved' ),
					'show_in_rest'      => true,
					'default'           => self::UNSAVED_DEFAULT,
				)
			);
			register_setting(
				self::PAGE,
				self::POLLING_INTERVAL_OPTION,
				array(
					'type'              => 'integer',
					'description'       => __( 'HTTP short-polling interval in seconds, 1 to 25 (0 = the default of 5)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_polling_interval' ),
					'show_in_rest'      => true,
					'default'           => self::POLLING_INTERVAL_DEFAULT,
				)
			);
			register_setting(
				self::PAGE,
				self::DE_RTC_COMMIT_INTERVAL_OPTION,
				array(
					'type'              => 'integer',
					'description'       => __( 'DE-RTC send interval in seconds, 0 to 300 (0 = after every pause in typing)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_commit_interval' ),
					'show_in_rest'      => true,
					'default'           => self::DE_RTC_COMMIT_INTERVAL_DEFAULT,
				)
			);
			register_setting(
				self::PAGE,
				self::AWARENESS_INTERVAL_OPTION,
				array(
					'type'              => 'integer',
					'description'       => __( 'Block presence interval in seconds, 0 to 120 (0 = the built-in live cursors)', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_awareness_interval' ),
					'show_in_rest'      => true,
					'default'           => 0,
				)
			);
			register_setting(
				self::PAGE,
				self::AWARENESS_CHANNEL_OPTION,
				array(
					'type'              => 'string',
					'description'       => __( 'Channel for slow awareness: sync or heartbeat', 'gutenberg-sync-engines' ),
					'sanitize_callback' => array( $this, 'sanitize_awareness_channel' ),
					'show_in_rest'      => true,
					'default'           => self::AWARENESS_CHANNEL_SYNC,
				)
			);
		}

		/**
		 * Sanitizes the polling interval: whole seconds, 0-25 (0 and
		 * unset both mean the default).
		 *
		 * @since 0.4.0
		 *
		 * @param mixed $value Submitted value.
		 * @return int Interval in seconds.
		 */
		public function sanitize_polling_interval( $value ): int {
			return max( 0, min( 25, (int) $value ) );
		}

		/**
		 * The polling interval in effect, in seconds.
		 *
		 * @since 0.0.1
		 *
		 * @return int 1-25.
		 */
		public static function polling_interval(): int {
			$value = (int) get_option( self::POLLING_INTERVAL_OPTION, self::POLLING_INTERVAL_DEFAULT );
			return $value > 0 ? min( 25, $value ) : self::POLLING_INTERVAL_DEFAULT;
		}

		/**
		 * Sanitizes the de-rtc commit cadence: whole seconds, 0-300.
		 *
		 * @since 0.3.0
		 *
		 * @param mixed $value Submitted value.
		 * @return int Cadence in seconds.
		 */
		public function sanitize_commit_interval( $value ): int {
			return max( 0, min( 300, (int) $value ) );
		}

		/**
		 * Sanitizes the awareness interval: whole seconds, 0 to
		 * AWARENESS_INTERVAL_MAX.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return int Interval in seconds.
		 */
		public function sanitize_awareness_interval( $value ): int {
			return max( 0, min( self::AWARENESS_INTERVAL_MAX, (int) $value ) );
		}

		/**
		 * Sanitizes the awareness channel.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string `sync` or `heartbeat`.
		 */
		public function sanitize_awareness_channel( $value ): string {
			return self::AWARENESS_CHANNEL_HEARTBEAT === (string) $value
				? self::AWARENESS_CHANNEL_HEARTBEAT
				: self::AWARENESS_CHANNEL_SYNC;
		}

		/**
		 * The slow awareness interval in effect, in seconds (0 = off).
		 *
		 * @since 0.0.1
		 *
		 * @return int 0 to AWARENESS_INTERVAL_MAX.
		 */
		public static function awareness_interval(): int {
			return max( 0, min( self::AWARENESS_INTERVAL_MAX, (int) get_option( self::AWARENESS_INTERVAL_OPTION, 0 ) ) );
		}

		/**
		 * The slow awareness channel in effect.
		 *
		 * @since 0.0.1
		 *
		 * @return string `sync` or `heartbeat`.
		 */
		public static function awareness_channel(): string {
			return self::AWARENESS_CHANNEL_HEARTBEAT === (string) get_option( self::AWARENESS_CHANNEL_OPTION, self::AWARENESS_CHANNEL_SYNC )
				? self::AWARENESS_CHANNEL_HEARTBEAT
				: self::AWARENESS_CHANNEL_SYNC;
		}

		/**
		 * Registers the settings sections and fields.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function register_settings(): void {
			// One untitled section: the field labels are the headings.
			add_settings_section( 'gutenberg_sync_engines_main', '', '__return_null', self::PAGE );
			$fields = array(
				array( 'wp_sync_engine', __( 'Sync engine', 'gutenberg-sync-engines' ), 'render_engine_field' ),
				array( self::DE_RTC_COMMIT_INTERVAL_OPTION, __( 'DE-RTC commit cadence', 'gutenberg-sync-engines' ), 'render_commit_interval_field' ),
				array( self::DELIVERY_FIELD, __( 'Transport', 'gutenberg-sync-engines' ), 'render_delivery_field' ),
				array( self::ADVISORY_WEBSOCKET_URL_OPTION, __( 'WebSocket advisory server', 'gutenberg-sync-engines' ), 'render_advisory_websocket_url_field' ),
				array( self::WEBSOCKET_URL_OPTION, __( 'WebSocket transport server', 'gutenberg-sync-engines' ), 'render_websocket_url_field' ),
				array( self::POLLING_INTERVAL_OPTION, __( 'Polling interval', 'gutenberg-sync-engines' ), 'render_polling_interval_field' ),
				array( self::AWARENESS_INTERVAL_OPTION, __( 'Awareness interval', 'gutenberg-sync-engines' ), 'render_awareness_interval_field' ),
				array( self::AWARENESS_CHANNEL_OPTION, __( 'Awareness channel', 'gutenberg-sync-engines' ), 'render_awareness_channel_field' ),
				array( self::UNSAVED_OPTION, __( 'Unsaved changes', 'gutenberg-sync-engines' ), 'render_unsaved_field' ),
			);
			foreach ( $fields as list( $id, $label, $renderer ) ) {
				add_settings_field( $id, $label, array( $this, $renderer ), self::PAGE, 'gutenberg_sync_engines_main' );
			}
		}

		/**
		 * Renders the "Transport" radio list.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_delivery_field(): void {
			$current = self::delivery();
			echo '<fieldset>';
			foreach ( self::delivery_choices() as $value => $choice ) {
				printf(
					'<p><label><input type="radio" name="%1$s" value="%2$s" %3$s /> <strong>%4$s</strong><br /><span class="description">%5$s</span></label></p>',
					esc_attr( self::DELIVERY_FIELD ),
					esc_attr( $value ),
					checked( $current, $value, false ),
					esc_html( $choice['label'] ),
					esc_html( $choice['description'] )
				);
			}
			echo '</fieldset>';

			if ( defined( 'WP_COLLABORATION_TRANSPORT' ) && is_string( WP_COLLABORATION_TRANSPORT ) && '' !== WP_COLLABORATION_TRANSPORT ) {
				printf(
					'<p class="description">%s</p>',
					esc_html(
						sprintf(
							/* translators: %s: the transport slug the constant names. */
							__( 'The WP_COLLABORATION_TRANSPORT constant is set to "%s" and takes priority over the choice above.', 'gutenberg-sync-engines' ),
							WP_COLLABORATION_TRANSPORT
						)
					)
				);
			}

			// Shown only while DE-RTC is the engine: its commits travel
			// through the autosave endpoint, so the transport's job shrinks.
			printf(
				'<p class="description" id="%1$s-de-rtc-note">%2$s</p><script>( function () {
					var note   = document.getElementById( %3$s );
					var select = document.getElementById( "wp_sync_engine" );
					if ( ! note || ! select ) {
						return;
					}
					var toggle = function () {
						note.style.display = "de-rtc" === select.value ? "" : "none";
					};
					select.addEventListener( "change", toggle );
					toggle();
				} )();</script>',
				esc_attr( self::DELIVERY_FIELD ),
				esc_html__( 'When using the DE-RTC sync engine, the transport only carries peer presence information.', 'gutenberg-sync-engines' ),
				wp_json_encode( self::DELIVERY_FIELD . '-de-rtc-note' )
			);
		}

		/**
		 * Renders the polling interval field.
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public function render_polling_interval_field(): void {
			printf(
				'<input type="number" min="1" max="25" step="1" name="%1$s" id="%1$s" value="%2$d" class="small-text" /> %3$s<p class="description">%4$s</p>',
				esc_attr( self::POLLING_INTERVAL_OPTION ),
				(int) self::polling_interval(),
				esc_html__( 'seconds', 'gutenberg-sync-engines' ),
				wp_kses(
					__( 'How often a tab asks WordPress for changes, in seconds (1 to 25; the default is <code>5</code>). It applies only while another editor is present whom the tab cannot reach directly through the channel between tabs. When it can reach every editor, it asks only when told to. A background tab asks every 25 seconds.', 'gutenberg-sync-engines' ),
					array( 'code' => array() )
				)
			);
			$this->show_row_for( self::POLLING_INTERVAL_OPTION, array( self::DELIVERY_POLLING, self::DELIVERY_POLLING_WEBRTC, self::DELIVERY_POLLING_WEBSOCKET ) );
		}

		/**
		 * Renders the de-rtc commit cadence field.
		 *
		 * @since 0.3.0
		 *
		 * @return void
		 */
		public function render_commit_interval_field(): void {
			$value = (int) get_option( self::DE_RTC_COMMIT_INTERVAL_OPTION, self::DE_RTC_COMMIT_INTERVAL_DEFAULT );
			printf(
				'<input type="number" min="0" max="300" step="1" name="%1$s" id="%1$s" value="%2$d" class="small-text" /> %3$s<p class="description">%4$s</p>',
				esc_attr( self::DE_RTC_COMMIT_INTERVAL_OPTION ),
				(int) $value,
				esc_html__( 'seconds', 'gutenberg-sync-engines' ),
				wp_kses(
					__( 'How often an editor sends its changes to the server under DE-RTC, 0 to 300 seconds. Other people do not see an edit until it is sent, so this setting, not the polling interval, decides how soon they see it. <code>0</code> sends after every pause in typing.', 'gutenberg-sync-engines' ),
					array( 'code' => array() )
				)
			);

			/*
			 * The dial only applies to de-rtc: HIDE its row (live, following
			 * the engine select) rather than disable the input — a disabled
			 * input drops out of the POST and saving under another engine
			 * would silently reset the stored cadence. A hidden row still
			 * submits, so the value survives engine round-trips. Without JS
			 * the row simply stays visible.
			 */
			printf(
				'<script>( function () {
					var input  = document.getElementById( %1$s );
					var select = document.getElementById( "wp_sync_engine" );
					if ( ! input || ! select ) {
						return;
					}
					var row    = input.closest( "tr" );
					var toggle = function () {
						row.style.display = "de-rtc" === select.value ? "" : "none";
					};
					select.addEventListener( "change", toggle );
					toggle();
				} )();</script>',
				wp_json_encode( self::DE_RTC_COMMIT_INTERVAL_OPTION )
			);
		}

		/**
		 * Sanitizes the transport slug against the registered choices.
		 *
		 * @since 0.1.0
		 *
		 * @param mixed $value Submitted value.
		 * @return string Transport slug.
		 */
		public function sanitize_transport( $value ): string {
			$value = sanitize_key( (string) $value );
			if ( 'http-long-polling' === $value ) {
				// The retired transport; its stream successor.
				$value = 'sse';
			}
			$choices = self::transport_choices();
			return isset( $choices[ $value ] ) ? $value : 'http-polling';
		}

		/**
		 * Sanitizes the "Transport" list's value and writes the pair of
		 * options it stands for. The value itself is not stored.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string The DELIVERY_* value applied.
		 */
		public function sanitize_delivery( $value ): string {
			$choices = self::delivery_choices();
			$value   = (string) $value;
			if ( ! isset( $choices[ $value ] ) ) {
				$value = self::DELIVERY_POLLING_WEBRTC;
			}
			update_option( self::TRANSPORT_OPTION, $choices[ $value ]['transport'] );
			update_option( self::ADVISORY_OPTION, $choices[ $value ]['advisory'] );
			return $value;
		}

		/**
		 * Renders the engine <select>, with the chosen engine's description
		 * under it (swapped live as the choice changes).
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function render_engine_field(): void {
			$current      = (string) get_option( 'wp_sync_engine', 'intent-log' );
			$descriptions = self::engine_descriptions();
			$this->render_select( 'wp_sync_engine', self::engine_choices(), $current );
			printf(
				'<p class="description" id="wp_sync_engine-description">%s</p>',
				esc_html( $descriptions[ $current ] ?? '' )
			);
			printf(
				'<script>( function () {
					var select       = document.getElementById( "wp_sync_engine" );
					var description  = document.getElementById( "wp_sync_engine-description" );
					var descriptions = %s;
					if ( ! select || ! description ) {
						return;
					}
					select.addEventListener( "change", function () {
						description.textContent = descriptions[ select.value ] || "";
					} );
				} )();</script>',
				wp_json_encode( $descriptions )
			);
			echo '<p class="description">' . esc_html__( 'Each post keeps using the engine it started with. After you switch engines, editors on a post that is still open under the old engine are refused until its session resets. With "Discard" chosen under Unsaved changes, that happens once everyone has closed the post.', 'gutenberg-sync-engines' ) . '</p>';
		}

		/**
		 * Sanitizes a WebSocket URL: a `ws://` or `wss://` URL, or the
		 * empty string for the default.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string The URL, or ''.
		 */
		public static function sanitize_websocket_url( $value ): string {
			$value = trim( (string) $value );
			if ( '' === $value ) {
				return '';
			}
			return (string) esc_url_raw( $value, array( 'ws', 'wss' ) );
		}

		/**
		 * The configured WebSocket transport URL, or '' for the default.
		 *
		 * @since 0.0.1
		 *
		 * @return string The URL, or ''.
		 */
		public static function websocket_url(): string {
			return self::sanitize_websocket_url( get_option( self::WEBSOCKET_URL_OPTION, '' ) );
		}

		/**
		 * The WebSocket URL the advisory channel connects to: the advisory
		 * server setting, else the transport's URL (the sync daemon serves
		 * both).
		 *
		 * @since 0.0.1
		 *
		 * @return string The URL.
		 */
		public static function advisory_websocket_url(): string {
			$url = self::sanitize_websocket_url( get_option( self::ADVISORY_WEBSOCKET_URL_OPTION, '' ) );
			if ( '' !== $url ) {
				return $url;
			}
			return class_exists( 'WP_WebSocket_Sync_Transport' ) ? WP_WebSocket_Sync_Transport::get_socket_url() : '';
		}

		/**
		 * Renders the WebSocket advisory server URL field.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_advisory_websocket_url_field(): void {
			$this->render_url_input(
				self::ADVISORY_WEBSOCKET_URL_OPTION,
				self::sanitize_websocket_url( get_option( self::ADVISORY_WEBSOCKET_URL_OPTION, '' ) ),
				self::advisory_websocket_url()
			);
			echo '<p class="description">' . esc_html__( 'The server that passes presence and "go and poll" notices between the tabs on a post: the sync daemon, or a relay you run (see examples/advisory-relay in the plugin). Empty uses the WebSocket transport server.', 'gutenberg-sync-engines' ) . '</p>';
			if ( class_exists( 'WP_WebSocket_Access_Token' ) && true !== WP_WebSocket_Access_Token::is_enabled() ) {
				printf(
					'<p class="description">%s</p>',
					wp_kses(
						__( 'To use your own relay, define the <code>WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET</code> constant. It is not set, so only the sync daemon can accept connections.', 'gutenberg-sync-engines' ),
						array( 'code' => array() )
					)
				);
			}
			$this->show_row_for( self::ADVISORY_WEBSOCKET_URL_OPTION, array( self::DELIVERY_POLLING_WEBSOCKET ) );
		}

		/**
		 * Renders the WebSocket transport server URL field.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_websocket_url_field(): void {
			$effective = class_exists( 'WP_WebSocket_Sync_Transport' ) ? WP_WebSocket_Sync_Transport::get_socket_url() : '';
			$this->render_url_input( self::WEBSOCKET_URL_OPTION, self::websocket_url(), $effective );
			echo '<p class="description">' . wp_kses(
				__( 'The address of the sync daemon, the long-running process that serves the WebSocket and the daemon\'s event stream (use <code>wss://</code> behind TLS in production). If empty, the daemon\'s own host and port are used: <code>WP_SYNC_WEBSOCKET_HOST</code> and <code>WP_SYNC_WEBSOCKET_PORT</code>, default <code>127.0.0.1:8787</code>. The <code>wp_sync_websocket_url</code> filter overrides this field and makes it read-only.', 'gutenberg-sync-engines' ),
				array( 'code' => array() )
			) . '</p>';
			$this->show_row_for( self::WEBSOCKET_URL_OPTION, array( self::DELIVERY_WEBSOCKET, self::DELIVERY_SSE_DAEMON ) );
		}

		/**
		 * Renders a server URL input with a "Test" button that opens a
		 * WebSocket from THIS browser (the one that has to reach the
		 * server) with a real credential from the token route, and
		 * reports whether the handshake succeeded.
		 *
		 * @since 0.0.1
		 *
		 * @param string $name      Option name (input name and id).
		 * @param string $value     Stored value ('' for the default).
		 * @param string $effective The URL in effect, tested when the
		 *                          input is empty.
		 * @return void
		 */
		private function render_url_input( string $name, string $value, string $effective ): void {
			printf(
				'<input type="url" class="regular-text code" name="%1$s" id="%1$s" value="%2$s" placeholder="%3$s" %4$s /> <button type="button" class="button" data-test-url="%1$s">%5$s</button> <span class="description" id="%1$s-result" role="status"></span>',
				esc_attr( $name ),
				esc_attr( $value ),
				esc_attr( $effective ),
				has_filter( 'wp_sync_websocket_url' ) && self::WEBSOCKET_URL_OPTION === $name ? 'readonly' : '',
				esc_html__( 'Test', 'gutenberg-sync-engines' )
			);
		}

		/**
		 * Shows a field's row only while one of the given "Transport" list
		 * entries is selected. The row is hidden, not disabled: a disabled
		 * input drops out of the POST and saving would reset the stored
		 * value. Without JS the row simply stays visible.
		 *
		 * @since 0.0.1
		 *
		 * @param string   $input_id   The field's input id.
		 * @param string[] $deliveries DELIVERY_* values that show it.
		 * @return void
		 */
		private function show_row_for( string $input_id, array $deliveries ): void {
			printf(
				'<script>( function () {
					var input  = document.getElementById( %1$s );
					var radios = document.querySelectorAll( "input[name=" + %2$s + "]" );
					if ( ! input || ! radios.length ) {
						return;
					}
					var row    = input.closest( "tr" );
					var shown  = %3$s;
					var toggle = function () {
						var checked = document.querySelector( "input[name=" + %2$s + "]:checked" );
						row.style.display = checked && -1 !== shown.indexOf( checked.value ) ? "" : "none";
					};
					radios.forEach( function ( radio ) {
						radio.addEventListener( "change", toggle );
					} );
					toggle();
				} )();</script>',
				wp_json_encode( $input_id ),
				wp_json_encode( self::DELIVERY_FIELD ),
				wp_json_encode( array_values( $deliveries ) )
			);
		}

		/**
		 * Sanitizes the advisory channel choice.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string `webrtc-advisory`, `websocket-advisory`, or the empty
		 *                string (off).
		 */
		public function sanitize_advisory( $value ): string {
			return self::normalize_advisory( $value );
		}

		/**
		 * Maps a stored advisory value (including the legacy `web-rtc`) to
		 * a current slug.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Raw value.
		 * @return string `webrtc-advisory`, `websocket-advisory`, or the empty
		 *                string (off).
		 */
		public static function normalize_advisory( $value ): string {
			$value = (string) $value;
			if ( self::ADVISORY_LEGACY_WEBRTC === $value ) {
				return self::ADVISORY_WEBRTC;
			}
			return in_array( $value, array( self::ADVISORY_WEBRTC, self::ADVISORY_WEBSOCKET ), true ) ? $value : '';
		}

		/**
		 * The advisory channel the site chose: `webrtc-advisory`,
		 * `websocket-advisory`, or the empty string for off.
		 *
		 * @since 0.0.1
		 *
		 * @return string The advisory channel slug, or the empty string.
		 */
		public static function advisory_channel(): string {
			return self::normalize_advisory( get_option( self::ADVISORY_OPTION, self::ADVISORY_DEFAULT ) );
		}

		/**
		 * Sanitizes the unsaved-changes policy.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string `discard` or `keep`.
		 */
		public function sanitize_unsaved( $value ): string {
			return self::UNSAVED_KEEP === (string) $value ? self::UNSAVED_KEEP : self::UNSAVED_DISCARD;
		}

		/**
		 * Renders the unsaved-changes policy field.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_unsaved_field(): void {
			$current = $this->sanitize_unsaved( get_option( self::UNSAVED_OPTION, self::UNSAVED_DEFAULT ) );
			$choices = array(
				self::UNSAVED_DISCARD => array(
					__( 'Discard when the last editor leaves.', 'gutenberg-sync-engines' ),
					__( 'Unsaved edits are discarded (after confirmation). The next editor continues from the saved post.', 'gutenberg-sync-engines' ),
				),
				self::UNSAVED_KEEP    => array(
					__( 'Keep as a shared working copy.', 'gutenberg-sync-engines' ),
					__( 'Unsaved edits are kept indefinitely. The next editor continues from them.', 'gutenberg-sync-engines' ),
				),
			);
			echo '<fieldset>';
			foreach ( $choices as $value => list( $label, $description ) ) {
				printf(
					'<p><label><input type="radio" name="%1$s" value="%2$s" %3$s /> <strong>%4$s</strong><br /><span class="description">%5$s</span></label></p>',
					esc_attr( self::UNSAVED_OPTION ),
					esc_attr( $value ),
					checked( $current, $value, false ),
					esc_html( $label ),
					esc_html( $description )
				);
			}
			echo '</fieldset>';
		}

		/**
		 * Renders the awareness interval field.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_awareness_interval_field(): void {
			printf(
				'<input type="number" min="0" max="%5$d" step="1" name="%1$s" id="%1$s" value="%2$d" class="small-text" /> %3$s<p class="description">%4$s</p>',
				esc_attr( self::AWARENESS_INTERVAL_OPTION ),
				(int) self::awareness_interval(),
				esc_html__( 'seconds', 'gutenberg-sync-engines' ),
				esc_html__( '0 keeps the built-in live cursors. Any other value, up to 120 seconds, replaces cursors with block presence. Once per interval, each editor shares the block they are in, and others see an outline and an avatar on that block. Use this on connections too slow for cursors.', 'gutenberg-sync-engines' ),
				(int) self::AWARENESS_INTERVAL_MAX
			);
		}

		/**
		 * Renders the awareness channel field.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_awareness_channel_field(): void {
			$current = self::awareness_channel();
			$choices = array(
				self::AWARENESS_CHANNEL_SYNC      => array(
					__( 'Sync transport.', 'gutenberg-sync-engines' ),
					__( 'The block name travels on the sync transport, beside the content. With an advisory channel connected it reaches the other editors directly, without waiting for a request.', 'gutenberg-sync-engines' ),
				),
				self::AWARENESS_CHANNEL_HEARTBEAT => array(
					__( 'WordPress Heartbeat.', 'gutenberg-sync-engines' ),
					__( 'Presence travels separately from content, so a person\'s block can show before their edit does. The block name rides on the channel between tabs, so select a transport with one above. This also sets how often WordPress Heartbeat runs on editor screens, to match the interval above.', 'gutenberg-sync-engines' ),
				),
			);
			echo '<fieldset>';
			foreach ( $choices as $value => list( $label, $description ) ) {
				printf(
					'<p><label><input type="radio" name="%1$s" value="%2$s" %3$s /> <strong>%4$s</strong><br /><span class="description">%5$s</span></label></p>',
					esc_attr( self::AWARENESS_CHANNEL_OPTION ),
					esc_attr( $value ),
					checked( $current, $value, false ),
					esc_html( $label ),
					esc_html( $description )
				);
			}
			echo '</fieldset>';
			echo '<p class="description">' . esc_html__( 'Only used when the awareness interval is set.', 'gutenberg-sync-engines' ) . '</p>';
		}

		/**
		 * Renders a labeled <select> for a setting.
		 *
		 * @since 0.1.0
		 *
		 * @param string                $name    Option name.
		 * @param array<string, string> $choices Slug => label.
		 * @param string                $current Current value.
		 * @return void
		 */
		private function render_select( string $name, array $choices, string $current ): void {
			echo '<select name="' . esc_attr( $name ) . '" id="' . esc_attr( $name ) . '">';
			foreach ( $choices as $slug => $label ) {
				printf(
					'<option value="%s" %s>%s</option>',
					esc_attr( $slug ),
					selected( $current, $slug, false ),
					esc_html( $label )
				);
			}
			echo '</select>';
		}

		/**
		 * Renders the settings page.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function render_page(): void {
			if ( ! current_user_can( 'manage_options' ) ) {
				return;
			}
			echo '<div class="wrap">';
			echo '<h1>' . esc_html( get_admin_page_title() ) . '</h1>';
			echo '<p>' . esc_html__( 'Choose how edits from several people are combined (the engine) and how they travel between the editor and WordPress (the transport). The defaults work on any host. Each setting is a plain WordPress option, so WP-CLI and the REST settings endpoint can change it. Guides for engines and transports are in the plugin\'s docs folder.', 'gutenberg-sync-engines' ) . '</p>';

			/*
			 * Nothing on this screen does anything while real-time
			 * collaboration is off, and since WordPress/gutenberg#80658 it is
			 * off by default and lives behind a Gutenberg experiment rather
			 * than a Settings → Writing checkbox. Say so, and link there,
			 * instead of leaving an engine picker that quietly has no effect.
			 */
			$collaboration_enabled = ! function_exists( 'wp_is_collaboration_enabled' ) || wp_is_collaboration_enabled();
			if ( ! $collaboration_enabled ) {
				printf(
					'<div class="notice notice-warning"><p>%1$s</p></div>',
					wp_kses(
						sprintf(
							/* translators: %s: link to the Gutenberg experiments screen. */
							__( 'Real-time collaboration is turned off, so these settings have no effect yet. Enable the <strong>Real-time collaboration</strong> experiment on the %s screen.', 'gutenberg-sync-engines' ),
							'<a href="' . esc_url( admin_url( 'admin.php?page=gutenberg-experiments' ) ) . '">' . esc_html__( 'Gutenberg experiments', 'gutenberg-sync-engines' ) . '</a>'
						),
						array(
							'strong' => array(),
							'a'      => array( 'href' => array() ),
						)
					)
				);
			}

			echo '<form action="options.php" method="post">';
			settings_fields( self::PAGE );
			do_settings_sections( self::PAGE );
			submit_button();
			echo '</form>';
			$this->render_test_script( $collaboration_enabled );
			echo '</div>';
		}

		/**
		 * The "Test" buttons' script: fetch a credential from the token
		 * route (the same one editors use), open a WebSocket to the URL in
		 * the field (or its placeholder, the URL in effect) from this
		 * browser, and report whether the handshake succeeded within five
		 * seconds. A refused handshake means the server is unreachable
		 * from here, is not a sync server or relay, or (for a relay) does
		 * not share the access-token secret.
		 *
		 * @since 0.0.1
		 *
		 * @param bool $collaboration_enabled Whether the token route exists.
		 * @return void
		 */
		private function render_test_script( bool $collaboration_enabled ): void {
			printf(
				'<script>( function () {
					var tokenUrl = %1$s;
					var nonce    = %2$s;
					var enabled  = %3$s;
					var messages = %4$s;
					document.querySelectorAll( "button[data-test-url]" ).forEach( function ( button ) {
						var input  = document.getElementById( button.getAttribute( "data-test-url" ) );
						var result = document.getElementById( button.getAttribute( "data-test-url" ) + "-result" );
						button.addEventListener( "click", function () {
							var url = input.value.trim() || input.placeholder;
							result.textContent = messages.testing;
							if ( ! enabled ) {
								result.textContent = messages.disabled;
								return;
							}
							fetch( tokenUrl, {
								method: "POST",
								credentials: "same-origin",
								headers: { "X-WP-Nonce": nonce }
							} ).then( function ( response ) {
								return response.ok ? response.json() : Promise.reject( new Error( "token" ) );
							} ).then( function ( data ) {
								return new Promise( function ( resolve, reject ) {
									var socket  = new WebSocket( url, [ "wp-sync", "wp-sync-token." + data.token ] );
									var timer   = setTimeout( function () { socket.close(); reject( new Error( "timeout" ) ); }, 5000 );
									socket.onopen = function () { clearTimeout( timer ); socket.close(); resolve(); };
									socket.onerror = function () { clearTimeout( timer ); reject( new Error( "refused" ) ); };
									socket.onclose = function ( event ) { if ( ! event.wasClean ) { clearTimeout( timer ); reject( new Error( "refused" ) ); } };
								} );
							} ).then( function () {
								result.textContent = messages.ok.replace( "%%s", url );
							}, function ( error ) {
								result.textContent = ( messages[ error.message ] || messages.refused ).replace( "%%s", url );
							} );
						} );
					} );
				} )();</script>',
				wp_json_encode( rest_url( 'wp-sync/v1/ws-token' ) ),
				wp_json_encode( wp_create_nonce( 'wp_rest' ) ),
				$collaboration_enabled ? 'true' : 'false',
				wp_json_encode(
					array(
						'testing'  => __( 'Connecting…', 'gutenberg-sync-engines' ),
						'disabled' => __( 'Turn on real-time collaboration first.', 'gutenberg-sync-engines' ),
						'token'    => __( 'Could not get a credential from WordPress.', 'gutenberg-sync-engines' ),
						/* translators: %s: the WebSocket URL tested. */
						'timeout'  => __( 'No answer from %s within five seconds.', 'gutenberg-sync-engines' ),
						/* translators: %s: the WebSocket URL tested. */
						'refused'  => __( 'Could not connect to %s from this browser.', 'gutenberg-sync-engines' ),
						/* translators: %s: the WebSocket URL tested. */
						'ok'       => __( 'Connected to %s.', 'gutenberg-sync-engines' ),
					)
				)
			);
		}
	}
}
