<?php
/**
 * WP_HTTP_Polling_Sync_Server class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'WP_HTTP_Polling_Sync_Server' ) ) {

	/**
	 * HTTP short-polling transport for collaborative editing.
	 *
	 * The transport owns movement: routes, authentication, room permission
	 * checks, cursors, awareness, and request/response shape. The MEANING of
	 * update payloads is owned by the room's engine (WP_Sync_Engine, resolved
	 * through WP_Sync_Engine_Registry) — this class never interprets update
	 * data, so engines are swappable without transport changes.
	 *
	 * Engine mismatch protection: a client may stamp the engine it is
	 * speaking (`engine` / `engine_protocol` per room). If the stamp does not
	 * match the room's engine, or the room's storage lineage was written by a
	 * different engine, the request fails with 409 `rest_sync_engine_mismatch`
	 * and the client is expected to leave the session (falling back to a
	 * post lock). A room's lineage is fixed by its first write.
	 *
	 * @since 7.0.0
	 * @access private
	 */
	class WP_HTTP_Polling_Sync_Server implements WP_Sync_Transport {
		/**
		 * Transport slug (matches the client transport registration).
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const TRANSPORT_SLUG = 'http-polling';

		/**
		 * Transport protocol version.
		 *
		 * @since 7.2.0
		 * @var int
		 */
		const TRANSPORT_PROTOCOL = 1;

		/**
		 * REST API namespace.
		 *
		 * @since 7.0.0
		 * @var string
		 */
		const REST_NAMESPACE = 'wp-sync/v1';

		/**
		 * Awareness timeout in seconds. Clients that haven't updated
		 * their awareness state within this time are considered disconnected.
		 *
		 * @since 7.0.0
		 * @var int
		 */
		const AWARENESS_TIMEOUT = 30;

		/**
		 * Default rounding of awareness timestamps, in seconds. A poll that
		 * carries the same state inside the same bucket changes nothing, so
		 * the transport skips the write (see `awareness_timestamp()`).
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const AWARENESS_TIMESTAMP_GRANULARITY = 10;

		/**
		 * Room meta key of the room's generation token (see room_generation()).
		 * Write-once per room lifetime, which is why the table storage may
		 * serve it from the object cache (`WP_Sync_Table_Storage::GENERATION_KEY`
		 * names the same key).
		 *
		 * @since 0.0.1
		 */
		const GENERATION_META_KEY = 'generation';

		/**
		 * Maximum total size (in bytes) of the request body.
		 *
		 * @since 7.0.0
		 * @var int
		 */
		const MAX_BODY_SIZE = 16 * MB_IN_BYTES;

		/**
		 * Maximum number of rooms allowed per request.
		 *
		 * @since 7.0.0
		 * @var int
		 */
		const MAX_ROOMS_PER_REQUEST = 50;

		/**
		 * Maximum length of a single update data string.
		 *
		 * @since 7.0.0
		 * @var int
		 */
		const MAX_UPDATE_DATA_SIZE = MB_IN_BYTES;

		/**
		 * The cursor a request whose rows arrive separately reads from: past every row,
		 * so the read returns no stored rows but still reports the head.
		 *
		 * @since 0.0.2
		 */
		const READ_FROM_HEAD = PHP_INT_MAX;

		/**
		 * Storage backend for sync updates.
		 *
		 * @since 7.0.0
		 * @var WP_Sync_Storage
		 */
		protected WP_Sync_Storage $storage;

		/**
		 * Engine registry used to resolve the engine for each room.
		 *
		 * @since 7.2.0
		 * @var WP_Sync_Engine_Registry
		 */
		protected WP_Sync_Engine_Registry $engines;

		/**
		 * Constructor.
		 *
		 * @since 7.0.0
		 *
		 * @param WP_Sync_Storage                               $storage  Storage backend for sync updates.
		 * @param WP_Sync_Engine_Registry|null                  $engines  Engine registry. Defaults to a
		 *                                                                registry over the given storage.
		 * @param Gutenberg_Sync_Engines_Advisory_Presence|null $presence Presence lane deciding room
		 *                                                                lifetime. Defaults to the
		 *                                                                plugin's when available.
		 */
		public function __construct( WP_Sync_Storage $storage, ?WP_Sync_Engine_Registry $engines = null, ?Gutenberg_Sync_Engines_Advisory_Presence $presence = null ) {
			if ( null === $presence && class_exists( 'Gutenberg_Sync_Engines_Advisory_Presence' ) ) {
				$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
			}
			$this->presence  = $presence;
			$this->storage   = $storage;
			$this->engines   = $engines ?? new WP_Sync_Engine_Registry( $storage );
			$this->awareness = new WP_Sync_Awareness( $storage );
		}

		/**
		 * Who is in a room, over whichever store serves this request.
		 *
		 * @since 0.0.2
		 * @var WP_Sync_Awareness
		 */
		protected WP_Sync_Awareness $awareness;

		/**
		 * The presence lane deciding room lifetime (join/leave resets), or
		 * null when the plugin's presence class is unavailable.
		 *
		 * @since 0.0.1
		 * @var Gutenberg_Sync_Engines_Advisory_Presence|null
		 */
		protected $presence;

		/**
		 * The presence lane this transport consults for room lifetime.
		 *
		 * @since 0.0.1
		 *
		 * @return Gutenberg_Sync_Engines_Advisory_Presence|null
		 */
		public function get_presence(): ?Gutenberg_Sync_Engines_Advisory_Presence {
			return $this->presence;
		}

		/**
		 * The transport slug.
		 *
		 * @since 7.2.0
		 *
		 * @return string Slug.
		 */
		public function get_slug(): string {
			return self::TRANSPORT_SLUG;
		}

		/**
		 * The transport protocol version.
		 *
		 * @since 7.2.0
		 *
		 * @return int Protocol version.
		 */
		public function get_protocol_version(): int {
			return self::TRANSPORT_PROTOCOL;
		}

		/**
		 * Registers REST API routes.
		 *
		 * @since 7.0.0
		 */
		public function register_routes(): void {
			register_rest_route(
				self::REST_NAMESPACE,
				'/updates',
				array(
					'methods'             => array( WP_REST_Server::CREATABLE ),
					'callback'            => array( $this, 'handle_request' ),
					'permission_callback' => array( $this, 'check_permissions' ),
					'validate_callback'   => array( $this, 'validate_request' ),
					'args'                => $this->get_route_args(),
				)
			);
		}

		/**
		 * The shared route argument schema (the `rooms[]` payload). Extracted
		 * so transport variants — e.g. the SSE stream route — validate an
		 * identical request shape.
		 *
		 * @since 7.2.0
		 *
		 * @return array Route args.
		 */
		protected function get_route_args(): array {
			$typed_update_args = array(
				'properties' => array(
					'data' => array(
						'type'      => 'string',
						'required'  => true,
						'maxLength' => self::MAX_UPDATE_DATA_SIZE,
					),
					'type' => array(
						'type'     => 'string',
						'required' => true,
						'enum'     => $this->engines->get_all_update_types(),
					),
				),
				'required'   => true,
				'type'       => 'object',
			);

			$room_args = array(
				'after'                    => array(
					'minimum'  => 0,
					'required' => true,
					'type'     => 'integer',
				),
				'awareness'                => array(
					'required' => true,
					'type'     => array( 'object', 'null' ),
				),
				'client_id'                => array(
					'minimum'  => 1,
					'required' => true,
					'type'     => 'integer',
				),
				// Optional engine handshake stamp: when present, the request
				// fails with 409 unless it matches the room's engine.
				'engine'                   => array(
					'required' => false,
					'type'     => 'string',
				),
				// Debug envelope opt-in (see the sync inspector).
				'debug'                    => array(
					'required' => false,
					'type'     => 'boolean',
				),
				// A send made beside an open stream (the SSE transport): the
				// request stores its updates and is answered with the verdicts
				// and the room's head cursor, but no stored rows. See
				// process_room_request().
				'rows_received_separately' => array(
					'required' => false,
					'type'     => 'boolean',
				),
				'engine_protocol'          => array(
					'minimum'  => 1,
					'required' => false,
					'type'     => 'integer',
				),
				// The tab's presence token (Gutenberg_Sync_Engines_Advisory_Presence):
				// a tab's first request with it is its join, which under the
				// default policy resets a per-post room nobody else is in.
				'presence_token'           => array(
					'required'  => false,
					'type'      => 'string',
					'maxLength' => 64,
				),
				'room'                     => array(
					'required' => true,
					'type'     => 'string',
					'pattern'  => '^[^/]+/[^/:]+(?::\\S+)?$',
				),
				'updates'                  => array(
					'items'    => $typed_update_args,
					'minItems' => 0,
					'required' => true,
					'type'     => 'array',
				),
			);

			return array(
				'rooms'    => array(
					'items'    => array(
						'properties' => $room_args,
						'type'       => 'object',
					),
					'maxItems' => self::MAX_ROOMS_PER_REQUEST,
					'required' => true,
					'type'     => 'array',
				),
				// The advisory channel's signaling probe (per-tab token and
				// handshake messages), answered alongside the rooms so an
				// active poll loop is a faster carrier than the heartbeat.
				// See Gutenberg_Sync_Engines_Advisory_Presence.
				'advisory' => array(
					'type'     => 'object',
					'required' => false,
				),
			);
		}

		/**
		 * Checks if the current user has permission to access a room.
		 *
		 * @since 7.0.0
		 *
		 * @param WP_REST_Request $request The REST request.
		 * @return bool|WP_Error True if user has permission, otherwise WP_Error with details.
		 */
		public function check_permissions( WP_REST_Request $request ) {
			// Minimum cap check. Is user logged in with a contributor role or higher?
			if ( ! current_user_can( 'edit_posts' ) ) {
				return new WP_Error(
					'rest_cannot_edit',
					__( 'You do not have permission to perform this action', 'gutenberg' ),
					array( 'status' => rest_authorization_required_code() )
				);
			}

			$rooms           = $request['rooms'];
			$wp_user_id      = get_current_user_id();
			$forbidden_rooms = array();

			foreach ( $rooms as $room ) {
				$client_id = $room['client_id'];
				$room      = $room['room'];

				if ( $this->is_client_id_owned_by_another_user( $room, $client_id, $wp_user_id ) ) {
					return new WP_Error(
						'rest_cannot_edit',
						__( 'Client ID is already in use by another user.', 'gutenberg' ),
						array( 'status' => 403 )
					);
				}

				$parsed_room = WP_Sync_Config::parse_room( $room );
				if ( null === $parsed_room || ! WP_Sync_Config::can_user_sync_entity_type( $parsed_room['entity_kind'], $parsed_room['entity_name'], $parsed_room['object_id'] ) ) {
					$forbidden_rooms[] = $room;
				}
			}

			if ( ! empty( $forbidden_rooms ) ) {
				return new WP_Error(
					'rest_cannot_edit',
					sprintf(
						/* translators: %s: Comma-separated list of room names. */
						__( 'You do not have permission to sync one or more entities: %s.', 'gutenberg' ),
						implode( ', ', $forbidden_rooms )
					),
					array(
						'status' => rest_authorization_required_code(),
						'rooms'  => $forbidden_rooms,
					)
				);
			}

			return true;
		}

		/**
		 * Validates that the request body does not exceed the maximum allowed size.
		 *
		 * Runs as the route-level validate_callback, after per-arg schema
		 * validation has already passed.
		 *
		 * @since 7.0.0
		 *
		 * @param WP_REST_Request $request The REST request.
		 * @return true|WP_Error True if valid, WP_Error if the body is too large.
		 */
		public function validate_request( WP_REST_Request $request ) {
			$body = $request->get_body();
			if ( is_string( $body ) && strlen( $body ) > self::MAX_BODY_SIZE ) {
				return new WP_Error(
					'rest_sync_body_too_large',
					__( 'Request body is too large.', 'gutenberg' ),
					array( 'status' => 413 )
				);
			}

			return true;
		}

		/**
		 * Handles request: stores sync updates and awareness data, and returns
		 * updates the client is missing.
		 *
		 * @since 7.0.0
		 *
		 * @param WP_REST_Request $request The REST request.
		 * @return WP_REST_Response|WP_Error Response object or error.
		 */
		public function handle_request( WP_REST_Request $request ) {
			$rooms    = $request['rooms'];
			$response = array(
				'rooms' => array(),
			);

			foreach ( $rooms as $room_request ) {
				$room_response = $this->process_room_request( $room_request );
				if ( is_wp_error( $room_response ) ) {
					return $room_response;
				}
				$response['rooms'][] = $room_response;
			}

			$probe = $request->get_param( 'advisory' );
			if ( is_array( $probe ) && class_exists( 'Gutenberg_Sync_Engines_Advisory_Presence' ) ) {
				$answer = ( new Gutenberg_Sync_Engines_Advisory_Presence( $this->storage ) )->answer_probe( $probe );
				if ( null !== $answer ) {
					$response['advisory'] = $answer;
				}
			}

			return new WP_REST_Response( $response, 200 );
		}

		/**
		 * Processes ONE room request through its engine and returns the room
		 * response array (updates + awareness + optional dispositions). This
		 * is the transport-agnostic core of a sync exchange: it decodes
		 * nothing, delegating meaning to the engine. Both the REST transports
		 * and the out-of-band WebSocket daemon drive rooms through here, so
		 * every transport applies the same engine mismatch fencing, awareness
		 * merge, ingest, and catch-up.
		 *
		 * @since 7.2.0
		 *
		 * @param array $room_request One room's request payload (after, awareness,
		 *                            client_id, room, updates, and optional
		 *                            engine/engine_protocol/debug).
		 * @return array|WP_Error Room response, or WP_Error (engine mismatch / ingest error).
		 */
		public function process_room_request( array $room_request ) {
			$awareness = $room_request['awareness'] ?? null;
			$client_id = (int) $room_request['client_id'];
			$cursor    = (int) $room_request['after'];
			$room      = (string) $room_request['room'];
			$updates   = $room_request['updates'] ?? array();

			/*
			 * Room lifetime: a tab's FIRST request carrying its presence token
			 * is its join. If nobody else is in this per-post room, the
			 * room's unsaved content belongs to no one still here and is
			 * reset to the saved post before anything else happens (lineage
			 * included, so the mismatch check below sees a fresh room). See
			 * docs/plan/room-lifetime.md.
			 */
			$presence_token = $room_request['presence_token'] ?? '';
			if ( null !== $this->presence && is_string( $presence_token ) && '' !== $presence_token ) {
				$this->presence->note_sync_request( $room, $presence_token, $client_id );
			}

			$engine = $this->engines->get_engine_for_room( $room );

			$mismatch = $this->check_engine_mismatch( $engine, $room, $room_request, $updates );
			if ( is_wp_error( $mismatch ) ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: engine mismatch for {$room} (client speaks another engine)" );
				return $mismatch;
			}

			// Merge awareness state.
			$awareness_entries = $this->process_awareness_update( $room, $client_id, $awareness );
			$merged_awareness  = self::awareness_map( $awareness_entries );

			$context = array(
				'awareness' => $merged_awareness,

				/*
				 * Debug envelope opt-in: the client's inspector sets `debug`
				 * per room; honored only when the site allows it (room
				 * permission was already enforced by the transport). Engines
				 * that support it attach `_debug` to their room response.
				 */
				'debug'     => ! empty( $room_request['debug'] ) && self::is_debug_allowed(),
			);

			// Engine ingests this client's updates.
			$ingest = $engine->handle_updates( $room, $client_id, $cursor, $updates, $context );
			if ( is_wp_error( $ingest ) ) {
				return $ingest;
			}

			/*
			 * Engine produces the catch-up payload for this client. A
			 * client receiving over an open stream (`rows_received_separately: true`) gets
			 * no stored rows here: the stream is the only path that
			 * delivers them and moves its cursor, so nothing is delivered
			 * twice or skipped. Reading from past the head still refreshes
			 * the storage's cursor cache (`end_cursor` is the head this
			 * write produced, which the client waits for on the stream) and
			 * still returns what an engine synthesizes for this client and
			 * never stores (de-rtc's fetch answer). The same far-cursor read
			 * is what WP_De_RTC_Autosave_Commits uses to mark a cursor.
			 */
			$read_cursor = ! empty( $room_request['rows_received_separately'] ) ? self::READ_FROM_HEAD : $cursor;

			$room_response                    = $engine->get_updates_since( $room, $client_id, $read_cursor, $context );
			$room_response['awareness']       = $merged_awareness;
			$room_response['awareness_users'] = self::awareness_users( $awareness_entries );

			$generation = $this->room_generation( $room, (int) ( $room_response['end_cursor'] ?? 0 ) );
			if ( null !== $generation ) {
				$room_response['generation'] = $generation;
			}

			// Engines that produce per-update dispositions (an intent log's
			// applied/escalated/voided outcomes) surface them; relay-style
			// engines omit the key entirely.
			if ( isset( $ingest['dispositions'] ) && null !== $ingest['dispositions'] ) {
				$room_response['dispositions'] = $ingest['dispositions'];
			}

			return $room_response;
		}

		/**
		 * The room's generation token, minted on the first read after the
		 * room's first row is written and stable until the room is reset.
		 *
		 * A reset (`WP_Sync_Storage::reset_room()`) deletes every row and
		 * every room-meta key, so the next read finds no token and mints a
		 * fresh one — and a client that bootstrapped under the old token
		 * knows its rows and cursor are gone. The token is derived from the
		 * id of the room's FIRST stored row where the storage exposes it
		 * (racing first readers derive the same value), else a random id.
		 * Rooms without rows have no generation yet (nothing to restart).
		 *
		 * Shared with the WebSocket daemon, which stamps its pushed frames
		 * the same way.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room       Room identifier.
		 * @param int    $end_cursor The room's current cursor (0 = no rows).
		 * @return string|null The generation token, or null when the room has
		 *                     no rows or the storage keeps no room meta.
		 */
		public function room_generation( string $room, int $end_cursor ): ?string {
			if (
				$end_cursor <= 0 ||
				! method_exists( $this->storage, 'get_room_meta' ) ||
				! method_exists( $this->storage, 'set_room_meta' )
			) {
				return null;
			}

			$stored = $this->storage->get_room_meta( $room, self::GENERATION_META_KEY );
			if ( is_string( $stored ) && '' !== $stored ) {
				return $stored;
			}

			$generation = $this->derive_room_generation( $room );
			$this->storage->set_room_meta( $room, self::GENERATION_META_KEY, $generation );
			return $generation;
		}

		/**
		 * Derives a fresh generation token for a room that has rows but no
		 * token yet. With the plugin's table storage and the framework's
		 * postmeta storage the id of the room's first row is used: it is
		 * unique per genesis (ids are site-wide monotonic) and identical for
		 * two first readers racing to mint it. Other storages get a random
		 * id.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return string Generation token.
		 */
		private function derive_room_generation( string $room ): string {
			if ( $this->storage instanceof WP_Sync_Table_Storage ) {
				$first_row = (int) $this->storage->peek_room( $room )['first_cursor'];
				if ( $first_row > 0 ) {
					return 'g' . $first_row;
				}
			}

			if ( $this->storage instanceof WP_Sync_Post_Meta_Storage ) {
				global $wpdb;

				// phpcs:disable WordPress.DB.DirectDatabaseQuery -- Read-only lookups against the storage post; the storage class exposes no first-row accessor and its own accessors bypass the meta cache the same way.
				$post_id = (int) $wpdb->get_var(
					$wpdb->prepare(
						"SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_type = %s ORDER BY ID ASC LIMIT 1",
						md5( $room ),
						WP_Sync_Post_Meta_Storage::POST_TYPE
					)
				);
				if ( $post_id > 0 ) {
					$first_row = (int) $wpdb->get_var(
						$wpdb->prepare(
							"SELECT MIN(meta_id) FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s",
							$post_id,
							WP_Sync_Post_Meta_Storage::SYNC_UPDATE_META_KEY
						)
					);
					// phpcs:enable WordPress.DB.DirectDatabaseQuery
					if ( $first_row > 0 ) {
						return 'g' . $first_row;
					}
				}
			}

			return wp_generate_uuid4();
		}

		/**
		 * The engine registry this transport drives rooms through (shared by
		 * out-of-band transports such as the WebSocket daemon).
		 *
		 * @since 7.2.0
		 *
		 * @return WP_Sync_Engine_Registry Engine registry.
		 */
		public function get_engine_registry(): WP_Sync_Engine_Registry {
			return $this->engines;
		}

		/**
		 * The storage backend (shared by out-of-band transports).
		 *
		 * @since 7.2.0
		 *
		 * @return WP_Sync_Storage Storage backend.
		 */
		public function get_storage(): WP_Sync_Storage {
			return $this->storage;
		}

		/**
		 * Per-room permission check for an array-shaped request (the REST
		 * permission callback's engine-agnostic core), so out-of-band
		 * transports enforce the same access rules.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room Room identifier.
		 * @return bool Whether the current user may sync the room.
		 */
		public function can_user_sync_room( string $room ): bool {
			$parsed = WP_Sync_Config::parse_room( $room );
			return null !== $parsed && WP_Sync_Config::can_user_sync_entity_type(
				$parsed['entity_kind'],
				$parsed['entity_name'],
				$parsed['object_id']
			);
		}

		/**
		 * Whether a room's live awareness already records the client id for
		 * a different user. Such a client id is refused: taking it would let
		 * one user overwrite or remove another user's awareness entry.
		 * Shared by the REST permission callback and out-of-band transports.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $user_id   The user asking for the client id.
		 * @return bool Whether another user owns the client id.
		 */
		public function is_client_id_owned_by_another_user( string $room, int $client_id, int $user_id ): bool {
			foreach ( $this->awareness->entries( $room, self::AWARENESS_TIMEOUT ) as $entry ) {
				if ( $client_id === (int) $entry['client_id'] && $user_id !== (int) $entry['wp_user_id'] ) {
					return true;
				}
			}
			return false;
		}

		/**
		 * Merges (or, with a null update, removes) a client's awareness in a
		 * room and returns the current awareness map. Exposed so out-of-band
		 * transports can refresh presence and drop it on disconnect.
		 *
		 * @since 7.2.0
		 *
		 * @param string     $room             Room identifier.
		 * @param int        $client_id        Client identifier.
		 * @param array|null $awareness_update Awareness state, or null to remove.
		 * @return array Current awareness map.
		 */
		public function update_awareness( string $room, int $client_id, ?array $awareness_update ): array {
			return self::awareness_map( $this->process_awareness_update( $room, $client_id, $awareness_update ) );
		}

		/**
		 * The awareness map a room response carries: client id to state.
		 *
		 * @since n.e.x.t
		 *
		 * @param array<int, array<string, mixed>> $entries Awareness entries.
		 * @return array<int, array<string, mixed>> Map of client ID to awareness state.
		 */
		public static function awareness_map( array $entries ): array {
			$map = array();
			foreach ( $entries as $entry ) {
				$map[ $entry['client_id'] ] = $entry['state'];
			}
			return $map;
		}

		/**
		 * Which person each awareness entry belongs to: client id to
		 * WordPress user id. Sent beside the awareness map, so a client can
		 * tell another person from its own other tabs. The state itself is
		 * left as the client wrote it.
		 *
		 * @since n.e.x.t
		 *
		 * @param array<int, array<string, mixed>> $entries Awareness entries.
		 * @return array<int, int> Map of client ID to user ID.
		 */
		public static function awareness_users( array $entries ): array {
			$users = array();
			foreach ( $entries as $entry ) {
				$users[ $entry['client_id'] ] = (int) $entry['wp_user_id'];
			}
			return $users;
		}

		/**
		 * Whether debug envelopes may be attached to room responses.
		 *
		 * @since 7.2.0
		 *
		 * @return bool Allowed state.
		 */
		private static function is_debug_allowed(): bool {
			$default = defined( 'SCRIPT_DEBUG' ) && SCRIPT_DEBUG;

			/**
			 * Filters whether sync debug envelopes are allowed. The room
			 * permission check has already run; this gates only the extra
			 * diagnostic detail.
			 *
			 * @since 7.2.0
			 *
			 * @param bool $allowed Defaults to SCRIPT_DEBUG.
			 */
			return (bool) apply_filters( 'wp_sync_debug_enabled', $default );
		}

		/**
		 * Enforces engine consistency for a room.
		 *
		 * Two checks, both failing with 409 `rest_sync_engine_mismatch`:
		 *
		 * 1. Client stamp: when the request carries `engine` /
		 *    `engine_protocol` for the room, they must match the engine the
		 *    server resolved. A stale tab speaking yesterday's engine is
		 *    fenced here, before any of its updates are stored.
		 * 2. Storage lineage: a room's first write stamps the engine slug;
		 *    later writes through a different engine are rejected even if the
		 *    site configuration changed mid-session. Mixed-engine payloads in
		 *    one room would be mutual garbage — the lineage check makes the
		 *    swap scenario degrade to a post lock instead of corruption.
		 *
		 * One healing exception to check 2: a room that holds no per-post
		 * entity content (collection and taxonomy rooms — rebuildable
		 * change-feeds over durable database state, e.g.
		 * `taxonomy/wp_pattern_category`) is RESET instead of fenced when a
		 * client that provably speaks the newly-resolved engine arrives.
		 * Those rooms are global and permanent, so without the reset a
		 * site-level engine switch would leave them conflicted forever —
		 * there is no "new post, new room" escape hatch and no post lock to
		 * degrade to. Per-post entity rooms keep the strict fence: they can
		 * hold unsaved collaborative content, and their sessions degrade to
		 * the post lock by design.
		 *
		 * @since 7.2.0
		 *
		 * @param WP_Sync_Engine       $engine       Engine resolved for the room.
		 * @param string               $room         Room identifier.
		 * @param array<string, mixed> $room_request The room's request payload.
		 * @param array<int, mixed>    $updates      Updates the client wants to store.
		 * @return true|WP_Error True when consistent, WP_Error on mismatch.
		 */
		private function check_engine_mismatch( WP_Sync_Engine $engine, string $room, array $room_request, array $updates ) {
			$mismatch = null;

			if ( isset( $room_request['engine'] ) && $room_request['engine'] !== $engine->get_slug() ) {
				$mismatch = $room_request['engine'];
			} elseif ( isset( $room_request['engine_protocol'] ) && $room_request['engine_protocol'] !== $engine->get_protocol_version() ) {
				$mismatch = $engine->get_slug() . ' protocol ' . $room_request['engine_protocol'];
			} else {
				$lineage = $this->storage->get_room_engine( $room );
				if ( null !== $lineage && $lineage !== $engine->get_slug() ) {
					if ( $this->reset_switched_room( $room, $room_request, $engine->get_slug() ) ) {
						// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
						do_action( 'qm/debug', "wp-sync: reset room {$room} (lineage {$lineage} superseded by {$engine->get_slug()})" );
						$lineage = null;
					} else {
						$mismatch = $lineage;
					}
				}
				if ( null === $mismatch && null === $lineage && count( $updates ) > 0 ) {
					// First write fixes the room's engine lineage. Failure to
					// stamp is not fatal: the next write retries.
					$this->storage->set_room_engine( $room, $engine->get_slug() );
				}
			}

			if ( null === $mismatch ) {
				return true;
			}

			return new WP_Error(
				'rest_sync_engine_mismatch',
				sprintf(
					/* translators: 1: Room identifier. 2: Sync engine identifier. */
					__( 'Sync engine mismatch for room %1$s: the room requires engine %2$s.', 'gutenberg' ),
					$room,
					$engine->get_slug() . ' v' . $engine->get_protocol_version()
				),
				array(
					'status'          => 409,
					'room'            => $room,
					'engine'          => $engine->get_slug(),
					'engine_protocol' => $engine->get_protocol_version(),
				)
			);
		}

		/**
		 * Resets a room whose stored lineage was superseded by a site-level
		 * engine switch, when that is safe. See check_engine_mismatch() for
		 * the policy; the conditions are:
		 *
		 * - The requesting client PROVABLY speaks the newly-resolved engine
		 *   (its request stamps that exact slug — a stale tab or an old
		 *   client that stamps nothing never triggers a reset).
		 * - The room is not a per-post entity room (those can hold unsaved
		 *   collaborative content and keep the strict fence). Collection and
		 *   taxonomy rooms are rebuildable from durable database state.
		 * - The storage supports `reset_room()` (the framework storage
		 *   does; feature-detected so a substitute backend without one
		 *   keeps the fence instead).
		 *
		 * @since 0.2.0
		 *
		 * @param string               $room          Room identifier.
		 * @param array<string, mixed> $room_request  The room's request payload.
		 * @param string               $resolved_slug Engine slug the server resolved.
		 * @return bool Whether the room was reset.
		 */
		private function reset_switched_room( string $room, array $room_request, string $resolved_slug ): bool {
			if ( ( $room_request['engine'] ?? null ) !== $resolved_slug ) {
				return false;
			}

			$parsed = WP_Sync_Config::parse_room( $room );
			if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
				return false;
			}

			// The framework storage implements reset_room; a substitute
			// backend without one simply keeps the fence (no reset).
			if ( method_exists( $this->storage, 'reset_room' ) ) {
				return (bool) $this->storage->reset_room( $room );
			}

			return false;
		}

		/**
		 * The `updated_at` an awareness entry written now carries: the
		 * current time rounded UP to the next multiple of the granularity.
		 * Two polls inside one bucket produce identical entries, so the
		 * second one has nothing to write; the entry is still expired by
		 * `AWARENESS_TIMEOUT` seconds after the bucket, at most one bucket
		 * later than it would be with exact timestamps.
		 *
		 * @since 0.0.1
		 *
		 * @param int $now Current Unix time.
		 * @return int Rounded Unix time.
		 */
		public static function awareness_timestamp( int $now ): int {
			/**
			 * Filters how coarsely awareness timestamps are rounded, in
			 * seconds. 1 disables the rounding (every poll writes).
			 *
			 * @since 0.0.1
			 *
			 * @param int $granularity Rounding step in seconds. Default 10.
			 */
			$granularity = (int) apply_filters( 'wp_sync_awareness_timestamp_granularity', self::AWARENESS_TIMESTAMP_GRANULARITY );
			if ( $granularity < 1 ) {
				$granularity = 1;
			}
			return (int) ceil( $now / $granularity ) * $granularity;
		}

		/**
		 * Processes and stores an awareness update from a client.
		 *
		 * @since 7.0.0
		 *
		 * @param string                    $room             Room identifier.
		 * @param int                       $client_id        Client identifier.
		 * @param array<string, mixed>|null $awareness_update Awareness state sent by the client.
		 * @return array<int, array<string, mixed>> The room's awareness entries.
		 */
		private function process_awareness_update( string $room, int $client_id, ?array $awareness_update ): array {
			// A null update is this client leaving the room.
			$updated_awareness = null === $awareness_update
				? $this->awareness->forget( $room, $client_id, self::AWARENESS_TIMEOUT )
				: $this->awareness->put( $room, $client_id, $awareness_update, get_current_user_id(), self::AWARENESS_TIMEOUT );

			return $updated_awareness;
		}
	}
}
