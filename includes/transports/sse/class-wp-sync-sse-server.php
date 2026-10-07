<?php
/**
 * SSE over ordinary authenticated WordPress REST requests.
 *
 * @package GutenbergSyncEngines
 * @since 0.0.2
 */

/**
 * Authenticated receive streams backed by durable room cursors. A stream
 * sleeps on Redis notices when a Redis address is configured and reachable,
 * and on half-second storage checks otherwise; everything else about the
 * stream is the same.
 *
 * @since 0.0.2
 */
class WP_Sync_SSE_Server extends WP_HTTP_Polling_Sync_Server {
	/**
	 * Transport slug.
	 *
	 * @var string Transport slug.
	 */
	const TRANSPORT_SLUG = 'sse';

	/**
	 * What this request's stream sleeps on.
	 *
	 * @var WP_Sync_Change_Waiter|null What this request's stream sleeps on.
	 */
	protected $subscriber;

	/**
	 * The stream's room requests with their current cursors.
	 *
	 * @var array The stream's room requests with their current cursors.
	 */
	protected $stream_rooms = array();

	/**
	 * The awareness map last sent per room, for the storage waiter's compare
	 * on a storage without version counters.
	 *
	 * @var array<string, array> The awareness map last sent per room.
	 */
	protected $stream_awareness = array();

	/**
	 * The room version counters as read just BEFORE the stream's last
	 * storage read, so a write landing during that read still reads as a
	 * change afterwards (an extra read is harmless; a missed one would wait
	 * for the catch-up).
	 *
	 * @var array<string, string|null> Room => counter at the last snapshot.
	 */
	protected $stream_versions = array();

	/**
	 * Transport slug.
	 *
	 * @return string Transport slug.
	 */
	public function get_slug(): string {
		return self::TRANSPORT_SLUG;
	}

	/** Register a POST stream so cookies, REST nonces, and room schemas apply. */
	public function register_routes(): void {
		register_rest_route(
			self::REST_NAMESPACE,
			'/sse',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'handle_request' ),
				'permission_callback' => array( $this, 'check_permissions' ),
				'validate_callback'   => array( $this, 'validate_request' ),
				'args'                => $this->get_route_args(),
			)
		);
		add_filter( 'rest_pre_serve_request', array( $this, 'serve' ), 10, 4 );
	}

	/**
	 * Subscribe BEFORE the initial catch-up read, closing the check/wait race.
	 * Writes use /updates; streaming requests must never replay a write.
	 *
	 * @param WP_REST_Request $request Validated request.
	 * @return WP_REST_Response|WP_Error Initial response, or normal JSON error.
	 */
	public function handle_request( WP_REST_Request $request ) {
		foreach ( $request['rooms'] as $room ) {
			if ( ! empty( $room['updates'] ) ) {
				return new WP_Error( 'rest_sse_read_only', 'Send updates through the updates endpoint.', array( 'status' => 400 ) );
			}
		}
		$this->stream_rooms = $request['rooms'];

		/*
		 * Write this client's presence BEFORE the wait is opened, and publish
		 * it: the version snapshot and the Redis subscription then already
		 * include the stream's own write, so it cannot wake the first check
		 * (the parent's re-merge below finds nothing changed and skips the
		 * write). Peers get the presence notice a read earlier, too.
		 */
		foreach ( $request['rooms'] as $room ) {
			if ( is_array( $room['awareness'] ?? null ) ) {
				$this->update_awareness( (string) $room['room'], (int) $room['client_id'], $room['awareness'] );
			}
		}
		WP_Sync_Redis_Notifications::flush();
		$this->subscriber = $this->subscribe( array_column( $request['rooms'], 'room' ) );
		$response         = parent::handle_request( $request );
		if ( is_wp_error( $response ) ) {
			$this->subscriber->close();
			$this->subscriber = null;
		}
		return $response;
	}

	/**
	 * Open what the stream sleeps on: a Redis subscription when a Redis
	 * address is configured (or a Redis object cache is detected) and
	 * answers, else half-second checks of the rooms' version counters (a
	 * single lookup; a storage without counters is read the long way). A
	 * configured Redis that does not answer is reported, not fatal: the
	 * stream still works, at the checks' cost, and the browser never has to
	 * fall back to polling for it. Separate for deterministic unit tests.
	 *
	 * @param string[] $rooms Room names.
	 * @return WP_Sync_Change_Waiter What the stream sleeps on.
	 */
	protected function subscribe( array $rooms ): WP_Sync_Change_Waiter {
		$url = WP_Sync_Redis_Notifications::url();
		if ( '' !== $url ) {
			try {
				$redis = new WP_Sync_Redis( $url );
				$redis->subscribe( array_map( array( WP_Sync_Redis_Notifications::class, 'channel' ), array_unique( $rooms ) ) );
				return $redis;
			} catch ( RuntimeException $error ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', 'wp-sync: SSE stream falls back to storage checks: ' . $error->getMessage() );
				/**
				 * Fires when a configured Redis could not be reached for a stream.
				 *
				 * @since 0.0.2
				 * @param RuntimeException $error The failure.
				 */
				do_action( 'gutenberg_sync_engines_sse_redis_failed', $error );
			}
		}
		$this->snapshot_versions();
		return $this->storage_waiter(
			function (): bool {
				return $this->stream_has_new_data();
			}
		);
	}

	/**
	 * What this request's stream sleeps on, for the response header the
	 * benchmarks read: `redis` (a Pub/Sub notice), `version-cache` or
	 * `version-table` (the room version counters, in the object cache or
	 * the room-meta table), or `reads` (a storage without counters, read
	 * per room).
	 *
	 * @return string The wait kind.
	 */
	public function wait_kind(): string {
		if ( $this->subscriber instanceof WP_Sync_Redis ) {
			return 'redis';
		}
		if ( ! $this->storage_has_versions() ) {
			return 'reads';
		}
		return wp_using_ext_object_cache() ? 'version-cache' : 'version-table';
	}

	/**
	 * Whether the active storage keeps per-room version counters.
	 *
	 * @return bool True for the plugin's table storage.
	 */
	protected function storage_has_versions(): bool {
		return $this->storage instanceof WP_Sync_Table_Storage;
	}

	/**
	 * Records the rooms' version counters. Called right BEFORE a storage
	 * read, never after (see $stream_versions).
	 */
	protected function snapshot_versions(): void {
		if ( $this->storage_has_versions() ) {
			$this->stream_versions = $this->storage->get_room_versions( array_column( $this->stream_rooms, 'room' ) );
		}
	}

	/**
	 * The no-Redis wait. Separate so tests can replace its sleep.
	 *
	 * @param callable $has_changes Returns true when a watched room changed.
	 * @return WP_Sync_Storage_Change_Waiter The wait.
	 */
	protected function storage_waiter( callable $has_changes ): WP_Sync_Storage_Change_Waiter {
		return new WP_Sync_Storage_Change_Waiter( $has_changes );
	}

	/**
	 * Whether a watched room changed since the last snapshot: one lookup of
	 * the rooms' version counters (a memory read with a persistent object
	 * cache, one indexed query without). A storage without counters is
	 * asked the long way, per room: rows past the stream's cursor, or an
	 * awareness map other than the one last sent (the retired long-polling
	 * transport's check).
	 *
	 * @return bool True when the next read would carry something.
	 */
	protected function stream_has_new_data(): bool {
		// Clear only this process's cache, never the shared object cache.
		if ( function_exists( 'wp_cache_flush_runtime' ) ) {
			wp_cache_flush_runtime();
		}
		if ( $this->storage_has_versions() ) {
			if ( $this->storage->get_room_versions( array_column( $this->stream_rooms, 'room' ) ) !== $this->stream_versions ) {
				return true;
			}
			// A substitute backend's writes bump no counter, so its awareness is read.
			if ( ! WP_Sync_Awareness::has_substitute_backend() ) {
				return false;
			}
			foreach ( $this->stream_rooms as $room ) {
				if ( $this->awareness_changed( (string) $room['room'] ) ) {
					return true;
				}
			}
			return false;
		}
		foreach ( $this->stream_rooms as $room ) {
			$name   = (string) $room['room'];
			$engine = $this->engines->get_engine_for_room( $name );
			$result = $engine->get_updates_since( $name, (int) $room['client_id'], (int) $room['after'], array() );
			if ( ! empty( $result['updates'] ) || $this->awareness_changed( $name ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether a room's awareness differs from the map last sent.
	 *
	 * @param string $name Room identifier.
	 * @return bool True when the next read would carry new awareness.
	 */
	protected function awareness_changed( string $name ): bool {
		$current = array();
		foreach ( $this->awareness->entries( $name, self::AWARENESS_TIMEOUT ) as $entry ) {
			$current[ $entry['client_id'] ] = $entry['state'];
		}
		// phpcs:ignore Universal.Operators.StrictComparisons.LooseNotEqual, WordPress.PHP.YodaConditions.NotYoda -- Order-insensitive comparison intended.
		return $current != ( $this->stream_awareness[ $name ] ?? array() );
	}

	/**
	 * Stream only after REST has authenticated, validated, and dispatched.
	 *
	 * @param bool             $served Already served.
	 * @param WP_HTTP_Response $response Dispatched response.
	 * @param WP_REST_Request  $request Original request.
	 * @param WP_REST_Server   $server REST server.
	 * @return bool Whether the response was served.
	 */
	public function serve( $served, $response, $request, $server ): bool {
		if ( $served || '/wp-sync/v1/sse' !== $request->get_route() || ! $this->subscriber || 200 !== $response->get_status() ) {
			return (bool) $served;
		}
		$server->send_header( 'Content-Type', 'text/event-stream; charset=UTF-8' );
		$server->send_header( 'Cache-Control', 'no-cache, no-store, no-transform' );
		$server->send_header( 'X-Accel-Buffering', 'no' );
		$server->send_header( 'X-WP-Sync-SSE-Wait', $this->wait_kind() );
		// Disable PHP buffering; the host must also allow proxy streaming.
		while ( ob_get_level() > 0 ) {
			if ( ! ob_end_flush() ) {
				break;
			}
		}
		try {
			$this->stream(
				$request,
				$response->get_data(),
				function ( string $frame ): void {
				// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- SSE frames contain JSON, not HTML.
					echo $frame;
					flush();
				}
			);
		} finally {
			$this->subscriber->close();
			$this->subscriber = null;
		}
		return true;
	}

	/**
	 * Bounded streams reconnect and reauthorize. A kill needs no cleanup to
	 * preserve edits: the client resumes from its last applied storage cursor.
	 *
	 * @param WP_REST_Request $request Request carrying room cursors.
	 * @param array           $initial Initial catch-up result.
	 * @param callable        $emit Frame writer.
	 */
	public function stream( WP_REST_Request $request, array $initial, callable $emit ): void {
		$limit     = min( 300.0, max( 0.1, (float) apply_filters( 'wp_sync_sse_max_seconds', 300.0 ) ) );
		$php_limit = (int) ini_get( 'max_execution_time' );
		if ( $php_limit > 0 ) {
			$limit = min( $limit, max( 0.1, $php_limit - 5.0 ) );
		}
		$deadline    = $this->now() + $limit;
		$presence_at = $this->now() + 20.0;
		$rooms       = $request['rooms'];
		$data        = $initial;
		try {
			while ( true ) {
				$emit( "event: sync\ndata: " . wp_json_encode( $data ) . "\n\n" );
				foreach ( $data['rooms'] as $response ) {
					foreach ( $rooms as &$room ) {
						if ( $room['room'] === $response['room'] ) {
							$room['after'] = $response['end_cursor'];
						}
					}
					unset( $room );
					$this->stream_awareness[ $response['room'] ] = $response['awareness'] ?? array();
				}
				$this->stream_rooms = $rooms;
				WP_Sync_Redis_Notifications::flush();
				$catch_up_at = $this->now() + 20.0;
				do {
					$remaining = $deadline - $this->now();
					if ( $remaining <= 0 || connection_aborted() ) {
						return;
					}
					$changed = $this->subscriber->wait( max( 0.0, min( 5.0, $remaining, min( $catch_up_at, $presence_at ) - $this->now() ) ) );
					if ( ! $changed ) {
						$emit( ": keepalive\n\n" );
					}
				} while ( ! $changed && $this->now() < min( $catch_up_at, $presence_at ) );
				if ( connection_aborted() || $this->now() >= $deadline ) {
					return;
				}
				// Clear only this process's cache, never the shared object cache.
				if ( function_exists( 'wp_cache_flush_runtime' ) ) {
					wp_cache_flush_runtime();
				}
				foreach ( $rooms as $room ) {
					if ( ! $this->can_user_sync_room( $room['room'] ) ) {
						return;
					}
				}
				// Refresh only a still-present client, using its current state.
				// Never recreate presence removed by a leave or room reset. The
				// stream's own write goes BEFORE the version snapshot below, so
				// it cannot wake the next check.
				if ( $this->now() >= $presence_at ) {
					foreach ( $rooms as $room ) {
						foreach ( $this->awareness->entries( $room['room'], self::AWARENESS_TIMEOUT ) as $entry ) {
							if ( (int) $entry['client_id'] === (int) $room['client_id'] ) {
								$this->update_awareness( $room['room'], (int) $room['client_id'], $entry['state'] );
							}
						}
					}
					$presence_at = $this->now() + 20.0;
					WP_Sync_Redis_Notifications::flush();
				}
				$this->snapshot_versions();
				$data = array( 'rooms' => array() );
				foreach ( $rooms as $room ) {
					$engine                      = $this->engines->get_engine_for_room( $room['room'] );
					$response                    = $engine->get_updates_since( $room['room'], (int) $room['client_id'], (int) $room['after'], array() );
					$entries                     = $this->awareness->entries( $room['room'], self::AWARENESS_TIMEOUT );
					$response['awareness']       = self::awareness_map( $entries );
					$response['awareness_users'] = self::awareness_users( $entries );
					$response['generation']      = $this->room_generation( $room['room'], (int) $response['end_cursor'] );
					$data['rooms'][]             = $response;
				}
			}
		} catch ( RuntimeException $error ) {
			// End the response. Reconnect does a full cursor catch-up, even
			// if Redis restarted and discarded every notification.
			$emit( "event: retry\ndata: {}\n\n" );
		} finally {
			$this->stream_rooms     = array();
			$this->stream_awareness = array();
			$this->stream_versions  = array();
		}
	}
	/**
	 * Monotonic seconds, replaceable in tests without real waits.
	 *
	 * @return float Current time.
	 */
	protected function now(): float {
		return hrtime( true ) / 1e9;
	}
}
