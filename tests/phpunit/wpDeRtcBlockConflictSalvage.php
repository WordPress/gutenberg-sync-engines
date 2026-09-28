<?php
/**
 * Tests for per-block conflict salvage: a proposal whose
 * whole-document merge conflicts lands its clean blocks and parks
 * exactly the conflicted ones; structural divergence keeps the
 * whole-proposal fallback.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcBlockConflictSalvage extends WP_UnitTestCase {
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

	private function proposal( string $proposal_id, string $base_version, string $proposed, array $block_bases = array() ): array {
		$payload = array(
			'proposalId'      => $proposal_id,
			'baseVersion'     => $base_version,
			'proposedContent' => $proposed,
			'clientUpdate'    => null,
		);
		if ( array() !== $block_bases ) {
			$payload['blockBaseVersions'] = $block_bases;
		}
		return array(
			'data' => wp_json_encode( $payload ),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
	}

	private function parked_rows( WP_De_RTC_Engine $engine ): array {
		$response = $engine->get_updates_since( $this->room(), 999, 0, array() );
		return array_values(
			array_filter(
				$response['updates'],
				static function ( $update ) {
					return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'];
				}
			)
		);
	}

	public function test_conflicting_block_parks_while_clean_block_lands() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// The session rewrites Alpha from v1.
		$session = str_replace( 'Alpha block original text.', 'Alpha rewritten by the session.', $this->genesis() );
		$result  = $engine->handle_updates( $this->room(), 601, 0, array( $this->proposal( 'p-session', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// A stale client, also from v1, rewrites Alpha DIFFERENTLY (true
		// conflict) and Beta cleanly.
		$stale  = str_replace(
			array( 'Alpha block original text.', 'Beta block original text.' ),
			array( 'Alpha rewritten by the stale client.', 'Beta cleanly edited.' ),
			$this->genesis()
		);
		$result = $engine->handle_updates( $this->room(), 602, 0, array( $this->proposal( 'p-stale', 'v1', $stale ) ), array() );

		$disposition = $result['dispositions'][0];
		$this->assertSame( 'applied', $disposition['status'], 'The clean remainder must land (partial acceptance).' );
		$this->assertSame( 1, $disposition['parkedBlocks'] ?? null, 'Exactly the conflicted block parks.' );

		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha rewritten by the session.', $final, 'Canonical wins the conflicted block.' );
		$this->assertStringContainsString( 'Beta cleanly edited.', $final, 'The clean block lands.' );
		$this->assertStringNotContainsString( 'Alpha rewritten by the stale client.', $final );

		// The losing block is parked, scoped to the block, not the doc.
		$parked = $this->parked_rows( $engine );
		$this->assertCount( 1, $parked );
		$decoded = json_decode( $parked[0]['data'], true );
		$this->assertSame( 'manual-conflict-required', $decoded['reason'] );
		$this->assertCount( 1, $decoded['changedBlocks'], 'Only the conflicted block parks, not the whole proposal.' );
		$this->assertStringContainsString( 'Alpha rewritten by the stale client.', $decoded['changedBlocks'][0]['html'] );
		$this->assertStringNotContainsString( 'Beta cleanly edited.', $decoded['changedBlocks'][0]['html'] );
	}

	/**
	 * Per-block base honesty: a client that kept its local block through a
	 * colliding incorporation re-proposes from an advanced whole-document
	 * base but declares the block's TRUE base — and non-overlapping
	 * concurrent edits to the same block now MERGE instead of overwriting
	 * the peer.
	 */
	public function test_per_block_base_merges_true_same_block_concurrency() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// A peer prefixes Alpha from v1 -> v2.
		$peer   = str_replace( 'Alpha block original text.', 'Peer prefix. Alpha block original text.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 611, 0, array( $this->proposal( 'p-peer', 'v1', $peer ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// The LWW-class re-proposal: whole-doc base v2 (incorporated), but
		// Alpha's text was built on v1 (suffix edit, ignorant of the
		// peer's prefix) — declared honestly via blockBaseVersions.
		$mine   = str_replace( 'Alpha block original text.', 'Alpha block original text. Client suffix.', $this->genesis() );
		$result = $engine->handle_updates(
			$this->room(),
			612,
			0,
			array( $this->proposal( 'p-mine', 'v2', $mine, array( '0' => 'v1' ) ) ),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Peer prefix.', $final, 'The peer\'s concurrent edit must survive.' );
		$this->assertStringContainsString( 'Client suffix.', $final, 'The client\'s edit must land.' );
	}

	/**
	 * Per-block base honesty: when the same-block concurrency truly
	 * OVERLAPS, the honest base turns the old silent overwrite into a
	 * parked review item —
	 * canonical keeps the peer's text.
	 */
	public function test_per_block_base_parks_true_overlap_instead_of_lww() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$peer   = str_replace( 'Alpha block original text.', 'Alpha rewritten by the peer.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 613, 0, array( $this->proposal( 'p-peer', 'v1', $peer ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$mine   = str_replace( 'Alpha block original text.', 'Alpha rewritten by me.', $this->genesis() );
		$result = $engine->handle_updates(
			$this->room(),
			614,
			0,
			array( $this->proposal( 'p-mine', 'v2', $mine, array( '0' => 'v1' ) ) ),
			array()
		);

		$disposition = $result['dispositions'][0];
		$this->assertSame( 'applied', $disposition['status'] );
		$this->assertSame( 1, $disposition['parkedBlocks'] ?? null, 'The overlap parks instead of overwriting.' );

		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha rewritten by the peer.', $final, 'The peer\'s text wins canonically.' );
		$this->assertStringNotContainsString( 'Alpha rewritten by me.', $final, 'The silent LWW is retired.' );

		$parked = $this->parked_rows( $engine );
		$this->assertNotEmpty( $parked, 'The losing text goes to review, never lost.' );
	}

	/**
	 * The documented residual: a client that does NOT declare per-block
	 * bases still presents a clean sole-writer change and overwrites —
	 * the map is what retires the LWW.
	 */
	public function test_without_block_bases_the_lww_residual_remains() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$peer   = str_replace( 'Alpha block original text.', 'Alpha rewritten by the peer.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 615, 0, array( $this->proposal( 'p-peer', 'v1', $peer ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$mine   = str_replace( 'Alpha block original text.', 'Alpha rewritten by me.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 616, 0, array( $this->proposal( 'p-mine', 'v2', $mine ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha rewritten by me.', $final );
	}

	public function test_structural_conflict_keeps_the_whole_proposal_fallback() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// The session removes Beta (structure changes).
		$session = "<!-- wp:paragraph -->\n<p>Alpha rewritten by the session.</p>\n<!-- /wp:paragraph -->";
		$result  = $engine->handle_updates( $this->room(), 603, 0, array( $this->proposal( 'p-session', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// A stale client rewrites Alpha differently against the removed
		// structure. Identity sees through the structural change (Beta's
		// deletion is untouched by the stale client, so it stands) and
		// resolves the one true conflict per block: canonical keeps the
		// session's Alpha, the stale client's Alpha parks.
		$stale  = str_replace( 'Alpha block original text.', 'Alpha rewritten by the stale client.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 604, 0, array( $this->proposal( 'p-stale', 'v1', $stale ) ), array() );

		$disposition = $result['dispositions'][0];
		$this->assertSame( 'applied', $disposition['status'] );
		$this->assertSame( 1, $disposition['parkedBlocks'] );

		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringNotContainsString( 'Alpha rewritten by the stale client.', $final );
		$this->assertStringContainsString( 'Alpha rewritten by the session.', $final );
		$this->assertStringNotContainsString( 'Beta', $final, 'The session\'s deletion stands.' );

		$parked = array_filter(
			$this->engine()->get_updates_since( $this->room(), 999, 0, array() )['updates'],
			static function ( array $row ): bool {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $row['type'];
			}
		);
		$this->assertCount( 1, $parked );
		$row = json_decode( array_values( $parked )[0]['data'], true );
		$this->assertSame( 'p-stale', $row['proposalId'] );
		$this->assertStringContainsString( 'Alpha rewritten by the stale client.', $row['changedBlocks'][0]['html'] );
	}

	public function test_content_identity_cannot_model_keeps_the_whole_proposal_fallback() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$session = str_replace( 'Alpha block original text.', 'Alpha rewritten by the session.', $this->genesis() );
		$result  = $engine->handle_updates( $this->room(), 605, 0, array( $this->proposal( 'p-session', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// Classic content between blocks: identity declines, per-block
		// extraction is unavailable, and the positional policy stands —
		// the whole proposal escalates.
		$stale  = "Classic text between blocks.\n\n" . str_replace( 'Alpha block original text.', 'Alpha rewritten by the stale client.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 606, 0, array( $this->proposal( 'p-stale', 'v1', $stale ) ), array() );

		$disposition = $result['dispositions'][0];
		$this->assertSame( 'escalated', $disposition['status'] );
		$this->assertSame( 'manual-conflict-required', $disposition['reason'] );
		$this->assertStringNotContainsString( 'Alpha rewritten by the stale client.', $this->engine()->materialize( $this->room() ) );
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
