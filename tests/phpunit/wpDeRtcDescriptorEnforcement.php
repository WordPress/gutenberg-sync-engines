<?php
/**
 * Tests for the descriptor tamper-evidence lane (full
 * enforcement): a proposal's block-native clientUpdate is validated
 * once against the PLAIN declared base and then dropped, so genuine
 * tampering voids the proposal while the server's own rewrites (kses
 * sequestration, per-block salvage) keep their partial-acceptance
 * lanes even for descriptor-carrying proposals.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcDescriptorEnforcement extends WP_UnitTestCase {
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

	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Builds a proposal row, deriving a VALID descriptor from the
	 * (base, proposed) pair unless an explicit one is given.
	 *
	 * @param string     $proposal_id   Proposal id.
	 * @param string     $base_version  Declared base version.
	 * @param string     $base_content  Base content the descriptor claims.
	 * @param string     $proposed      Proposed content.
	 * @param array|null $client_update Explicit descriptor override.
	 * @param array      $extra         Extra payload fields.
	 * @return array Row for handle_updates().
	 */
	private function proposal( string $proposal_id, string $base_version, string $base_content, string $proposed, $client_update = null, array $extra = array() ): array {
		if ( null === $client_update ) {
			$client_update = wp_de_rtc_create_automerge_update_for_content_change( $base_content, $proposed, 'client-test' );
			unset( $client_update['change_range'] );
		}
		$payload = array_merge(
			array(
				'proposalId'      => $proposal_id,
				'baseVersion'     => $base_version,
				'proposedContent' => $proposed,
				'clientUpdate'    => $client_update,
			),
			$extra
		);
		return array(
			'data' => wp_json_encode( $payload ),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
	}

	private function parked_rows(): array {
		$response = $this->engine()->get_updates_since( $this->room(), 999, 0, array() );
		$rows     = array();
		foreach ( $response['updates'] as $update ) {
			if ( WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'] ) {
				$rows[] = json_decode( $update['data'], true );
			}
		}
		return $rows;
	}

	public function test_valid_descriptor_is_accepted_and_merges() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha edited with evidence.', $this->genesis() );
		$result   = $engine->handle_updates( $this->room(), 701, 0, array( $this->proposal( 'p-valid', 'v1', $this->genesis(), $proposed ) ), array() );

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringContainsString( 'Alpha edited with evidence.', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_tampered_content_hash_voids_the_proposal() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$proposed                        = str_replace( 'Alpha block original text.', 'Alpha honest edit.', $this->genesis() );
		$tampered                        = wp_de_rtc_create_automerge_update_for_content_change( $this->genesis(), $proposed, 'client-test' );
		$tampered['proposedContentHash'] = str_repeat( '0', 64 );

		$result = $engine->handle_updates( $this->room(), 702, 0, array( $this->proposal( 'p-tampered-hash', 'v1', $this->genesis(), $proposed, $tampered ) ), array() );

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'automerge_block_native_proposed_hash_mismatch', $result['dispositions'][0]['reason'] );
		$this->assertStringNotContainsString( 'Alpha honest edit.', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_descriptor_for_different_content_voids_the_proposal() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// Evidence derived for one edit, submitted beside ANOTHER: the
		// fingerprints cannot match the re-derived expectation.
		$claimed  = str_replace( 'Alpha block original text.', 'Alpha claimed edit.', $this->genesis() );
		$actual   = str_replace( 'Alpha block original text.', 'Alpha smuggled edit.', $this->genesis() );
		$evidence = wp_de_rtc_create_automerge_update_for_content_change( $this->genesis(), $claimed, 'client-test' );
		unset( $evidence['change_range'], $evidence['baseContentHash'], $evidence['proposedContentHash'] );

		$result = $engine->handle_updates( $this->room(), 703, 0, array( $this->proposal( 'p-smuggle', 'v1', $this->genesis(), $actual, $evidence ) ), array() );

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'automerge_client_update_materialization_mismatch', $result['dispositions'][0]['reason'] );
		$this->assertStringNotContainsString( 'smuggled', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_hash_pinned_unsupported_fallback_is_accepted() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// A client whose parser twin refused to split blocks sends the
		// single fallback op with verified hashes: digest-only evidence,
		// not tamper.
		$proposed = str_replace( 'Beta block original text.', 'Beta via digest evidence.', $this->genesis() );
		$fallback = array(
			'format'              => 'native-automerge-blocks-v1',
			'schema'              => 'de-rtc-automerge-v1',
			'operations'          => array(
				array(
					'type'     => 'document.replace_unsupported',
					'actor'    => 'client-test',
					'sequence' => 0,
					'id'       => 'client-test:0',
				),
			),
			'stateVector'         => array( 'client-test' => 1 ),
			'baseContentHash'     => wp_de_rtc_hash_content( $this->genesis() ),
			'proposedContentHash' => wp_de_rtc_hash_content( $proposed ),
		);

		$result = $engine->handle_updates( $this->room(), 704, 0, array( $this->proposal( 'p-fallback', 'v1', $this->genesis(), $proposed, $fallback ) ), array() );

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringContainsString( 'Beta via digest evidence.', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_unsupported_fallback_without_hashes_is_rejected() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$proposed = str_replace( 'Beta block original text.', 'Beta unpinned.', $this->genesis() );
		$fallback = array(
			'format'      => 'native-automerge-blocks-v1',
			'operations'  => array(
				array( 'type' => 'document.replace_unsupported' ),
			),
			'stateVector' => array( 'client-test' => 1 ),
		);

		$result = $engine->handle_updates( $this->room(), 705, 0, array( $this->proposal( 'p-unpinned', 'v1', $this->genesis(), $proposed, $fallback ) ), array() );

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'automerge_client_update_materialization_mismatch', $result['dispositions'][0]['reason'] );
	}

	public function test_kses_sequestration_survives_a_valid_descriptor() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// Validate-once-then-drop: previously a descriptor-carrying
		// risky proposal escalated WHOLE; now the descriptor validates
		// against the ORIGINAL proposal and the sequestration lane still
		// parks exactly the risky block.
		wp_set_current_user( self::$author_id );
		$proposed = $this->genesis() . "\n\n<!-- wp:html -->\n<script>alert(1)</script>\n<!-- /wp:html -->";
		$result   = $engine->handle_updates( $this->room(), 706, 0, array( $this->proposal( 'p-risky', 'v1', $this->genesis(), $proposed ) ), array() );

		$this->assertSame( 'applied', $result['dispositions'][0]['status'], 'The safe remainder lands (sequestration, not whole-park).' );
		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringNotContainsString( '<script>', $materialized );

		$parked = $this->parked_rows();
		$this->assertCount( 1, $parked );
		$this->assertSame( 'requires-unfiltered-html', $parked[0]['reason'] );
		$this->assertStringContainsString( '<script>alert(1)</script>', $parked[0]['changedBlocks'][0]['html'] );
	}

	public function test_per_block_salvage_survives_a_valid_descriptor() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// A session rewrites Alpha from v1.
		$session = str_replace( 'Alpha block original text.', 'Alpha rewritten by the session.', $this->genesis() );
		$result  = $engine->handle_updates( $this->room(), 707, 0, array( $this->proposal( 'p-session', 'v1', $this->genesis(), $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// A stale descriptor-carrying client conflicts on Alpha and edits
		// Beta cleanly: previously this parked whole; now salvage
		// lands Beta and parks exactly Alpha.
		$stale  = str_replace(
			array( 'Alpha block original text.', 'Beta block original text.' ),
			array( 'Alpha rewritten by the stale client.', 'Beta cleanly edited.' ),
			$this->genesis()
		);
		$result = $engine->handle_updates( $this->room(), 708, 0, array( $this->proposal( 'p-stale', 'v1', $this->genesis(), $stale ) ), array() );

		$disposition = $result['dispositions'][0];
		$this->assertSame( 'applied', $disposition['status'] );
		$this->assertSame( 1, $disposition['parkedBlocks'] ?? null );

		$final = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Alpha rewritten by the session.', $final );
		$this->assertStringContainsString( 'Beta cleanly edited.', $final );
	}

	public function test_descriptor_composes_with_block_base_versions() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// A peer prefixes Alpha: v1 -> v2.
		$peer   = str_replace( 'Alpha block original text.', 'Peer prefix. Alpha block original text.', $this->genesis() );
		$result = $engine->handle_updates( $this->room(), 709, 0, array( $this->proposal( 'p-peer', 'v1', $this->genesis(), $peer ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// A client that kept its own Alpha through the colliding
		// incorporation proposes from whole-doc base v2 with Alpha's TRUE
		// base declared — and carries a descriptor built against the
		// PLAIN v2 base (exactly what the session builds). Both survive:
		// the descriptor validates against plain v2; the merge runs from
		// the composite base and MERGES the concurrent Alpha edits.
		$reproposal = str_replace(
			'Alpha block original text.',
			'Alpha block original text. Suffix by client.',
			$peer
		);
		// The doc kept the local Alpha (no peer prefix), so the proposed
		// content lacks the prefix in Alpha:
		$reproposal = str_replace( 'Peer prefix. Alpha block original text. Suffix by client.', 'Alpha block original text. Suffix by client.', $reproposal );

		$result = $engine->handle_updates(
			$this->room(),
			710,
			0,
			array(
				$this->proposal(
					'p-composite',
					'v2',
					$peer,
					$reproposal,
					null,
					array( 'blockBaseVersions' => array( '0' => 'v1' ) )
				),
			),
			array()
		);

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$final = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Peer prefix. Alpha block original text. Suffix by client.', $final, 'Both concurrent same-block edits merge (2b) with the descriptor validated (2a).' );
	}

	public function test_malformed_descriptor_is_rejected_as_malformed() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		$proposed = str_replace( 'Beta block original text.', 'Beta with junk evidence.', $this->genesis() );
		$result   = $engine->handle_updates(
			$this->room(),
			711,
			0,
			array( $this->proposal( 'p-junk', 'v1', $this->genesis(), $proposed, array( 'format' => 'not-a-format' ) ) ),
			array()
		);

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'automerge_client_update_unsupported_format', $result['dispositions'][0]['reason'] );
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
