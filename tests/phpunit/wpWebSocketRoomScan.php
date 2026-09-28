<?php
/**
 * Tests for the WebSocket daemon's out-of-band room scan: rows that land
 * through WEB requests (a de-rtc autosave commit, a healing lane) must
 * reach websocket subscribers even though no socket message touches the
 * room. Found by the post-inversion de-rtc/websocket fuzz: every seed
 * failed to converge because the daemon only pushed rows in reaction to
 * socket messages, and the announce inversion moved the entire de-rtc
 * content flow out-of-band.
 *
 * @package Gutenberg
 *
 * @group collaboration
 */
class Tests_Collaboration_WpWebSocketRoomScan extends WP_UnitTestCase {
	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->";

	/**
	 * A recording stand-in for WP_WebSocket_Connection: always open,
	 * captures every text frame the daemon sends.
	 *
	 * @return WP_WebSocket_Connection Recording connection.
	 */
	private function recording_connection(): WP_WebSocket_Connection {
		return new class() extends WP_WebSocket_Connection {
			/**
			 * Captured text frames.
			 *
			 * @var string[]
			 */
			public $sent = array();

			// phpcs:ignore Generic.CodeAnalysis.UselessOverridingMethod.Found -- Deliberately skips the parent's stream wiring.
			public function __construct() {
			}

			public function is_open(): bool {
				return true;
			}

			public function has_pending_writes(): bool {
				return false;
			}

			public function send_text( string $payload ): void {
				$this->sent[] = $payload;
			}

			public function send_ping( string $payload = '' ): void {
			}

			public function send_close( int $code = 1000, string $reason = '' ): void {
			}
		};
	}

	public function test_room_scan_pushes_out_of_band_rows_to_subscribers() {
		$editor_id = self::factory()->user->create( array( 'role' => 'editor' ) );
		wp_set_current_user( $editor_id );
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => $editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room    = 'postType/post:' . $post_id;

		update_option( 'wp_sync_engine', WP_De_RTC_Engine::SLUG );
		try {
			$storage = new WP_Sync_Table_Storage();
			$sync    = new WP_HTTP_Polling_Sync_Server( $storage );
			$server  = new WP_WebSocket_Sync_Server( $sync, '127.0.0.1', 8799 );

			// The subscriber joined and read genesis (its daemon-tracked
			// cursor sits at the genesis row).
			$bootstrap = $sync->process_room_request(
				array(
					'room'      => $room,
					'client_id' => 7,
					'after'     => 0,
					'awareness' => null,
					'updates'   => array(),
				)
			);
			$this->assertIsArray( $bootstrap );
			$cursor = (int) $bootstrap['end_cursor'];

			$conn    = $this->recording_connection();
			$clients = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'clients' );
			$clients->setAccessible( true );
			$clients->setValue(
				$server,
				array(
					1 => array(
						'closing'      => false,
						'conn'         => $conn,
						'connected_at' => microtime( true ),
						'cookie'       => '',
						'last_seen'    => microtime( true ),
						'rooms'        => array(
							$room => array(
								'client_id' => 7,
								'cursor'    => $cursor,
							),
						),
						// 0 skips the sweep's cookie revalidation — this
						// fake socket has no auth cookie to validate.
						'user_id'      => 0,
					),
				)
			);

			// An OUT-OF-BAND write: a de-rtc commit accepted through the
			// web process (the autosave endpoint drives this same engine
			// seam) — no socket message touches the daemon.
			$engine = new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
			$edited = str_replace( 'original', 'edited', self::GENESIS_CONTENT );
			$result = $engine->handle_updates(
				$room,
				9,
				$cursor,
				array(
					array(
						'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
						'data' => wp_json_encode(
							array(
								'proposalId'      => 'p-oob-1',
								'baseVersion'     => 'v1',
								'proposedContent' => $edited,
								'clientUpdate'    => null,
							)
						),
					),
				),
				array()
			);
			$this->assertNotWPError( $result );
			$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

			// Nothing was pushed yet, and no socket message will arrive.
			$this->assertSame( array(), $conn->sent );

			// Force the scan interval to have elapsed and run one tick.
			$scan_at = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'last_room_scan_at' );
			$scan_at->setAccessible( true );
			$scan_at->setValue( $server, 0.0 );
			$tick = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'tick' );
			$tick->setAccessible( true );
			$tick->invoke( $server );

			// The subscriber received the accepted commit's announce.
			$this->assertNotEmpty( $conn->sent, 'The room scan must push out-of-band rows.' );
			$payload = json_decode( $conn->sent[0], true );
			$this->assertSame( 'sync', $payload['type'] );
			$types = array_column( $payload['rooms'][0]['updates'], 'type' );
			$this->assertContains( WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE, $types );

			// The scan advanced the daemon's cursor: a second tick with
			// nothing new pushes nothing.
			$conn->sent = array();
			$scan_at->setValue( $server, 0.0 );
			$tick->invoke( $server );
			$this->assertSame( array(), $conn->sent, 'A quiet room must not be re-broadcast.' );
		} finally {
			delete_option( 'wp_sync_engine' );
			self::delete_user( $editor_id );
			wp_delete_post( $post_id, true );
		}
	}
}
