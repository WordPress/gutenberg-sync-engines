<?php
/**
 * Tests for client-authored save markup (intent-log half): `_wrapper`
 * and `content` updates make sourced-attribute edits survive server
 * materialization — the markup the server emits is markup the client
 * authored from the block's current attributes.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogSourcedAttrs extends WP_UnitTestCase {
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

	const GENESIS_CONTENT = "<!-- wp:image {\"id\":5,\"sizeSlug\":\"large\"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"https://example.com/a.png\" alt=\"old alt\"/></figure>\n<!-- /wp:image -->";

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

	private function engine(): WP_Intent_Log_Engine {
		return new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Builds one intent update row.
	 *
	 * @param array $intent Intent envelope fields.
	 * @return array Typed update.
	 */
	private static function intent_update( array $intent ): array {
		return array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
			'data' => wp_json_encode(
				array_merge(
					array(
						'actorId' => 'ignored',
						'txnId'   => null,
					),
					$intent
				)
			),
		);
	}

	public function test_sourced_attribute_edit_survives_materialization() {
		$engine  = $this->engine();
		$sync_id = WP_Intent_Log_Planner::genesis_sync_id( self::$post_id, 0, array( 0 ) );
		// Materialization normalizes (syncId stamped into the comment,
		// whitespace canonical) — assert content, not bytes.
		$this->assertStringContainsString( 'old alt', (string) $engine->materialize( $this->room() ) );

		/*
		 * The client bridge's save-markup capture for an alt change: set_attr
		 * for the sourced attribute (peers render from attrs), a content
		 * rewrite carrying the block's NEW save markup (the codec models
		 * the img as one object span), and the refreshed wrapper. Coarse
		 * shape (replace + format restore) — exactly what the bridge's
		 * degrade path emits, and expressible without the JS differ.
		 */
		$new_inner = '<img src="https://example.com/a.png" alt="new alt"/>';
		$field     = WP_Intent_Log_Rich_Text::html_to_field( $new_inner );

		$updates = array(
			self::intent_update(
				array(
					'intentId' => 'i-alt',
					'baseSeq'  => 0,
					'type'     => 'set_attr',
					'payload'  => array(
						'syncId'          => $sync_id,
						'key'             => 'alt',
						'value'           => 'new alt',
						'observedVersion' => 0,
					),
				)
			),
			self::intent_update(
				array(
					'intentId' => 'i-wrapper',
					'baseSeq'  => 0,
					'type'     => 'set_attr',
					'payload'  => array(
						'syncId'          => $sync_id,
						'key'             => '_wrapper',
						'value'           => array(
							'open'  => '<figure class="wp-block-image size-large">',
							'close' => '</figure>',
						),
						'observedVersion' => 0,
					),
				)
			),
			self::intent_update(
				array(
					'intentId' => 'i-content',
					'baseSeq'  => 0,
					'type'     => 'replace_attr_content',
					'payload'  => array(
						'syncId'          => $sync_id,
						'field'           => 'content',
						'newText'         => $field['text'],
						'observedVersion' => 0,
					),
				)
			),
		);
		foreach ( $field['formats'] as $index => $span ) {
			$updates[] = self::intent_update(
				array(
					'intentId' => 'i-fmt-' . $index,
					'baseSeq'  => 0,
					'type'     => 'format_text',
					'payload'  => array(
						'syncId' => $sync_id,
						'field'  => 'content',
						'start'  => $span['start'],
						'end'    => $span['end'],
						'format' => $span['format'],
						'on'     => true,
					),
				)
			);
		}

		$result = $engine->handle_updates( $this->room(), 301, 0, $updates, array() );
		foreach ( $result['dispositions'] as $disposition ) {
			$this->assertSame( 'applied', $disposition['status'], 'Intent ' . $disposition['intentId'] . ' must apply.' );
		}

		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'alt="new alt"', $materialized, 'The sourced attribute must survive materialization.' );
		$this->assertStringNotContainsString( 'old alt', $materialized );
		$this->assertStringContainsString( '<figure class="wp-block-image size-large">', $materialized );

		// The materialized markup must still parse as a valid image block.
		$blocks = parse_blocks( $materialized );
		$this->assertSame( 'core/image', $blocks[0]['blockName'] );
		$this->assertStringContainsString( 'new alt', $blocks[0]['innerHTML'] );
		// And the comment attrs carry the attr-form value for peers.
		$this->assertSame( 'new alt', $blocks[0]['attrs']['alt'] );
	}

	public function test_wrapper_refresh_survives_materialization() {
		$engine  = $this->engine();
		$room    = 'postType/post:' . self::$post_id;
		$sync_id = WP_Intent_Log_Planner::genesis_sync_id( self::$post_id, 0, array( 0 ) );
		$engine->materialize( $room ); // Initialize genesis.

		// An alignment-class wrapper refresh (the bridge derives this from
		// the block's save markup whenever it changes).
		$result = $engine->handle_updates(
			$room,
			302,
			0,
			array(
				self::intent_update(
					array(
						'intentId' => 'i-w2',
						'baseSeq'  => 0,
						'type'     => 'set_attr',
						'payload'  => array(
							'syncId'          => $sync_id,
							'key'             => '_wrapper',
							'value'           => array(
								'open'  => '<figure class="wp-block-image alignwide size-large">',
								'close' => '</figure>',
							),
							'observedVersion' => 0,
						),
					)
				),
			),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringContainsString(
			'<figure class="wp-block-image alignwide size-large">',
			(string) $this->engine()->materialize( $room )
		);
	}
}
