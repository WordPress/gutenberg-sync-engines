<?php
/**
 * The collaborative-editing framework (now carried by this plugin under
 * includes/framework/) ships no engines or transports of its own: the
 * implementations come through the `wp_sync_engines` / `wp_sync_transports`
 * filters. These tests pin that contract — the registries are empty with
 * this plugin's own registrations taken off (so without an engine plugin,
 * real-time collaboration is effectively disabled) and the filters register
 * cleanly.
 *
 * @package GutenbergSyncEngines
 *
 * @group collaboration
 */
class Tests_Collaboration_WpSyncRegistriesEmptyByDefault extends WP_UnitTestCase {
	public function set_up() {
		parent::set_up();
		// This plugin registers its engines and transports on these filters
		// at boot; take them off to observe the framework's own default.
		// The test framework restores the hooks after each test.
		$plugin = Gutenberg_Sync_Engines_Plugin::instance();
		remove_filter( 'wp_sync_engines', array( $plugin, 'register_engines' ), 10 );
		remove_filter( 'wp_sync_transports', array( $plugin, 'register_transports' ), 10 );
	}

	private function storage(): WP_Sync_Post_Meta_Storage {
		return new WP_Sync_Post_Meta_Storage();
	}

	public function test_engine_registry_is_empty_by_default() {
		$registry = new WP_Sync_Engine_Registry( $this->storage() );

		$this->assertSame( array(), $registry->get_engine_slugs() );
		$this->assertNull( $registry->get_engine_for_room( 'postType/post:1' ) );
		$this->assertSame( array(), $registry->get_all_update_types() );
	}

	public function test_transport_registry_is_empty_by_default() {
		$storage  = $this->storage();
		$registry = new WP_Sync_Transport_Registry( $storage, new WP_Sync_Engine_Registry( $storage ) );

		$this->assertSame( array(), $registry->get_transports() );
		$this->assertSame( '', $registry->get_active_slug() );
		$this->assertSame( array(), $registry->get_announced_slugs() );
	}

	public function test_engine_filter_registers_an_engine() {
		$stub = new class() implements WP_Sync_Engine {
			public function get_slug(): string {
				return 'stub-engine';
			}
			public function get_protocol_version(): int {
				return 1;
			}
			public function get_update_types(): array {
				return array( 'stub' );
			}
			// phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- Required interface parameters; this stub only tests registration.
			public function handle_updates( string $room, int $client_id, int $cursor, array $updates, array $context ) {
				return array( 'dispositions' => null );
			}
			// phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- Required interface parameters; this stub only tests registration.
			public function get_updates_since( string $room, int $client_id, int $cursor, array $context ): array {
				return array( 'updates' => array() );
			}
		};

		add_filter(
			'wp_sync_engines',
			static function ( $engines ) use ( $stub ) {
				$engines[] = $stub;
				return $engines;
			}
		);
		update_option( 'wp_sync_engine', 'stub-engine' );

		$registry = new WP_Sync_Engine_Registry( $this->storage() );
		$this->assertSame( array( 'stub-engine' ), $registry->get_engine_slugs() );
		$this->assertInstanceOf( 'WP_Sync_Engine', $registry->get_engine_for_room( 'stub/room' ) );
		$this->assertSame( 'stub-engine', $registry->get_engine_for_room( 'stub/room' )->get_slug() );
	}

	public function test_transport_filter_registers_a_transport() {
		$stub = new class() implements WP_Sync_Transport {
			public function get_slug(): string {
				return 'stub-transport';
			}
			public function get_protocol_version(): int {
				return 1;
			}
			public function register_routes(): void {}
		};

		add_filter(
			'wp_sync_transports',
			static function ( $transports ) use ( $stub ) {
				$transports[] = $stub;
				return $transports;
			}
		);

		$storage  = $this->storage();
		$registry = new WP_Sync_Transport_Registry( $storage, new WP_Sync_Engine_Registry( $storage ) );
		$this->assertArrayHasKey( 'stub-transport', $registry->get_transports() );
		$this->assertSame( 'stub-transport', $registry->get_active_slug() );
		$this->assertSame( array( 'stub-transport' ), $registry->get_announced_slugs() );
	}
}
