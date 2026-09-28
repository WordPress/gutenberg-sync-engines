<?php
/**
 * Tests for the de-rtc announce model (Tier 3, stage 1): the
 * transport carries advisories, not documents. Accepted proposals store
 * content-less ANNOUNCE rows; canonical content lives once in room meta;
 * a behind client's `fetch` row is answered with ONE synthesized (never
 * stored) snapshot.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcAnnounce extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * Post ID used for room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	private function proposal( string $proposal_id, string $base_version, string $proposed ): array {
		return array(
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
			'data' => wp_json_encode(
				array(
					'proposalId'      => $proposal_id,
					'baseVersion'     => $base_version,
					'proposedContent' => $proposed,
					'clientUpdate'    => null,
				)
			),
		);
	}

	private function fetch_row( string $have_version ): array {
		return array(
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_FETCH,
			'data' => wp_json_encode( array( 'haveVersion' => $have_version ) ),
		);
	}

	public function test_accepted_proposal_stores_an_announce_row_without_content() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha edited under the announce model.', $this->genesis() );
		$result   = $engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-1', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $result['dispositions'][0]['version'] );

		$response  = $this->engine()->get_updates_since( $this->room(), 202, 0, array() );
		$announces = array();
		foreach ( $response['updates'] as $update ) {
			if ( WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE === $update['type'] ) {
				$announces[] = json_decode( $update['data'], true );
			}
			// The transport never carries the document in stored rows: only
			// the genesis snapshot (a bootstrap necessity) has content.
			if ( WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT !== $update['type'] ) {
				$this->assertArrayNotHasKey( 'content', (array) json_decode( $update['data'], true ), 'Only snapshot rows may carry content under the announce model.' );
			}
		}

		$this->assertCount( 1, $announces );
		$announce = $announces[0];
		$this->assertSame( 'v2', $announce['version'] );
		$this->assertSame( 'v1', $announce['baseVersion'] );
		$this->assertSame( 'p-1', $announce['proposalId'] );
		$this->assertSame( 101, $announce['authorClientId'] );
		$this->assertArrayNotHasKey( 'content', $announce );
		$this->assertSame( wp_de_rtc_hash_content( $proposed ), $announce['contentHash'], 'The announce hash is the canonicalized content hash — the client advances by comparing it.' );
	}

	public function test_fetch_returns_one_synthesized_snapshot_only_when_behind() {
		$engine   = $this->engine();
		$proposed = str_replace( 'Beta block original text.', 'Beta advanced.', (string) $engine->materialize( $this->room() ) );
		$engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-2', 'v1', $proposed ) ), array() );

		// Behind (has v1): the fetch is answered with current canonical.
		$engine->handle_updates( $this->room(), 202, 0, array( $this->fetch_row( 'v1' ) ), array() );
		$response  = $engine->get_updates_since( $this->room(), 202, PHP_INT_MAX, array() );
		$snapshots = array_values(
			array_filter(
				$response['updates'],
				static function ( $update ) {
					return WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT === $update['type'];
				}
			)
		);
		$this->assertCount( 1, $snapshots );
		$snapshot = json_decode( $snapshots[0]['data'], true );
		$this->assertSame( 'v2', $snapshot['version'] );
		$this->assertStringContainsString( 'Beta advanced.', $snapshot['content'] );
		$this->assertTrue( $snapshot['ephemeral'] );

		// The synthesized snapshot is never stored: a fresh read from the
		// same cursor without a fetch sees no snapshot.
		$again = $this->engine()->get_updates_since( $this->room(), 202, PHP_INT_MAX, array() );
		$this->assertSame( array(), $again['updates'] );

		// Caught up (has v2): the fetch is a no-op.
		$engine2 = $this->engine();
		$engine2->handle_updates( $this->room(), 202, 0, array( $this->fetch_row( 'v2' ) ), array() );
		$caught_up = $engine2->get_updates_since( $this->room(), 202, PHP_INT_MAX, array() );
		$this->assertSame( array(), $caught_up['updates'] );
	}

	public function test_a_fetch_sent_beside_an_open_stream_is_answered_with_the_snapshot_and_nothing_stored() {
		// The client's send lane under SSE: `rows_received_separately: true`. The stored
		// rows (genesis, announces) are the stream's to deliver; the
		// never-stored fetch answer rides the send's own response.
		update_option( 'wp_sync_engine', WP_De_RTC_Engine::SLUG );
		try {
			$engine   = $this->engine();
			$proposed = str_replace( 'Beta block original text.', 'Beta advanced.', (string) $engine->materialize( $this->room() ) );
			$engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-3', 'v1', $proposed ) ), array() );

			$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
			$request->set_body_params(
				array(
					'rooms' => array(
						array(
							'after'                    => 0,
							'awareness'                => array( 'name' => 'b' ),
							'client_id'                => 202,
							'rows_received_separately' => true,
							'room'                     => $this->room(),
							'updates'                  => array( $this->fetch_row( 'v1' ) ),
						),
					),
				)
			);
			$response = rest_get_server()->dispatch( $request );
			$this->assertSame( 200, $response->get_status() );
			$data = $response->get_data()['rooms'][0];

			$this->assertCount( 1, $data['updates'], 'Exactly the synthesized answer, no stored rows.' );
			$this->assertSame( WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT, $data['updates'][0]['type'] );
			$snapshot = json_decode( $data['updates'][0]['data'], true );
			$this->assertSame( 'v2', $snapshot['version'] );
			$this->assertTrue( $snapshot['ephemeral'] );
			$this->assertGreaterThan( 0, $data['end_cursor'], 'The head the stream must reach before the answer applies.' );
		} finally {
			delete_option( 'wp_sync_engine' );
		}
	}

	public function test_announce_rows_stay_small_as_the_document_grows() {
		$engine  = $this->engine();
		$content = (string) $engine->materialize( $this->room() );

		// Grow the document substantially, then make one more edit.
		$paragraphs = array( $content );
		for ( $i = 0; $i < 40; $i++ ) {
			$paragraphs[] = "<!-- wp:paragraph -->\n<p>Filler paragraph {$i} with a reasonable amount of text to give the document real size.</p>\n<!-- /wp:paragraph -->";
		}
		$grown  = implode( "\n\n", $paragraphs );
		$result = $engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-grow', 'v1', $grown ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$edited = str_replace( 'Filler paragraph 39', 'Filler paragraph 39 EDITED', $grown );
		$result = $engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-edit', 'v2', $edited ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$response           = $this->engine()->get_updates_since( $this->room(), 202, 0, array() );
		$max_announce_bytes = 0;
		foreach ( $response['updates'] as $update ) {
			if ( WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE === $update['type'] ) {
				$max_announce_bytes = max( $max_announce_bytes, strlen( $update['data'] ) );
			}
		}
		$this->assertGreaterThan( 0, $max_announce_bytes );
		$this->assertLessThan(
			1024,
			$max_announce_bytes,
			'Announce rows must not scale with document size (the pre-announce row-size cliff).'
		);
		$this->assertGreaterThan( 4000, strlen( $edited ), 'The document is genuinely larger than any announce row.' );
	}

	public function test_convergence_via_announce_and_fetch_round_trip() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// Client A edits; client B (bootstrapped at v1) sees the announce,
		// fetches, and lands its own edit against the fetched version.
		$a_edit = str_replace( 'Alpha block original text.', 'Alpha by A.', $this->genesis() );
		$engine->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-a', 'v1', $a_edit ) ), array() );

		$engine->handle_updates( $this->room(), 202, 0, array( $this->fetch_row( 'v1' ) ), array() );
		$fetched  = $engine->get_updates_since( $this->room(), 202, PHP_INT_MAX, array() );
		$snapshot = json_decode( $fetched['updates'][0]['data'], true );
		$this->assertSame( 'v2', $snapshot['version'] );

		$b_edit = str_replace( 'Beta block original text.', 'Beta by B.', (string) $snapshot['content'] );
		$result = $engine->handle_updates( $this->room(), 202, 0, array( $this->proposal( 'p-b', 'v2', $b_edit ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$final = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha by A.', $final );
		$this->assertStringContainsString( 'Beta by B.', $final );
	}

	/**
	 * The room's genesis content: the saved post with every block stamped
	 * with its deterministic identity (what the room actually serves).
	 *
	 * @return string Stamped genesis content.
	 */
	private function genesis(): string {
		return WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, self::$post_id );
	}
}
