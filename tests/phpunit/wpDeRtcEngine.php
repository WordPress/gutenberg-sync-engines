<?php
/**
 * Engine-level tests for the DE-RTC sync engine (WP_De_RTC_Engine),
 * driving the production WP_Sync_Engine seam against the table storage
 * with real merge-core three-way merges.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcEngine extends WP_UnitTestCase {
	/**
	 * Editor user ID (has unfiltered_html on single site).
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * Author user ID (lacks unfiltered_html).
	 *
	 * @var int
	 */
	protected static $author_id;

	/**
	 * Post ID used for room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$author_id = $factory->user->create( array( 'role' => 'author' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'DE-RTC test post',
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$author_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	/**
	 * A fresh engine over a fresh storage instance — the per-request state
	 * boundary. Sharing the DB while resetting in-memory caches mimics
	 * separate HTTP requests.
	 *
	 * @return WP_De_RTC_Engine Engine.
	 */
	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Extracts the latest canonical version/content a client would track
	 * from a room response.
	 *
	 * @param array $response Room response from get_updates_since().
	 * @return array{version: string, content: string}|null Latest state.
	 */
	private function latest_from_response( array $response ): ?array {
		$latest        = null;
		$announced_seq = 0;
		foreach ( $response['updates'] as $update ) {
			$decoded = json_decode( $update['data'], true );
			if ( ! is_array( $decoded ) || ! is_string( $decoded['version'] ?? null ) ) {
				continue;
			}
			if ( WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE === ( $update['type'] ?? '' ) ) {
				$announced_seq = max( $announced_seq, (int) ltrim( $decoded['version'], 'v' ) );
				continue;
			}
			if ( is_string( $decoded['content'] ?? null ) ) {
				$latest = array(
					'version' => $decoded['version'],
					'content' => $decoded['content'],
				);
			}
		}

		/*
		 * Announce model: a newer version was announced without
		 * content — fetch it the way the session codec does (a `fetch` row
		 * answered by one synthesized snapshot).
		 */
		$latest_seq = null !== $latest ? (int) ltrim( (string) $latest['version'], 'v' ) : 0;
		if ( $announced_seq > $latest_seq ) {
			$engine = $this->engine();
			$engine->handle_updates(
				$this->room(),
				999,
				0,
				array(
					array(
						'type' => WP_De_RTC_Engine::UPDATE_TYPE_FETCH,
						'data' => wp_json_encode( array( 'haveVersion' => null !== $latest ? $latest['version'] : '' ) ),
					),
				),
				array()
			);
			$fetched = $engine->get_updates_since( $this->room(), 999, PHP_INT_MAX, array() );
			foreach ( $fetched['updates'] as $update ) {
				$decoded = json_decode( $update['data'], true );
				if ( is_array( $decoded ) && is_string( $decoded['version'] ?? null ) && is_string( $decoded['content'] ?? null ) ) {
					$latest = array(
						'version' => $decoded['version'],
						'content' => $decoded['content'],
					);
				}
			}
		}
		return $latest;
	}

	/**
	 * Builds a proposal update the way the client adapter does.
	 *
	 * @param string $proposal_id  Correlation id.
	 * @param string $base_version Base version label.
	 * @param string $base         Base content.
	 * @param string $proposed     Proposed content.
	 * @param bool   $with_update  Whether to attach the block-native update.
	 * @return array Typed update row.
	 */
	private function proposal( string $proposal_id, string $base_version, string $base, string $proposed, bool $with_update = true ): array {
		$payload = array(
			'proposalId'      => $proposal_id,
			'baseVersion'     => $base_version,
			'proposedContent' => $proposed,
			'clientUpdate'    => $with_update
				? wp_de_rtc_create_automerge_update_for_content_change( $base, $proposed, 'test-actor' )
				: null,
		);

		return array(
			'data' => wp_json_encode( $payload ),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
	}

	public function test_identity() {
		$engine = $this->engine();
		$this->assertSame( 'de-rtc', $engine->get_slug() );
		$this->assertSame( 2, $engine->get_protocol_version() );
		$this->assertSame( array( 'proposal', 'announce', 'fetch', 'snapshot', 'parked', 'resolved' ), $engine->get_update_types() );
	}

	public function test_genesis_snapshot_and_lineage() {
		$engine   = $this->engine();
		$storage  = new WP_Sync_Table_Storage();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );

		$this->assertGreaterThan( 0, $response['end_cursor'] );
		$this->assertNotEmpty( $response['updates'] );
		$this->assertSame( WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT, $response['updates'][0]['type'] );

		$genesis = json_decode( $response['updates'][0]['data'], true );
		$this->assertSame( 'v1', $genesis['version'] );
		$this->assertSame( $this->genesis(), $genesis['content'] );

		$this->assertSame( 'de-rtc', $storage->get_room_engine( $this->room() ) );
	}

	public function test_proposal_is_applied_and_broadcast() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$latest   = $this->latest_from_response( $response );

		$proposed = str_replace( 'Beta block original', 'Beta block CLIENT-EDITED', $latest['content'] );
		$result   = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-1', $latest['version'], $latest['content'], $proposed ) ),
			array()
		);

		$this->assertIsArray( $result );
		$this->assertCount( 1, $result['dispositions'] );
		$this->assertSame( 'p-1', $result['dispositions'][0]['intentId'] );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $result['dispositions'][0]['version'] );

		// A second client sees the accepted version.
		$peer_response = $this->engine()->get_updates_since( $this->room(), 2, 0, array() );
		$peer_latest   = $this->latest_from_response( $peer_response );
		$this->assertSame( 'v2', $peer_latest['version'] );
		$this->assertStringContainsString( 'Beta block CLIENT-EDITED', $peer_latest['content'] );

		$this->assertStringContainsString( 'Beta block CLIENT-EDITED', $this->engine()->materialize( $this->room() ) );
	}

	public function test_stale_base_proposal_merges_three_way() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );

		// Client A lands an Alpha edit (canonical moves to v2).
		$a_proposed = str_replace( 'Alpha block original', 'Alpha block A-EDITED', $genesis['content'] );
		$a_result   = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-a', $genesis['version'], $genesis['content'], $a_proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $a_result['dispositions'][0]['status'] );

		// Client B proposes a Beta edit still based on genesis v1: the server
		// rebases it over A's accepted edit via the three-way merge.
		$b_proposed = str_replace( 'Beta block original', 'Beta block B-EDITED', $genesis['content'] );
		$b_result   = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->proposal( 'p-b', $genesis['version'], $genesis['content'], $b_proposed ) ),
			array()
		);

		$this->assertSame( 'applied', $b_result['dispositions'][0]['status'] );
		$this->assertSame( 'v3', $b_result['dispositions'][0]['version'] );

		$materialized = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha block A-EDITED', $materialized );
		$this->assertStringContainsString( 'Beta block B-EDITED', $materialized );
	}

	public function test_conflicting_proposal_escalates() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );

		$a_proposed = str_replace( 'Alpha block original text', 'Alpha block A-REWRITE text', $genesis['content'] );
		$engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-a', $genesis['version'], $genesis['content'], $a_proposed ) ),
			array()
		);

		// B rewrites the SAME words from the same base: a genuine conflict.
		$b_proposed = str_replace( 'Alpha block original text', 'Alpha block B-REWRITE text', $genesis['content'] );
		$b_result   = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->proposal( 'p-b', $genesis['version'], $genesis['content'], $b_proposed ) ),
			array()
		);

		// The descriptor is validated once and dropped, so the
		// per-block salvage lane runs even for descriptor-carrying
		// proposals — the conflicted block parks, the (empty) remainder
		// lands, and canonical keeps A's accepted state.
		$this->assertSame( 'applied', $b_result['dispositions'][0]['status'] );
		$this->assertSame( 1, $b_result['dispositions'][0]['parkedBlocks'] ?? null );

		$this->assertStringContainsString( 'Alpha block A-REWRITE', $this->engine()->materialize( $this->room() ) );
		$this->assertStringNotContainsString( 'B-REWRITE', $this->engine()->materialize( $this->room() ) );
	}

	public function test_unknown_base_version_is_voided() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );

		$result = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-x', 'v999', $genesis['content'], $genesis['content'] . "\n" ) ),
			array()
		);

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'unknown-base-version', $result['dispositions'][0]['reason'] );
	}

	public function test_malformed_proposal_is_voided_per_row() {
		$engine = $this->engine();
		$engine->get_updates_since( $this->room(), 1, 0, array() );

		$result = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array(
				array(
					'data' => wp_json_encode( array( 'proposalId' => 'p-bad' ) ),
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
				),
				array(
					'data' => 'not json at all',
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
				),
			),
			array()
		);

		$this->assertIsArray( $result );
		// The correlatable row voids; the uncorrelatable row is dropped.
		$this->assertCount( 1, $result['dispositions'] );
		$this->assertSame( 'p-bad', $result['dispositions'][0]['intentId'] );
		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'invalid-payload', $result['dispositions'][0]['reason'] );
	}

	public function test_non_proposal_update_type_is_rejected() {
		$engine = $this->engine();
		$result = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array(
				array(
					'data' => '{}',
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE,
				),
			),
			array()
		);

		$this->assertWPError( $result );
		$this->assertSame( 'rest_invalid_update_type', $result->get_error_code() );
	}

	public function test_proposal_without_client_update_is_accepted() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$latest   = $this->latest_from_response( $response );

		$proposed = str_replace( 'Alpha block original', 'Alpha block PLAIN-EDITED', $latest['content'] );
		$result   = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-plain', $latest['version'], $latest['content'], $proposed, false ) ),
			array()
		);

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringContainsString( 'Alpha block PLAIN-EDITED', $this->engine()->materialize( $this->room() ) );
	}

	public function test_author_without_unfiltered_html_escalates_risky_content() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$latest   = $this->latest_from_response( $response );

		wp_set_current_user( self::$author_id );

		$proposed = $latest['content'] . "\n\n<!-- wp:html -->\n<script>alert(1)</script>\n<!-- /wp:html -->";
		$result   = $engine->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-risky', $latest['version'], $latest['content'], $proposed ) ),
			array()
		);

		// The descriptor is validated once and dropped, so the
		// kses sequestration lane runs even for descriptor-carrying
		// proposals: the risky new block drops from the laundered
		// content, the proposal applies, and the risky block parks.
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringNotContainsString( '<script>', $this->engine()->materialize( $this->room() ) );
		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );
	}

	public function test_canonical_state_survives_engine_instances() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$latest   = $this->latest_from_response( $response );

		$proposed = str_replace( 'Beta block original', 'Beta block PERSISTED', $latest['content'] );
		$engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-persist', $latest['version'], $latest['content'], $proposed ) ),
			array()
		);

		// A completely fresh engine (new request) reads the same canonical.
		$this->assertStringContainsString( 'Beta block PERSISTED', $this->engine()->materialize( $this->room() ) );
	}

	public function test_checkpoint_trims_history_and_floors_cursor() {
		add_filter( 'wp_sync_de_rtc_checkpoint_interval', $interval_filter = static fn() => 4 );
		try {
			$engine   = $this->engine();
			$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
			$latest   = $this->latest_from_response( $response );

			$content = $latest['content'];
			$version = $latest['version'];
			// Enough accepted proposals for TWO checkpoints (the first one
			// never trims — rows from the previous checkpoint onward are
			// always kept; the floor appears at the second).
			for ( $i = 1; $i <= 12; $i++ ) {
				$proposed = $content . "\n\n<!-- wp:paragraph -->\n<p>Row {$i}.</p>\n<!-- /wp:paragraph -->";
				$result   = $this->engine()->handle_updates(
					$this->room(),
					1,
					0,
					array( $this->proposal( 'p-' . $i, $version, $content, $proposed ) ),
					array()
				);
				$this->assertSame( 'applied', $result['dispositions'][0]['status'], "proposal {$i} should apply" );
				$version = $result['dispositions'][0]['version'];
				$content = $proposed;
			}

			$storage = new WP_Sync_Table_Storage();
			$floor   = $storage->get_room_meta( $this->room(), WP_De_RTC_Engine::META_FLOOR );
			$this->assertIsNumeric( $floor, 'compaction should have recorded a floor' );

			// A client behind the floor is clamped and still converges.
			$stale_response = $this->engine()->get_updates_since( $this->room(), 9, 1, array() );
			$stale_latest   = $this->latest_from_response( $stale_response );
			$this->assertNotNull( $stale_latest );
			$this->assertStringContainsString( 'Row 12.', $stale_latest['content'] );
		} finally {
			remove_filter( 'wp_sync_de_rtc_checkpoint_interval', $interval_filter );
		}
	}

	/**
	 * Builds a resolution row the way the RETIRED transport lane did —
	 * kept only to prove handle_updates() rejects it.
	 *
	 * @param string $proposal_id Parked proposal id.
	 * @param string $resolution  restored|dismissed.
	 * @return array Typed update row.
	 */
	private function resolution( string $proposal_id, string $resolution ): array {
		return array(
			'data' => wp_json_encode(
				array(
					'proposalId' => $proposal_id,
					'resolution' => $resolution,
				)
			),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED,
		);
	}

	/**
	 * Decoded rows of a type from a room response.
	 *
	 * @param array  $response Room response.
	 * @param string $type     Update type.
	 * @return array Decoded row payloads.
	 */
	private function rows_of_type( array $response, string $type ): array {
		$rows = array();
		foreach ( $response['updates'] as $update ) {
			if ( $type === $update['type'] ) {
				$rows[] = json_decode( $update['data'], true );
			}
		}
		return $rows;
	}

	/**
	 * Drives the standard two-client conflict so p-b's conflicted block
	 * parks (per-block salvage; the descriptor validates
	 * once and drops, so salvage runs for descriptor proposals too).
	 *
	 * @return array Genesis state the proposals were authored against.
	 */
	private function escalate_conflict(): array {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );

		$a_proposed = str_replace( 'Alpha block original text', 'Alpha block A-REWRITE text', $genesis['content'] );
		$engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-a', $genesis['version'], $genesis['content'], $a_proposed ) ),
			array()
		);

		$b_proposed = str_replace( 'Alpha block original text', 'Alpha block B-REWRITE text', $genesis['content'] );
		$b_result   = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->proposal( 'p-b', $genesis['version'], $genesis['content'], $b_proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $b_result['dispositions'][0]['status'] );
		$this->assertSame( 1, $b_result['dispositions'][0]['parkedBlocks'] ?? null );

		return $genesis;
	}

	public function test_escalated_conflict_parks_a_durable_review_row() {
		$this->escalate_conflict();

		$response = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$parked   = $this->rows_of_type( $response, WP_De_RTC_Engine::UPDATE_TYPE_PARKED );

		$this->assertCount( 1, $parked, 'the escalated proposal must park exactly one row' );
		$row = $parked[0];
		$this->assertSame( 'p-b', $row['proposalId'] );
		$this->assertSame( 'manual-conflict-required', $row['reason'] );
		$this->assertSame( 2, $row['authorClientId'] );
		$this->assertSame( self::$editor_id, $row['author'] );
		$this->assertIsArray( $row['changedBlocks'] );
		$this->assertCount( 1, $row['changedBlocks'], 'only the conflicting block changed against the base' );
		$this->assertSame( 0, $row['changedBlocks'][0]['index'] );
		$this->assertStringContainsString( 'B-REWRITE', $row['changedBlocks'][0]['html'] );
		$this->assertStringContainsString( 'B-REWRITE', $row['excerpt'] );
		$this->assertStringNotContainsString( '<', $row['excerpt'], 'the excerpt is plain text' );
	}

	public function test_kses_sequestration_drops_a_risky_new_block_and_parks_it() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 3, 0, array() );
		$latest   = $this->latest_from_response( $response );

		wp_set_current_user( self::$author_id );
		$proposed = $latest['content'] . "\n\n<!-- wp:html -->\n<script>alert(1)</script>\n<!-- /wp:html -->";
		$result   = $engine->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-risky', $latest['version'], $latest['content'], $proposed, false ) ),
			array()
		);

		// Sequestration: the proposal APPLIES (a risky NEW block has no
		// base counterpart, so it drops from the laundered content)…
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringNotContainsString( '<script>', $materialized );
		$this->assertStringNotContainsString( 'wp:html', $materialized );

		// …and the risky block parks for a privileged reviewer.
		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertSame( 'p-risky', $parked[0]['proposalId'] );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );
		$this->assertSame( self::$author_id, $parked[0]['author'] );
		$this->assertCount( 1, $parked[0]['changedBlocks'] );
		$this->assertStringContainsString( '<script>alert(1)</script>', $parked[0]['changedBlocks'][0]['html'] );
	}

	public function test_kses_sequestration_lands_safe_edits_and_reverts_only_the_risky_block() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 3, 0, array() );
		$latest   = $this->latest_from_response( $response );

		wp_set_current_user( self::$author_id );
		// One proposal, two edits: a SAFE rewrite of the Alpha block and a
		// risky rewrite of the Beta block.
		$proposed = str_replace( 'Alpha block original text', 'Alpha block SAFE-EDIT text', $latest['content'] );
		$proposed = str_replace( 'Beta block original text', 'Beta block <script>bad()</script> text', $proposed );
		$result   = $engine->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-mixed', $latest['version'], $latest['content'], $proposed, false ) ),
			array()
		);

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// The safe edit LANDED; the risky block reverted to its base form.
		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha block SAFE-EDIT text', $materialized );
		$this->assertStringContainsString( 'Beta block original text', $materialized );
		$this->assertStringNotContainsString( '<script>', $materialized );

		// Only the risky block parked (index 1 — the Beta paragraph).
		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertCount( 1, $parked[0]['changedBlocks'] );
		$this->assertSame( 1, $parked[0]['changedBlocks'][0]['index'] );
		$this->assertStringContainsString( '<script>bad()</script>', $parked[0]['changedBlocks'][0]['html'] );
		$this->assertStringNotContainsString( 'SAFE-EDIT', $parked[0]['changedBlocks'][0]['html'] );
	}

	public function test_kses_sequestration_dedupes_identical_risky_reproposals() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 3, 0, array() );
		$latest   = $this->latest_from_response( $response );

		wp_set_current_user( self::$author_id );
		$proposed = str_replace( 'Beta block original text', 'Beta block <script>bad()</script> text', $latest['content'] );

		// The client's next cycles re-carry the same risky content (its
		// local doc keeps the block until canonical wins locally): each
		// proposal gets a NEW id, but only the first parks.
		foreach ( array( 'p-loop-1', 'p-loop-2', 'p-loop-3' ) as $proposal_id ) {
			$result = $this->engine()->handle_updates(
				$this->room(),
				3,
				0,
				array( $this->proposal( $proposal_id, $latest['version'], $latest['content'], $proposed, false ) ),
				array()
			);
			$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		}

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked, 'identical risky content must park once, not once per poll cycle' );
	}

	public function test_kses_falls_back_to_whole_proposal_escalation_on_freeform_boundaries() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 3, 0, array() );
		$latest   = $this->latest_from_response( $response );

		wp_set_current_user( self::$author_id );
		// Loose classic HTML outside any block defeats per-block record
		// extraction; the lane degrades to the whole-proposal escalation.
		$proposed = $latest['content'] . "\n\n<div>loose classic <script>bad()</script> markup</div>";
		$result   = $engine->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-classic', $latest['version'], $latest['content'], $proposed, false ) ),
			array()
		);

		$this->assertSame( 'escalated', $result['dispositions'][0]['status'] );
		$this->assertSame( 'requires-unfiltered-html', $result['dispositions'][0]['reason'] );
		$this->assertStringNotContainsString( '<script>', (string) $this->engine()->materialize( $this->room() ) );

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertSame( 'p-classic', $parked[0]['proposalId'] );
	}

	/**
	 * Records the CURRENT behavior questioned by issue #41: a reviewer's
	 * approval of risky content is one-shot. Restore re-proposes the risky
	 * block under the reviewer's own capability (that lands it), but nothing
	 * remembers the approval afterwards. The next edit by a filtered author —
	 * even a plain typo fix around the already-approved risky markup — fails
	 * both sequestration passes (the block is no longer byte-identical to its
	 * base form, and kses still rewrites the approved markup), so the block
	 * reverts to base, the typo fix is lost from canonical, and the block
	 * parks for review all over again.
	 *
	 * If persistent approval becomes the policy, the last four assertions
	 * are the ones that should flip.
	 */
	public function test_approval_of_a_risky_block_does_not_survive_the_next_edit_by_a_filtered_author() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );

		// Step 1 — a filtered author edits the Beta block to include markup
		// kses would strip. The block reverts to its base form and parks.
		wp_set_current_user( self::$author_id );
		$risky_text = 'Beta block original text <script>widget()</script>';
		$proposed   = str_replace( 'Beta block original text', $risky_text, $genesis['content'] );
		$result     = $this->engine()->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-embed', $genesis['version'], $genesis['content'], $proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringNotContainsString( '<script>', (string) $this->engine()->materialize( $this->room() ) );

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertSame( 'p-embed', $parked[0]['proposalId'] );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );

		// Step 2 — a reviewer with unfiltered_html restores the parked block:
		// the parked markup re-proposes as the reviewer's own edit (that is
		// what approval IS in this engine), and the parked row resolves.
		wp_set_current_user( self::$editor_id );
		$reviewer_state    = $this->latest_from_response( $this->engine()->get_updates_since( $this->room(), 1, 0, array() ) );
		$restored_proposed = str_replace( 'Beta block original text', $risky_text, $reviewer_state['content'] );
		$restore_result    = $this->engine()->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-restore', $reviewer_state['version'], $reviewer_state['content'], $restored_proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $restore_result['dispositions'][0]['status'] );
		$resolved = $this->engine()->resolve_proposal( $this->room(), 'p-embed', 'restored', 1 );
		$this->assertSame( 'resolved', $resolved['status'] );

		$approved_canonical = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( '<script>widget()</script>', $approved_canonical, 'the restore must land the approved risky markup' );

		// Step 3 — the same filtered author fixes a typo in the approved
		// block, leaving the approved risky markup untouched.
		wp_set_current_user( self::$author_id );
		$author_state = $this->latest_from_response( $this->engine()->get_updates_since( $this->room(), 3, 0, array() ) );
		$this->assertStringContainsString( '<script>widget()</script>', $author_state['content'] );
		$typo_fixed  = str_replace( 'Beta block original text', 'Beta block corrected text', $author_state['content'] );
		$typo_result = $this->engine()->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->proposal( 'p-typo', $author_state['version'], $author_state['content'], $typo_fixed ) ),
			array()
		);
		$this->assertSame( 'applied', $typo_result['dispositions'][0]['status'] );

		// Step 4 — CURRENT behavior: the approval did not stick. The typo fix
		// never lands (the block reverted to its approved base form), and the
		// author's edit parks for review a second time.
		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Beta block original text', $materialized, 'current behavior: the typo fix is reverted with the block' );
		$this->assertStringNotContainsString( 'Beta block corrected text', $materialized, 'current behavior: the typo fix does not land' );

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 2, $parked, 'current behavior: the already-approved block parks again' );
		$this->assertSame( 'p-typo', $parked[1]['proposalId'] );
		$this->assertSame( 'requires-unfiltered-html', $parked[1]['reason'] );
		$this->assertStringContainsString( 'Beta block corrected text', $parked[1]['changedBlocks'][0]['html'] );
	}

	public function test_redelivered_escalation_does_not_double_park() {
		$genesis = $this->escalate_conflict();

		// The transport redelivers the same escalating proposal.
		$b_proposed = str_replace( 'Alpha block original text', 'Alpha block B-REWRITE text', $genesis['content'] );
		$this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->proposal( 'p-b', $genesis['version'], $genesis['content'], $b_proposed ) ),
			array()
		);

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 3, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
	}

	public function test_resolution_lifecycle_is_idempotent() {
		$this->escalate_conflict();

		$result = $this->engine()->resolve_proposal( $this->room(), 'p-b', 'dismissed', 2 );
		$this->assertSame(
			array(
				'intentId' => 'p-b',
				'status'   => 'resolved',
			),
			$result
		);

		$response = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$resolved = $this->rows_of_type( $response, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED );
		$this->assertCount( 1, $resolved );
		$this->assertSame( 'p-b', $resolved[0]['proposalId'] );
		$this->assertSame( 'dismissed', $resolved[0]['resolution'] );
		$this->assertSame( self::$editor_id, $resolved[0]['resolvedBy'] );

		// A redelivered (or concurrent) resolution acks without a new row.
		$again = $this->engine()->resolve_proposal( $this->room(), 'p-b', 'dismissed', 2 );
		$this->assertSame( 'resolved', $again['status'] );
		$resolved = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 3, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED
		);
		$this->assertCount( 1, $resolved );

		// An unknown id (trimmed long ago, or never parked) acks too.
		$unknown = $this->engine()->resolve_proposal( $this->room(), 'p-nonexistent', 'restored', 2 );
		$this->assertSame( 'resolved', $unknown['status'] );
	}

	public function test_malformed_resolution_is_rejected() {
		$result = $this->engine()->resolve_proposal( $this->room(), 'p-b', 'shredded', 2 );
		$this->assertWPError( $result );
		$this->assertSame( 'rest_sync_invalid_intent', $result->get_error_code() );
	}

	public function test_client_sent_resolution_row_is_rejected() {
		$this->escalate_conflict();

		// The old transport lane for Adopt/Reject decisions is gone: a
		// client-sent resolved row fails the whole request, and the
		// proposal stays parked.
		$result = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->resolution( 'p-b', 'dismissed' ) ),
			array()
		);
		$this->assertWPError( $result );
		$this->assertSame( 'rest_invalid_update_type', $result->get_error_code() );
		$resolved = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 3, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED
		);
		$this->assertCount( 0, $resolved );
	}

	/**
	 * Builds a proposal carrying entity-property registers.
	 *
	 * @param string $proposal_id  Correlation id.
	 * @param string $base_version Base version label.
	 * @param string $content      Base and proposed content (unchanged).
	 * @param array  $properties   Proposed property map.
	 * @return array Typed update row.
	 */
	private function property_proposal( string $proposal_id, string $base_version, string $content, array $properties ): array {
		return array(
			'data' => wp_json_encode(
				array(
					'proposalId'         => $proposal_id,
					'baseVersion'        => $base_version,
					'proposedContent'    => $content,
					'proposedProperties' => $properties,
					'clientUpdate'       => null,
				)
			),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
	}

	/**
	 * The property map carried by the latest canonical row in a response.
	 *
	 * @param array $response Room response.
	 * @return array|null Latest canonical property map.
	 */
	private function latest_properties( array $response ): ?array {
		$latest = null;
		foreach ( $response['updates'] as $update ) {
			$decoded = json_decode( $update['data'], true );
			if ( is_array( $decoded ) && is_string( $decoded['version'] ?? null ) && is_array( $decoded['properties'] ?? null ) ) {
				$latest = $decoded['properties'];
			}
		}
		return $latest;
	}

	public function test_genesis_snapshot_carries_the_shared_property_seed() {
		$response = $this->engine()->get_updates_since( $this->room(), 1, 0, array() );

		$snapshot = null;
		foreach ( $response['updates'] as $update ) {
			if ( WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT === $update['type'] ) {
				$snapshot = json_decode( $update['data'], true );
				break;
			}
		}
		$this->assertNotNull( $snapshot );
		$this->assertSame(
			WP_Sync_Post_Genesis_Props::for_post( get_post( self::$post_id ) ),
			$snapshot['properties'],
			'de-rtc genesis must seed the identical property set intent-log seeds'
		);
	}

	public function test_property_only_change_applies_and_broadcasts() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );
		$seed     = $this->latest_properties( $response );

		$proposed          = $seed;
		$proposed['title'] = 'A synced title';
		$result            = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->property_proposal( 'p-title', $genesis['version'], $genesis['content'], $proposed ) ),
			array()
		);

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// The canonical row every peer receives carries the new value; the
		// content itself is untouched.
		$after = $this->engine()->get_updates_since( $this->room(), 2, 0, array() );
		$props = $this->latest_properties( $after );
		$this->assertSame( 'A synced title', $props['title'] );
		$this->assertSame( $genesis['content'], $this->engine()->materialize( $this->room() ) );
	}

	public function test_property_three_way_matrix() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );
		$seed     = $this->latest_properties( $response );

		// Client A changes title AND excerpt from genesis.
		$a_props            = $seed;
		$a_props['title']   = 'Title by A';
		$a_props['excerpt'] = 'Excerpt by A';
		$a_result           = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->property_proposal( 'p-props-a', $genesis['version'], $genesis['content'], $a_props ) ),
			array()
		);
		$this->assertSame( 'applied', $a_result['dispositions'][0]['status'] );

		/*
		 * Client B proposes from the SAME (now stale) base: an unchanged
		 * excerpt (loses silently to A's — B never touched it), an
		 * AGREEING title (both wrote the same value — agreement applies),
		 * and a conflicting slug… wait, B also rewrites the title
		 * DIFFERENTLY in this matrix: that single property parks while the
		 * rest of the proposal applies.
		 */
		$b_props          = $seed;
		$b_props['title'] = 'Title by B';
		$b_result         = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->property_proposal( 'p-props-b', $genesis['version'], $genesis['content'], $b_props ) ),
			array()
		);
		$this->assertSame( 'applied', $b_result['dispositions'][0]['status'], 'the proposal itself applies; only the conflicting property parks' );

		$after = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$props = $this->latest_properties( $after );
		// A's concurrent title wins on the wire; A's excerpt untouched by B.
		$this->assertSame( 'Title by A', $props['title'] );
		$this->assertSame( 'Excerpt by A', $props['excerpt'] );

		// B's losing title parked as a property-conflict review row.
		$parked = $this->rows_of_type( $after, WP_De_RTC_Engine::UPDATE_TYPE_PARKED );
		$this->assertCount( 1, $parked );
		$this->assertSame( 'p-props-b:title', $parked[0]['proposalId'] );
		$this->assertSame( 'property-conflict', $parked[0]['reason'] );
		$this->assertSame(
			array(
				'name'  => 'title',
				'value' => 'Title by B',
			),
			$parked[0]['property']
		);
	}

	public function test_taxonomy_arrays_compare_order_insensitively() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );
		$seed     = $this->latest_properties( $response );
		$this->assertArrayHasKey( 'categories', $seed );

		// The same category SET in a different order is not a change.
		$proposed               = $seed;
		$proposed['categories'] = array_reverse( array_merge( $seed['categories'], array() ) );
		$result                 = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->property_proposal( 'p-tax-order', $genesis['version'], $genesis['content'], $proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$after = $this->engine()->get_updates_since( $this->room(), 2, 0, array() );
		$this->assertSame(
			array(),
			$this->rows_of_type( $after, WP_De_RTC_Engine::UPDATE_TYPE_PARKED ),
			'a reordered identical set must never park a conflict'
		);
	}

	public function test_markup_bearing_property_from_filtered_author_parks() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = $this->latest_from_response( $response );
		$seed     = $this->latest_properties( $response );

		wp_set_current_user( self::$author_id );
		$proposed          = $seed;
		$proposed['title'] = 'Sneaky <script>alert(1)</script> title';
		$result            = $engine->handle_updates(
			$this->room(),
			3,
			0,
			array( $this->property_proposal( 'p-risky-prop', $genesis['version'], $genesis['content'], $proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$after = $this->engine()->get_updates_since( $this->room(), 4, 0, array() );
		$props = $this->latest_properties( $after );
		$this->assertStringNotContainsString( '<script>', (string) ( $props['title'] ?? '' ) );

		$parked = $this->rows_of_type( $after, WP_De_RTC_Engine::UPDATE_TYPE_PARKED );
		$this->assertCount( 1, $parked );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );
		$this->assertSame( 'title', $parked[0]['property']['name'] );
	}

	public function test_unresolved_parked_rows_survive_compaction_and_resolved_pairs_age_out() {
		add_filter( 'wp_sync_de_rtc_checkpoint_interval', $interval_filter = static fn() => 4 );
		try {
			$genesis = $this->escalate_conflict();

			// A second parked proposal that WILL be resolved before the trims.
			$c_proposed = str_replace( 'Alpha block original text', 'Alpha block C-REWRITE text', $genesis['content'] );
			$this->engine()->handle_updates(
				$this->room(),
				4,
				0,
				array( $this->proposal( 'p-c', $genesis['version'], $genesis['content'], $c_proposed ) ),
				array()
			);
			$this->engine()->resolve_proposal( $this->room(), 'p-c', 'dismissed', 4 );

			// Drive enough accepted proposals for multiple checkpoints/trims.
			$state   = $this->latest_from_response( $this->engine()->get_updates_since( $this->room(), 1, 0, array() ) );
			$content = $state['content'];
			$version = $state['version'];
			for ( $i = 1; $i <= 16; $i++ ) {
				$proposed = $content . "\n\n<!-- wp:paragraph -->\n<p>Retention row {$i}.</p>\n<!-- /wp:paragraph -->";
				$result   = $this->engine()->handle_updates(
					$this->room(),
					1,
					0,
					array( $this->proposal( 'p-fill-' . $i, $version, $content, $proposed ) ),
					array()
				);
				$this->assertSame( 'applied', $result['dispositions'][0]['status'], "fill proposal {$i} should apply" );
				$version = $result['dispositions'][0]['version'];
				$content = $proposed;
			}

			$storage = new WP_Sync_Table_Storage();
			$this->assertIsNumeric(
				$storage->get_room_meta( $this->room(), WP_De_RTC_Engine::META_FLOOR ),
				'compaction should have trimmed at least once'
			);

			// A fresh joiner still receives the UNRESOLVED parked proposal…
			$response = $this->engine()->get_updates_since( $this->room(), 9, 0, array() );
			$parked   = $this->rows_of_type( $response, WP_De_RTC_Engine::UPDATE_TYPE_PARKED );
			$open_ids = array_column( $parked, 'proposalId' );
			$this->assertContains( 'p-b', $open_ids, 'unresolved parked work must survive compaction' );

			// …while the resolved pair aged out with the trim.
			$this->assertNotContains( 'p-c', $open_ids, 'resolved parked rows age out' );
		} finally {
			remove_filter( 'wp_sync_de_rtc_checkpoint_interval', $interval_filter );
		}
	}

	/**
	 * Creates a fresh, isolated post/room for the #64 approval-pin tests:
	 * this scenario needs precise parked-row counts, which the rest of
	 * this file's shared, cumulative room cannot give a test appended at
	 * the end (its history already carries every earlier test's parked
	 * rows).
	 *
	 * @return string Room identifier for the new post.
	 */
	private function approval_pin_room(): string {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'DE-RTC approval-pin test post',
				'post_content' => "<!-- wp:paragraph -->\n<p>Paragraph A.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Paragraph B.</p>\n<!-- /wp:paragraph -->",
			)
		);
		return 'postType/post:' . $post_id;
	}

	/**
	 * Drives the #64 approval flow up through the reviewer's restore, on a
	 * dedicated room: the filtered author risk-edits paragraph B (parking
	 * it), then the editor (unfiltered_html) restores and resolves it.
	 * Returns the post-restore canonical content/version so callers can
	 * drive further edits against it.
	 *
	 * @param string $room Room identifier.
	 * @return array{content: string, version: string} Canonical state
	 *                                                  right after the
	 *                                                  restore landed.
	 */
	private function approve_unfiltered_html_scenario( string $room ): array {
		$engine = $this->engine();
		$state  = $this->latest_from_response( $engine->get_updates_since( $room, 1, 0, array() ) );

		// Step 1-2: the author (no unfiltered_html) edits paragraph B to
		// include something WordPress would strip. It is set aside for
		// review; paragraph B itself stays at its prior, unedited text.
		wp_set_current_user( self::$author_id );
		$risky        = str_replace( 'Paragraph B.', 'Paragraph B <script>bad()</script>.', $state['content'] );
		$risky_result = $engine->handle_updates(
			$room,
			3,
			0,
			array( $this->proposal( 'p-risky-approval', $state['version'], $state['content'], $risky, false ) ),
			array()
		);
		$this->assertSame( 'applied', $risky_result['dispositions'][0]['status'] );
		$after_risky = (string) $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Paragraph B.', $after_risky );
		$this->assertStringNotContainsString( '<script>', $after_risky );

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $room, 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked );
		$this->assertSame( 'p-risky-approval', $parked[0]['proposalId'] );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );

		// Step 3: the administrator (the editor role here has
		// unfiltered_html) approves it. Client-side this re-proposes the
		// parked bytes under the restorer's own capability — landing them
		// in canonical — and THEN resolves the parked row as `restored`.
		wp_set_current_user( self::$editor_id );
		$approved_state = $this->latest_from_response( $this->engine()->get_updates_since( $room, 1, 0, array() ) );
		$restore_result = $this->engine()->handle_updates(
			$room,
			2,
			0,
			array( $this->proposal( 'p-restore-approval', $approved_state['version'], $approved_state['content'], $risky, false ) ),
			array()
		);
		$this->assertSame( 'applied', $restore_result['dispositions'][0]['status'] );
		$approved_version = $restore_result['dispositions'][0]['version'];
		$this->assertStringContainsString( '<script>bad()</script>', (string) $this->engine()->materialize( $room ) );

		$this->engine()->resolve_proposal( $room, 'p-risky-approval', 'restored', 2 );

		return array(
			'content' => (string) $this->engine()->materialize( $room ),
			'version' => $approved_version,
		);
	}

	/**
	 * The #64 repro: once a privileged reviewer restores content a
	 * filtered author's edit would otherwise strip, a LATER edit by any
	 * filtered author elsewhere in the post must land normally instead of
	 * re-escalating every time it re-carries the approved bytes.
	 */
	public function test_restored_unfiltered_html_approval_lets_other_edits_land() {
		$room     = $this->approval_pin_room();
		$approved = $this->approve_unfiltered_html_scenario( $room );

		// Step 4: as the SAME filtered author, a plain edit to paragraph A —
		// nothing WordPress would strip.
		wp_set_current_user( self::$author_id );
		$plain_edit   = str_replace( 'Paragraph A.', 'Paragraph A, plain edit.', $approved['content'] );
		$plain_result = $this->engine()->handle_updates(
			$room,
			3,
			0,
			array( $this->proposal( 'p-plain-after-approval', $approved['version'], $approved['content'], $plain_edit, false ) ),
			array()
		);

		// The plain edit lands normally…
		$this->assertSame( 'applied', $plain_result['dispositions'][0]['status'] );
		$final = (string) $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Paragraph A, plain edit.', $final );
		// …and the approved content is untouched, not stripped again.
		$this->assertStringContainsString( '<script>bad()</script>', $final );

		// Nothing new needed a human this time: no second parked row.
		$parked_after = $this->rows_of_type(
			$this->engine()->get_updates_since( $room, 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 1, $parked_after, 'the plain edit must not create a second parked row' );
	}

	/**
	 * The companion policy case for #64: the approval pin is tied to exact
	 * bytes. A filtered author who edits the previously-approved block
	 * itself — even slightly — produces content with no recorded
	 * fingerprint, so it goes back to review instead of riding along.
	 */
	public function test_editing_previously_approved_content_still_requires_review() {
		$room  = $this->approval_pin_room();
		$state = $this->approve_unfiltered_html_scenario( $room );

		wp_set_current_user( self::$author_id );
		$reedited = str_replace(
			'Paragraph B <script>bad()</script>.',
			'Paragraph B <script>worse()</script>.',
			$state['content']
		);
		$this->assertNotSame( $state['content'], $reedited, 'the previously approved block must be present to re-edit' );

		$result = $this->engine()->handle_updates(
			$room,
			3,
			0,
			array( $this->proposal( 'p-reedit-approved', $state['version'], $state['content'], $reedited, false ) ),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// The new bytes have no pinned fingerprint, so they revert to the
		// last approved text instead of landing.
		$materialized = (string) $this->engine()->materialize( $room );
		$this->assertStringContainsString( '<script>bad()</script>', $materialized );
		$this->assertStringNotContainsString( 'worse()', $materialized );

		$parked = $this->rows_of_type(
			$this->engine()->get_updates_since( $room, 4, 0, array() ),
			WP_De_RTC_Engine::UPDATE_TYPE_PARKED
		);
		$this->assertCount( 2, $parked, 'the re-edit of approved content must park a second review row' );
		$this->assertSame( 'p-reedit-approved', $parked[1]['proposalId'] );
		$this->assertSame( 'requires-unfiltered-html', $parked[1]['reason'] );
		$this->assertStringContainsString( 'worse()', $parked[1]['changedBlocks'][0]['html'] );
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
