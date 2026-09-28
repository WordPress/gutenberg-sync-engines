<?php
/**
 * Unit tests for the shared genesis property helper — the REST-shaped
 * property seed every field-syncing engine builds its genesis from.
 *
 * The intent-log engine's genesis-seeding tests (wpIntentLogEngineInternals)
 * exercise the same helper through delegation; this file pins the helper's
 * own contract so yjs-server and de-rtc genesis can rely on it directly.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpSyncPostGenesisProps extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
	}

	public function test_builds_the_full_rest_shaped_property_map() {
		register_post_meta(
			'post',
			'genesis_note',
			array(
				'show_in_rest' => true,
				'single'       => true,
				'type'         => 'string',
				'default'      => '',
			)
		);

		$post_id = self::factory()->post->create(
			array(
				'post_title'   => 'Helper title',
				'post_excerpt' => 'Helper excerpt',
				'post_status'  => 'publish',
				'post_author'  => self::$editor_id,
			)
		);
		update_post_meta( $post_id, 'genesis_note', 'noted' );
		update_post_meta( $post_id, '_crdt_document', 'transport-state' );
		$post = get_post( $post_id );

		$props = WP_Sync_Post_Genesis_Props::for_post( $post );

		unregister_post_meta( 'post', 'genesis_note' );

		$this->assertSame( 'Helper title', $props['title'] );
		$this->assertSame( 'Helper excerpt', $props['excerpt'] );
		$this->assertSame( 'publish', $props['status'] );
		$this->assertSame( self::$editor_id, $props['author'] );
		$this->assertSame( mysql_to_rfc3339( $post->post_date ), $props['date'] );
		$this->assertSame( array( (int) get_option( 'default_category' ) ), $props['categories'] );
		$this->assertSame( array(), $props['tags'] );
		$this->assertSame( 'noted', $props['meta.genesis_note'] );
		$this->assertArrayNotHasKey( 'meta._crdt_document', $props );
	}

	public function test_auto_draft_blanks_title_and_omits_status_slug_and_floating_date() {
		$post_id = self::factory()->post->create(
			array(
				'post_title'  => 'Auto Draft',
				'post_status' => 'auto-draft',
			)
		);
		// Force the floating-date shape a real auto-draft carries.
		global $wpdb;
		$wpdb->update(
			$wpdb->posts,
			array(
				'post_date_gmt' => '0000-00-00 00:00:00',
				'post_name'     => '',
			),
			array( 'ID' => $post_id )
		);
		clean_post_cache( $post_id );

		$props = WP_Sync_Post_Genesis_Props::for_post( get_post( $post_id ) );

		$this->assertSame( '', $props['title'] );
		$this->assertArrayNotHasKey( 'status', $props );
		$this->assertArrayNotHasKey( 'slug', $props );
		$this->assertArrayNotHasKey( 'date', $props );
	}

	public function test_matches_the_intent_log_genesis_seed_exactly() {
		$post_id = self::factory()->post->create(
			array(
				'post_title'   => 'Parity post',
				'post_status'  => 'publish',
				'post_content' => "<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->",
			)
		);

		$engine   = new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
		$response = $engine->get_updates_since( 'postType/post:' . $post_id, 101, 0, array() );
		$snapshot = null;
		foreach ( $response['updates'] as $update ) {
			if ( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT === $update['type'] ) {
				$snapshot = json_decode( $update['data'], true );
				break;
			}
		}
		$this->assertNotNull( $snapshot, 'first poll must contain a snapshot row' );

		$this->assertSame(
			WP_Sync_Post_Genesis_Props::for_post( get_post( $post_id ) ),
			$snapshot['doc']['props']
		);
	}
}
