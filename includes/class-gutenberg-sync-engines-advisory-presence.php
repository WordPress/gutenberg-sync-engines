<?php
/**
 * Gutenberg_Sync_Engines_Advisory_Presence class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Advisory_Presence' ) ) {

	/**
	 * The signaling service behind the advisory channel: who is in a
	 * post's room, tab by tab, and a mailbox that carries the WebRTC
	 * handshake between those tabs. Both ride the heartbeat WordPress
	 * already sends from every editor screen, so no new request cadence is
	 * added to the site.
	 *
	 * Every editor tab gets a per-tab token, stamped when the page renders,
	 * refreshed on every heartbeat, removed by a leave beacon on `pagehide`,
	 * and expired after PRESENCE_TTL if the tab never beats again. The
	 * heartbeat answer lists the OTHER tokens in the room (discovery), says
	 * whether anyone else is present (tokens plus live sync awareness), and
	 * delivers the handshake messages addressed to this tab. The transports
	 * use the answer to decide when to go quiet, when to poll on a timer,
	 * and when to poll only on demand (see docs/plan/advisory-channel.md).
	 *
	 * The tokens also decide a per-post room's LIFETIME (the "unsaved
	 * changes" policy, docs/plan/room-lifetime.md). Under the default
	 * policy the saved post is the only durable copy: a room is reset to a
	 * fresh genesis from the saved post — its unsaved edits discarded,
	 * exactly as the editor's unsaved-changes warning promised — when the
	 * last tab leaves (eager, via the beacon or a closed socket) or when a
	 * new tab arrives and finds nobody else there (lazy, covering crashes
	 * and expired tokens). Under the "keep" policy rooms live on as a
	 * shared working copy and nothing here resets them.
	 *
	 * Tokens live in a transient keyed by the room and mailboxes in options
	 * rows updated by compare-and-swap, both outside the sync storage on
	 * purpose: a presence read must never create a room's storage post
	 * (the storage API's own room lookup does).
	 *
	 * @since 0.0.1
	 */
	final class Gutenberg_Sync_Engines_Advisory_Presence {
		/**
		 * Key used in both directions of the heartbeat payload. Mirrors
		 * HEARTBEAT_DATA_KEY in src/providers/advisory/signaling.ts.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const HEARTBEAT_KEY = 'gutenberg_sync_engines_advisory';

		/**
		 * REST namespace and route of the leave beacon.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const REST_NAMESPACE   = 'gutenberg-sync-engines/v1';
		const REST_LEAVE_ROUTE = '/advisory/leave';

		/**
		 * Storage name prefixes; the room hash (and, for mailboxes, the
		 * recipient token) is appended.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const TOKENS_TRANSIENT_PREFIX = 'gse_adv_tokens_';
		const MAILBOX_OPTION_PREFIX   = 'gse_adv_mail_';
		const SWEEP_TRANSIENT_PREFIX  = 'gse_adv_swept_';

		/**
		 * How often a room's abandoned mailbox rows are swept, in seconds.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const SWEEP_INTERVAL = 60;

		/**
		 * How long a token counts as a live tab, in seconds. A hidden tab's
		 * heartbeat slows to a hard 120 seconds, so a live-but-hidden tab
		 * must survive at least two of those beats. Normal closes never wait
		 * this out: the leave beacon removes the token at once.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const PRESENCE_TTL = 300;

		/**
		 * How long the token transient itself lives past the last write.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const TOKENS_TRANSIENT_EXPIRY = 600;

		/**
		 * How long an undelivered handshake message waits, in seconds. A
		 * recipient beats at least every 120 seconds unless suspended; a
		 * message older than this is stale (its sender has moved on).
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const MAILBOX_EXPIRY = 90;

		/**
		 * Caps that bound transient sizes and per-beat work.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const MAX_TOKENS_PER_ROOM   = 50;
		const MAX_BLOCK_BYTES       = 128;
		const MAX_MAILBOX_ENTRIES   = 50;
		const MAX_SIGNALS_PER_BEAT  = 40;
		const MAX_SIGNAL_ID_LENGTH  = 96;
		const CAS_ATTEMPTS          = 8;
		const MAX_SIGNAL_DATA_BYTES = 16384;
		const MAX_TOKEN_LENGTH      = 64;

		/**
		 * Default cap on advisory peers per tab. A full mesh is N(N-1)/2
		 * connections; above this the client stands the channel down and
		 * everyone polls.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const DEFAULT_MAX_PEERS = 8;

		/**
		 * Live-awareness window, in seconds. Mirrors the sync transports'
		 * AWARENESS_TIMEOUT: entries older than this count as disconnected.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const AWARENESS_TIMEOUT = 30;

		/**
		 * The handshake message kinds the mailbox relays.
		 *
		 * @since 0.0.1
		 * @var string[]
		 */
		const SIGNAL_KINDS = array( 'offer', 'answer', 'ice', 'bye' );

		/**
		 * The advisory channel's links (see channel()).
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const CHANNEL_WEBRTC    = 'webrtc-advisory';
		const CHANNEL_WEBSOCKET = 'websocket-advisory';

		/**
		 * The sync storage the live-awareness check reads (injected for
		 * tests; defaults to the plugin's).
		 *
		 * @since 0.0.1
		 * @var WP_Sync_Storage|null
		 */
		private $storage;

		/**
		 * Constructor.
		 *
		 * @since 0.0.1
		 *
		 * @param WP_Sync_Storage|null $storage Sync storage, or null for the plugin's.
		 */
		public function __construct( ?WP_Sync_Storage $storage = null ) {
			$this->storage = $storage;
		}

		/**
		 * Hooks the heartbeat filter and the leave route.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function register(): void {
			// The heartbeat can fire from any admin page, so the filter is
			// global; it is inert unless the payload carries our key.
			add_filter( 'heartbeat_received', array( $this, 'answer_heartbeat' ), 10, 2 );
			add_filter( 'heartbeat_settings', array( $this, 'filter_heartbeat_settings' ) );
			add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		}

		/**
		 * Sets Heartbeat's interval to the slow awareness cadence on the
		 * post editor screens when awareness rides the beat, so block
		 * names move at the configured pace. The discovery probe rides
		 * the same beat, so its cadence changes too. Heartbeat clamps to
		 * 1-3600 seconds.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $settings Heartbeat settings.
		 * @return array<string, mixed> Settings with the interval applied.
		 */
		public function filter_heartbeat_settings( $settings ): array {
			$settings = is_array( $settings ) ? $settings : array();
			if ( ! class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
				return $settings;
			}
			$interval = Gutenberg_Sync_Engines_Settings::awareness_interval();
			if ( $interval <= 0 || Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_HEARTBEAT !== Gutenberg_Sync_Engines_Settings::awareness_channel() ) {
				return $settings;
			}
			global $pagenow;
			if ( ! in_array( $pagenow, array( 'post.php', 'post-new.php' ), true ) ) {
				return $settings;
			}
			$settings['interval'] = max( 1, min( 3600, $interval ) );
			return $settings;
		}

		/**
		 * Whether the advisory channel is enabled on this site.
		 *
		 * @since 0.0.1
		 *
		 * @return bool Enabled state.
		 */
		public static function is_enabled(): bool {
			$enabled = true;
			if ( class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
				// The settings screen's choice. Independent of the transport
				// choice: the channel serves whenever short polling does,
				// which under a preferred transport (SSE, websocket)
				// is only while that transport is down.
				$enabled = '' !== Gutenberg_Sync_Engines_Settings::advisory_channel();
			}

			/**
			 * Filters whether editor tabs open the advisory channel (presence
			 * and "new rows" nudges between the tabs editing a post, over
			 * WebRTC or a socket to the sync daemon). When false, tabs keep
			 * the timer polling cadence.
			 *
			 * @since 0.0.1
			 *
			 * @param bool $enabled Defaults to the settings screen's choice.
			 */
			return (bool) apply_filters( 'gutenberg_sync_engines_advisory_enabled', $enabled );
		}

		/**
		 * The link the advisory channel uses on this site: `webrtc-advisory`
		 * (browser to browser, the default) or `websocket-advisory` (relayed
		 * by the sync daemon).
		 *
		 * @since 0.0.1
		 *
		 * @return string The link slug.
		 */
		public static function channel(): string {
			$channel = self::CHANNEL_WEBRTC;
			if ( class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
				$chosen  = Gutenberg_Sync_Engines_Settings::advisory_channel();
				$channel = '' === $chosen ? self::CHANNEL_WEBRTC : $chosen;
			}

			/**
			 * Filters the link the advisory channel uses: `webrtc-advisory`
			 * or `websocket-advisory`.
			 *
			 * @since 0.0.1
			 *
			 * @param string $channel Defaults to the settings screen's choice.
			 */
			$channel = (string) apply_filters( 'gutenberg_sync_engines_advisory_channel', $channel );
			return self::CHANNEL_WEBSOCKET === $channel ? self::CHANNEL_WEBSOCKET : self::CHANNEL_WEBRTC;
		}

		/**
		 * The ICE servers handed to the browser's RTCPeerConnection.
		 *
		 * @since 0.0.1
		 *
		 * @return array<int, array<string, mixed>> RTCIceServer-shaped entries.
		 */
		public static function ice_servers(): array {
			/**
			 * Filters the ICE servers used to connect editor tabs to each
			 * other. Defaults to a public STUN server; a TURN server may be
			 * added for networks that block direct connections, but is
			 * never required — tabs that cannot connect keep polling.
			 *
			 * @since 0.0.1
			 *
			 * @param array<int, array<string, mixed>> $servers RTCIceServer-shaped entries.
			 */
			$servers = apply_filters(
				'gutenberg_sync_engines_advisory_ice_servers',
				array( array( 'urls' => 'stun:stun.l.google.com:19302' ) )
			);
			return is_array( $servers ) ? array_values( $servers ) : array();
		}

		/**
		 * The per-tab settings injected when an editor page renders: the
		 * post's room, a fresh token (stamped as present right away, so a
		 * joiner is visible to the first tab's next heartbeat), whether
		 * anyone else is there, and the channel configuration. Null when the
		 * channel is disabled or the user may not sync the post.
		 *
		 * @since 0.0.1
		 *
		 * @param WP_Post $post The post being edited.
		 * @return array<string, mixed>|null Settings for the client, or null.
		 */
		public function editor_settings( WP_Post $post ): ?array {
			if ( ! self::is_enabled() ) {
				return null;
			}
			$room = 'postType/' . $post->post_type . ':' . $post->ID;
			if ( ! $this->can_probe_room( $room ) ) {
				return null;
			}
			$token = wp_generate_password( 32, false );
			$this->record_token( $room, $token, 0 );

			/**
			 * Filters the cap on advisory peers per tab.
			 *
			 * @since 0.0.1
			 *
			 * @param int $max_peers Defaults to 8.
			 */
			$max_peers = (int) apply_filters( 'gutenberg_sync_engines_advisory_max_peers', self::DEFAULT_MAX_PEERS );

			$channel  = self::channel();
			$settings = array(
				'room'          => $room,
				'token'         => $token,
				'othersPresent' => $this->others_present( $room, $token, 0 ),
				'channel'       => $channel,
				'leaveUrl'      => rest_url( self::REST_NAMESPACE . self::REST_LEAVE_ROUTE ),
				'nonce'         => wp_create_nonce( 'wp_rest' ),
			);
			if ( self::CHANNEL_WEBSOCKET === $channel ) {
				// The "WebSocket advisory server" setting, else the same
				// daemon and URL the websocket transport announces: the
				// daemon serves advisory sockets too.
				$settings['socketUrl'] = class_exists( 'Gutenberg_Sync_Engines_Settings' )
					? Gutenberg_Sync_Engines_Settings::advisory_websocket_url()
					: ( class_exists( 'WP_WebSocket_Sync_Transport' ) ? WP_WebSocket_Sync_Transport::get_socket_url() : '' );
			} else {
				$settings['iceServers'] = self::ice_servers();
				$settings['maxPeers']   = max( 1, $max_peers );
			}
			return $settings;
		}

		/**
		 * Answers a heartbeat probe: refreshes the tab's token, files the
		 * handshake messages it sent, and reports the other tabs in the
		 * room plus this tab's mailbox.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $response The heartbeat response being built.
		 * @param mixed $data     The data the client sent.
		 * @return mixed The response, with this lane's answer added.
		 */
		public function answer_heartbeat( $response, $data ) {
			if ( ! is_array( $response ) ) {
				$response = array();
			}
			if ( ! is_array( $data ) || ! isset( $data[ self::HEARTBEAT_KEY ] ) ) {
				return $response;
			}
			$answer = $this->answer_probe( $data[ self::HEARTBEAT_KEY ] );
			if ( null !== $answer ) {
				$response[ self::HEARTBEAT_KEY ] = $answer;
			}
			return $response;
		}

		/**
		 * Answers one probe, whichever request carried it (a heartbeat beat
		 * or a sync poll): refreshes the tab's token, files the handshake
		 * messages it sent, and reports the other tabs in the room plus
		 * this tab's mailbox. Null for a malformed, disabled, or
		 * unauthorized probe.
		 *
		 * A probe that carries a `block` key comes from a tab running slow
		 * awareness over Heartbeat (docs/awareness-high-latency.md): the
		 * value (a block identity, or null) is kept on the tab's token with
		 * the user's name and avatar, and the answer's peers then carry
		 * every other tab's `block`, `name`, and `avatar` too. Other
		 * probes neither store nor receive those.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $probe The probe payload.
		 * @return array<string, mixed>|null The answer, or null.
		 */
		public function answer_probe( $probe ): ?array {
			if ( ! is_array( $probe ) || empty( $probe['room'] ) || empty( $probe['token'] ) ) {
				return null;
			}
			$room  = (string) $probe['room'];
			$token = (string) $probe['token'];
			if ( ! self::is_enabled() || ! $this->valid_token( $token ) || ! $this->can_probe_room( $room ) ) {
				return null;
			}

			$client_id = isset( $probe['client_id'] ) ? absint( $probe['client_id'] ) : 0;
			$awareness = array_key_exists( 'block', $probe );
			$this->record_token( $room, $token, $client_id, false, $awareness ? self::sanitize_block( $probe['block'] ) : false );

			$tokens = $this->read_tokens( $room );
			if ( isset( $probe['signals'] ) && is_array( $probe['signals'] ) ) {
				$this->file_signals( $room, $token, $tokens, $probe['signals'] );
			}

			$peers = array();
			foreach ( $tokens as $peer_token => $entry ) {
				if ( $peer_token === $token ) {
					continue;
				}
				$peer = array(
					'token'     => (string) $peer_token,
					'client_id' => (int) $entry['c'],
					'user_id'   => (int) $entry['u'],
				);
				if ( $awareness ) {
					$peer['block']  = $entry['b'];
					$peer['name']   = $entry['n'];
					$peer['avatar'] = $entry['a'];
				}
				$peers[] = $peer;
			}

			return array(
				'others'  => count( $peers ) > 0 || $this->has_live_awareness_besides( $room, $client_id ),
				'peers'   => $peers,
				'signals' => $this->take_mailbox( $room, $token ),
				// The room's head cursor: a tab connected to every peer
				// polls only when it is behind this (rows from writers not
				// on the channel — scripts, WP-CLI, a dropped peer — reach it
				// on its next beat instead of a safety timer).
				'cursor'  => $this->head_cursor( $room ),
				// The engine the site resolves for this room: a tab with no
				// poll timer learns of a mid-session engine change from its
				// next beat and polls into the server's fence.
				'engine'  => $this->resolved_engine( $room ),
			);
		}

		/**
		 * The engine slug the site currently resolves for a room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return string Engine slug, or the empty string when unknown.
		 */
		private function resolved_engine( string $room ): string {
			if ( ! class_exists( 'WP_Sync_Engine_Registry' ) ) {
				return '';
			}
			$storage = $this->storage();
			if ( null === $storage ) {
				return '';
			}
			return (string) ( new WP_Sync_Engine_Registry( $storage ) )->get_engine_slug_for_room( $room );
		}

		/**
		 * The room's head cursor (its newest update row id), or 0 for a room
		 * that has no storage yet. Never creates the room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return int Head cursor.
		 */
		private function head_cursor( string $room ): int {
			return $this->probe_room( $room )['cursor'];
		}

		/**
		 * Whether anything is stored for the room (rows or room meta).
		 * Never creates the room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return bool
		 */
		private function room_exists( string $room ): bool {
			return $this->probe_room( $room )['found'];
		}

		/**
		 * A non-creating look at a room's storage: whether it exists and
		 * its head cursor. The storage API's own room lookup creates the
		 * room's storage post on the post-meta default (its callers are
		 * about to write), which presence must never do, so this reads
		 * around it: the plugin's table storage answers through its
		 * read-only probe; the post-meta default (kept when the tables
		 * could not be created) is read with two indexed lookups against
		 * its storage post.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room The room name.
		 * @return array{found: bool, cursor: int}
		 */
		private function probe_room( string $room ): array {
			global $wpdb;

			$storage = $this->storage();
			if ( $storage instanceof WP_Sync_Table_Storage ) {
				$peek = $storage->peek_room( $room );
				return array(
					'found'  => (bool) $peek['found'],
					'cursor' => (int) $peek['cursor'],
				);
			}

			$storage_post_id = $this->storage_post_id( $room );
			if ( null === $storage_post_id ) {
				return array(
					'found'  => false,
					'cursor' => 0,
				);
			}
			$meta_key = class_exists( 'WP_Sync_Post_Meta_Storage' ) ? WP_Sync_Post_Meta_Storage::SYNC_UPDATE_META_KEY : 'wp_sync_update_data';
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery -- One indexed MAX(); the storage API's cursor is a per-request cache filled only by a read.
			$cursor = (int) $wpdb->get_var(
				$wpdb->prepare(
					"SELECT MAX(meta_id) FROM $wpdb->postmeta WHERE post_id = %d AND meta_key = %s",
					$storage_post_id,
					$meta_key
				)
			);
			return array(
				'found'  => true,
				'cursor' => $cursor,
			);
		}

		/**
		 * Non-creating lookup of a room's storage post id under the
		 * framework's post-meta storage.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room The room name.
		 * @return int|null The storage post id, or null when nobody has synced.
		 */
		private function storage_post_id( string $room ): ?int {
			global $wpdb;

			$post_type = class_exists( 'WP_Sync_Post_Meta_Storage' ) ? WP_Sync_Post_Meta_Storage::POST_TYPE : 'wp_sync_storage';
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery -- Non-creating existence check; see docblock.
			$storage_post_id = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT ID FROM $wpdb->posts WHERE post_name = %s AND post_type = %s ORDER BY ID ASC LIMIT 1",
					md5( $room ),
					$post_type
				)
			);
			return empty( $storage_post_id ) ? null : (int) $storage_post_id;
		}

		/**
		 * Registers the leave beacon route.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function register_routes(): void {
			register_rest_route(
				self::REST_NAMESPACE,
				self::REST_LEAVE_ROUTE,
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'handle_leave' ),
					'permission_callback' => 'is_user_logged_in',
					'args'                => array(
						'room'      => array(
							'type'     => 'string',
							'required' => true,
						),
						'token'     => array(
							'type'     => 'string',
							'required' => true,
						),
						'client_id' => array(
							'type'     => 'integer',
							'required' => false,
							'minimum'  => 0,
						),
					),
				)
			);
		}

		/**
		 * A tab left its room: forget its token so peers stop counting it
		 * and stop trying to connect to it.
		 *
		 * @since 0.0.1
		 *
		 * @param WP_REST_Request $request The beacon request.
		 * @return WP_REST_Response The (empty) answer.
		 */
		public function handle_leave( WP_REST_Request $request ): WP_REST_Response {
			$room  = (string) $request->get_param( 'room' );
			$token = (string) $request->get_param( 'token' );
			$reset = false;
			if ( $this->valid_token( $token ) && $this->can_probe_room( $room ) ) {
				$reset = $this->leave( $room, $token, absint( $request->get_param( 'client_id' ) ) );
			}
			return new WP_REST_Response( array( 'reset' => $reset ), 200 );
		}

		/**
		 * A tab's sync request arrived carrying its presence token. The
		 * FIRST such request is the tab's join: if nobody else is in the
		 * room, whatever the room holds belongs to no one still here and,
		 * under the default policy, is reset to the saved post before the
		 * tab is served. Later requests from the same tab (including a
		 * re-bootstrap after a restart) never reset anything — that tab IS
		 * the room's participant.
		 *
		 * Called by the transports before the engine sees the request.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room      The room name.
		 * @param string $token     The tab's presence token.
		 * @param int    $client_id The tab's sync client id.
		 * @return bool Whether the room was reset.
		 */
		public function note_sync_request( string $room, string $token, int $client_id ): bool {
			if ( ! $this->valid_token( $token ) || ! $this->is_entity_room( $room ) ) {
				return false;
			}

			$tokens = $this->read_tokens( $room );
			$joined = ! empty( $tokens[ $token ]['j'] );
			$this->record_token( $room, $token, $client_id, true );
			if ( $joined ) {
				return false;
			}

			if ( $this->others_present( $room, $token, $client_id ) ) {
				return false;
			}

			return $this->reset_abandoned_room( $room, 'join' );
		}

		/**
		 * A tab left the room (the leave beacon, or a closed socket): forget
		 * its token, its pending mail, and its sync awareness. When it was
		 * the last one there, the room is reset to the saved post right away
		 * under the default policy, so a reload or a later opener lands on
		 * what was saved.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room      The room name.
		 * @param string $token     The tab's presence token.
		 * @param int    $client_id The tab's sync client id (0 when unknown).
		 * @return bool Whether the room was reset.
		 */
		public function leave( string $room, string $token, int $client_id ): bool {
			$this->forget_token( $room, $token );
			if ( ! $this->is_entity_room( $room ) ) {
				return false;
			}
			if ( $client_id > 0 ) {
				$this->forget_awareness( $room, $client_id );
			}
			if ( count( $this->read_tokens( $room ) ) > 0 || $this->has_live_awareness_besides( $room, $client_id ) ) {
				return false;
			}
			return $this->reset_abandoned_room( $room, 'leave' );
		}

		/**
		 * Whether empty per-post rooms are reset to the saved post (the
		 * default "discard" policy) or kept as a shared working copy.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return bool Whether an empty room is reset.
		 */
		public static function resets_empty_rooms( string $room ): bool {
			$enabled = true;
			if ( class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
				$enabled = Gutenberg_Sync_Engines_Settings::UNSAVED_KEEP !== (string) get_option( Gutenberg_Sync_Engines_Settings::UNSAVED_OPTION, Gutenberg_Sync_Engines_Settings::UNSAVED_DEFAULT );
			}

			/**
			 * Filters whether a per-post room is reset to the saved post when
			 * nobody is in it. Return false to keep rooms (and their unsaved
			 * edits) alive across sessions as a shared working copy.
			 *
			 * @since 0.0.1
			 *
			 * @param bool   $enabled Defaults to the settings screen's choice.
			 * @param string $room    The room name.
			 */
			return (bool) apply_filters( 'gutenberg_sync_engines_room_reset_when_empty', $enabled, $room );
		}

		/**
		 * Resets a per-post room nobody is in: rows, lineage, awareness and
		 * room meta go, and the next reader gets a fresh genesis built from
		 * the saved post (with a new generation token, so any client that
		 * still holds the old room learns of the restart).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room   The room name.
		 * @param string $reason 'join' or 'leave', for narration.
		 * @return bool Whether the room was reset.
		 */
		private function reset_abandoned_room( string $room, string $reason ): bool {
			if ( ! self::resets_empty_rooms( $room ) ) {
				return false;
			}
			$storage = $this->storage();
			if ( null === $storage || ! method_exists( $storage, 'reset_room' ) ) {
				return false;
			}
			// Nothing to reset: the room was never written. Avoid creating
			// the room just to wipe it.
			if ( ! $this->room_exists( $room ) ) {
				return false;
			}

			$reset = (bool) $storage->reset_room( $room );
			if ( $reset ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: room {$room} reset to the saved post (empty room, on {$reason})" );

				/**
				 * Fires after a per-post room was reset because nobody was in
				 * it. Engines that keep state outside the room's rows (de-rtc's
				 * canonical options row) forget it here.
				 *
				 * @since 0.0.1
				 *
				 * @param string $room   The room name.
				 * @param string $reason 'join' (a new tab found the room empty)
				 *                       or 'leave' (the last tab left).
				 */
				do_action( 'gutenberg_sync_engines_room_reset', $room, $reason );
			}
			return $reset;
		}

		/**
		 * Whether the room is a per-post entity room (the only kind whose
		 * lifetime these rules govern).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return bool
		 */
		private function is_entity_room( string $room ): bool {
			return (bool) preg_match( '#^postType/[^/:]+:\d+$#', $room );
		}

		/**
		 * The sync storage: the injected one, else the plugin's.
		 *
		 * @since 0.0.1
		 *
		 * @return WP_Sync_Storage|null
		 */
		private function storage(): ?WP_Sync_Storage {
			if ( null === $this->storage && function_exists( 'gutenberg_sync_engines_storage' ) ) {
				$this->storage = gutenberg_sync_engines_storage();
			}
			return $this->storage;
		}

		/**
		 * Removes one client's awareness entry (the leaving tab's), so peers
		 * see it go at once and the empty-room check does not count it.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room      The room name.
		 * @param int    $client_id The leaving client's id.
		 * @return void
		 */
		private function forget_awareness( string $room, int $client_id ): void {
			$storage = $this->storage();
			if ( null === $storage || ! $this->room_exists( $room ) ) {
				return;
			}
			( new WP_Sync_Awareness( $storage ) )->forget( $room, $client_id, self::AWARENESS_TIMEOUT );
		}

		/**
		 * Whether the current user may take part in a post's room. Only
		 * per-post entity rooms have an advisory channel; collection rooms
		 * ride along on the same tab's polls.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return bool Allowed state.
		 */
		private function can_probe_room( string $room ): bool {
			if ( ! class_exists( 'WP_Sync_Config' ) ) {
				return false;
			}
			$parsed = WP_Sync_Config::parse_room( $room );
			if ( null === $parsed || 'postType' !== $parsed['entity_kind'] || empty( $parsed['object_id'] ) ) {
				return false;
			}
			return WP_Sync_Config::can_user_sync_entity_type( $parsed['entity_kind'], $parsed['entity_name'], $parsed['object_id'] );
		}

		/**
		 * Whether a token is well-formed.
		 *
		 * @since 0.0.1
		 *
		 * @param string $token The token.
		 * @return bool Validity.
		 */
		private function valid_token( string $token ): bool {
			return '' !== $token && strlen( $token ) <= self::MAX_TOKEN_LENGTH && (bool) preg_match( '/^[A-Za-z0-9_-]+$/', $token );
		}

		/**
		 * Files the handshake messages one tab sent into the recipients'
		 * mailboxes. Recipients must be live tokens in the same room; the
		 * kind must be known; the payload is size-capped.
		 *
		 * @since 0.0.1
		 *
		 * @param string                           $room    The room name.
		 * @param string                           $from    The sender's token.
		 * @param array<string, array<string,int>> $tokens  Live tokens in the room.
		 * @param array<int, mixed>                $signals The messages sent.
		 * @return void
		 */
		private function file_signals( string $room, string $from, array $tokens, array $signals ): void {
			$count   = 0;
			$grouped = array();
			foreach ( $signals as $signal ) {
				if ( ++$count > self::MAX_SIGNALS_PER_BEAT ) {
					break;
				}
				if ( ! is_array( $signal ) || empty( $signal['to'] ) || empty( $signal['kind'] ) || ! isset( $signal['data'] ) ) {
					continue;
				}
				$to   = (string) $signal['to'];
				$kind = (string) $signal['kind'];
				$data = $signal['data'];
				if ( $to === $from || ! isset( $tokens[ $to ] ) || ! in_array( $kind, self::SIGNAL_KINDS, true ) ) {
					continue;
				}
				if ( ! is_string( $data ) || strlen( $data ) > self::MAX_SIGNAL_DATA_BYTES ) {
					continue;
				}
				$id               = isset( $signal['id'] ) && is_string( $signal['id'] ) && strlen( $signal['id'] ) <= self::MAX_SIGNAL_ID_LENGTH ? $signal['id'] : '';
				$grouped[ $to ][] = array(
					'id'   => $id,
					'from' => $from,
					'kind' => $kind,
					'data' => $data,
					't'    => time(),
				);
			}
			// One atomic append per recipient: trickled candidates arrive
			// several to a request.
			foreach ( $grouped as $to => $messages ) {
				$this->append_mail( $room, (string) $to, $messages );
			}
		}

		/**
		 * Appends one message to a recipient's mailbox, atomically: the
		 * mailbox is an options row updated by compare-and-swap
		 * (WP_Sync_Atomic_Option), so two senders filing at once cannot
		 * overwrite each other and a take cannot delete a message filed
		 * between its read and its write. Expired entries are dropped and
		 * the oldest past the cap.
		 *
		 * @since 0.0.1
		 *
		 * @param string                           $room     The room name.
		 * @param string                           $to       The recipient's token.
		 * @param array<int, array<string, mixed>> $messages The messages, oldest first.
		 * @return void
		 */
		private function append_mail( string $room, string $to, array $messages ): void {
			$name = $this->mailbox_key( $room, $to );
			for ( $attempt = 0; $attempt < self::CAS_ATTEMPTS; $attempt++ ) {
				$current = WP_Sync_Atomic_Option::read( $name );
				$mail    = array_merge( $this->decode_mail( $current ), $messages );
				if ( count( $mail ) > self::MAX_MAILBOX_ENTRIES ) {
					$mail = array_slice( $mail, -self::MAX_MAILBOX_ENTRIES );
				}
				if ( WP_Sync_Atomic_Option::swap( $name, (string) $current, (string) wp_json_encode( $mail ) ) ) {
					return;
				}
			}
		}

		/**
		 * Empties a tab's mailbox and returns the fresh messages in it. The
		 * swap to an empty box is atomic, so a message filed meanwhile is
		 * seen by the retry, never dropped.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room  The room name.
		 * @param string $token The tab's token.
		 * @return array<int, array<string, mixed>> Messages, oldest first.
		 */
		private function take_mailbox( string $room, string $token ): array {
			$name = $this->mailbox_key( $room, $token );
			for ( $attempt = 0; $attempt < self::CAS_ATTEMPTS; $attempt++ ) {
				$current = WP_Sync_Atomic_Option::read( $name );
				$mail    = $this->decode_mail( $current );
				if ( 0 === count( $mail ) ) {
					return array();
				}
				if ( ! WP_Sync_Atomic_Option::swap( $name, (string) $current, '[]' ) ) {
					continue;
				}
				$out = array();
				foreach ( $mail as $entry ) {
					$out[] = array(
						'id'   => (string) ( $entry['id'] ?? '' ),
						'from' => (string) $entry['from'],
						'kind' => (string) $entry['kind'],
						'data' => (string) $entry['data'],
					);
				}
				return $out;
			}
			return array();
		}

		/**
		 * Decodes a stored mailbox, dropping malformed and expired entries.
		 *
		 * @since 0.0.1
		 *
		 * @param string|null $stored The stored JSON, or null for none.
		 * @return array<int, array<string, mixed>> Live entries.
		 */
		private function decode_mail( ?string $stored ): array {
			$mail = '' !== (string) $stored ? json_decode( (string) $stored, true ) : array();
			if ( ! is_array( $mail ) ) {
				return array();
			}
			$now = time();
			return array_values(
				array_filter(
					$mail,
					static function ( $entry ) use ( $now ) {
						return is_array( $entry ) && isset( $entry['t'], $entry['from'], $entry['kind'], $entry['data'] ) && $now - (int) $entry['t'] < self::MAILBOX_EXPIRY;
					}
				)
			);
		}

		/**
		 * Deletes a tab's mailbox row (on leave).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room  The room name.
		 * @param string $token The tab's token.
		 * @return void
		 */
		private function delete_mailbox( string $room, string $token ): void {
			WP_Sync_Atomic_Option::delete( $this->mailbox_key( $room, $token ) );
		}

		/**
		 * The mailbox option name for one recipient.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room  The room name.
		 * @param string $token The recipient's token.
		 * @return string Option name.
		 */
		private function mailbox_key( string $room, string $token ): string {
			return self::mailbox_prefix( $room ) . md5( $token );
		}

		/**
		 * The option-name prefix shared by every mailbox of one room, so
		 * the room's rows can be listed without the token record.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return string Option-name prefix.
		 */
		private static function mailbox_prefix( string $room ): string {
			return self::MAILBOX_OPTION_PREFIX . md5( $room ) . '_';
		}

		/**
		 * The token transient name for one room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return string Transient name.
		 */
		private function tokens_key( string $room ): string {
			return self::TOKENS_TRANSIENT_PREFIX . md5( $room );
		}

		/**
		 * The live tokens in a room, expired entries dropped.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return array<string, array<string, int>> token => { t, u, c }.
		 */
		private function read_tokens( string $room ): array {
			$stored = get_transient( $this->tokens_key( $room ) );
			if ( ! is_array( $stored ) ) {
				return array();
			}
			$now  = time();
			$live = array();
			foreach ( $stored as $token => $entry ) {
				if ( ! is_array( $entry ) || ! isset( $entry['t'] ) || $now - (int) $entry['t'] >= self::PRESENCE_TTL ) {
					continue;
				}
				$live[ (string) $token ] = array(
					't' => (int) $entry['t'],
					'u' => isset( $entry['u'] ) ? (int) $entry['u'] : 0,
					'c' => isset( $entry['c'] ) ? (int) $entry['c'] : 0,
					'j' => ! empty( $entry['j'] ),
					// Slow awareness over Heartbeat: the block the tab is
					// in, and the name and avatar to draw it with.
					'b' => isset( $entry['b'] ) ? self::sanitize_block( $entry['b'] ) : null,
					'n' => isset( $entry['n'] ) ? (string) $entry['n'] : '',
					'a' => isset( $entry['a'] ) ? (string) $entry['a'] : '',
				);
			}
			return $live;
		}

		/**
		 * Records (or refreshes) a tab's token. A lost write under
		 * concurrent heartbeats only delays one refresh by a beat.
		 *
		 * @since 0.0.1
		 *
		 * @param string            $room      The room name.
		 * @param string            $token     The tab's token.
		 * @param int               $client_id The tab's sync client id (0 when unknown).
		 * @param bool              $joined    Whether this is a sync request (the tab's
		 *                                     join); kept once set.
		 * @param string|null|false $block     The block the tab reports being in
		 *                                     (slow awareness over Heartbeat): a
		 *                                     block identity, null for none, or
		 *                                     false when the probe carried no
		 *                                     block (the last known value stays).
		 * @return void
		 */
		private function record_token( string $room, string $token, int $client_id, bool $joined = false, $block = false ): void {
			$this->sweep_expired( $room );
			$tokens = $this->read_tokens( $room );
			$known  = $tokens[ $token ] ?? null;

			$tokens[ $token ] = array(
				't' => time(),
				'u' => get_current_user_id(),
				// Whether the tab has made a sync request (its join); kept
				// once set so a re-bootstrap never counts as a new join.
				'j' => $joined || ! empty( $known['j'] ),
				// A page-render stamp has no client id yet; keep the last
				// known one rather than regressing to 0.
				'c' => $client_id > 0 ? $client_id : ( $known['c'] ?? 0 ),
				'b' => false === $block ? ( $known['b'] ?? null ) : $block,
				'n' => $known['n'] ?? '',
				'a' => $known['a'] ?? '',
			);
			if ( false !== $block ) {
				// The name and avatar the peers draw the block with, looked
				// up once per beat here so receivers need nothing else.
				$user                  = wp_get_current_user();
				$tokens[ $token ]['n'] = (string) $user->display_name;
				$tokens[ $token ]['a'] = (string) get_avatar_url( $user->ID, array( 'size' => 48 ) );
			}

			if ( count( $tokens ) > self::MAX_TOKENS_PER_ROOM ) {
				uasort(
					$tokens,
					static function ( $a, $b ) {
						return $b['t'] <=> $a['t'];
					}
				);
				$tokens = array_slice( $tokens, 0, self::MAX_TOKENS_PER_ROOM, true );
			}

			set_transient( $this->tokens_key( $room ), $tokens, self::TOKENS_TRANSIENT_EXPIRY );
		}

		/**
		 * A block identity as a tab reports it: a short string, or null.
		 * Sync ids and editor client ids are both short (36-byte UUIDs);
		 * anything longer is not a block name this plugin minted. The
		 * server never interprets the value beyond this cap.
		 *
		 * @since 0.0.1
		 *
		 * @param mixed $value Submitted value.
		 * @return string|null The identity, or null when absent or unusable.
		 */
		private static function sanitize_block( $value ): ?string {
			if ( ! is_string( $value ) || '' === $value || strlen( $value ) > self::MAX_BLOCK_BYTES ) {
				return null;
			}
			return $value;
		}

		/**
		 * Deletes the mailbox rows of a room that belong to no live token
		 * (a crashed tab, a lost connection, a room everyone left long
		 * enough ago that even the token record expired). The rows are
		 * found by their room prefix, so nothing else has to remember
		 * them. Runs at most once a minute per room, on a token refresh.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room The room name.
		 * @return void
		 */
		private function sweep_expired( string $room ): void {
			global $wpdb;

			$flag = self::SWEEP_TRANSIENT_PREFIX . md5( $room );
			if ( false !== get_transient( $flag ) ) {
				return;
			}
			set_transient( $flag, 1, self::SWEEP_INTERVAL );

			$live = array();
			foreach ( array_keys( $this->read_tokens( $room ) ) as $token ) {
				$live[ $this->mailbox_key( $room, (string) $token ) ] = true;
			}

			// The rows live in the options table (the atomic-option class's
			// default backend); a substitute backend sweeps its own store.
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Listing by prefix; bypasses the options cache like the atomic-option class.
			$names = $wpdb->get_col(
				$wpdb->prepare(
					"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
					$wpdb->esc_like( self::mailbox_prefix( $room ) ) . '%'
				)
			);
			foreach ( (array) $names as $name ) {
				if ( ! isset( $live[ $name ] ) ) {
					WP_Sync_Atomic_Option::delete( (string) $name );
				}
			}
		}

		/**
		 * Removes a tab's token and its pending mail.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room  The room name.
		 * @param string $token The tab's token.
		 * @return void
		 */
		private function forget_token( string $room, string $token ): void {
			$tokens = $this->read_tokens( $room );
			unset( $tokens[ $token ] );
			if ( 0 === count( $tokens ) ) {
				delete_transient( $this->tokens_key( $room ) );
			} else {
				set_transient( $this->tokens_key( $room ), $tokens, self::TOKENS_TRANSIENT_EXPIRY );
			}
			$this->delete_mailbox( $room, $token );
		}

		/**
		 * Whether any OTHER tab or live sync session is in the room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room      The room name.
		 * @param string $token     This tab's token.
		 * @param int    $client_id This tab's sync client id (0 when unknown).
		 * @return bool Company.
		 */
		private function others_present( string $room, string $token, int $client_id ): bool {
			$tokens = $this->read_tokens( $room );
			unset( $tokens[ $token ] );
			if ( count( $tokens ) > 0 ) {
				return true;
			}
			return $this->has_live_awareness_besides( $room, $client_id );
		}

		/**
		 * Whether the room's sync awareness holds a live entry for someone
		 * other than the given client. Covers tabs without the presence
		 * lane (an older bundle, a different editor screen) that still poll.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room      The room name.
		 * @param int    $client_id This tab's sync client id (0 when unknown).
		 * @return bool Company.
		 */
		private function has_live_awareness_besides( string $room, int $client_id ): bool {
			foreach ( $this->read_awareness( $room ) as $entry ) {
				$entry_client = isset( $entry['client_id'] ) ? (int) $entry['client_id'] : 0;
				if ( 0 === $client_id || $entry_client !== $client_id ) {
					return true;
				}
			}
			return false;
		}

		/**
		 * Reads a room's LIVE awareness entries WITHOUT creating the room: on
		 * the post-meta default the storage API's own room lookup creates
		 * the storage post (its callers are about to write), which
		 * presence must never do, so the read is gated on the
		 * non-creating probe.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room name.
		 * @return array<int, array<string, mixed>> Awareness entries.
		 */
		private function read_awareness( string $room ): array {
			if ( ! $this->room_exists( $room ) ) {
				return array();
			}

			$storage = $this->storage();
			if ( null === $storage ) {
				return array();
			}

			return ( new WP_Sync_Awareness( $storage ) )->entries( $room, self::AWARENESS_TIMEOUT );
		}
	}
}
