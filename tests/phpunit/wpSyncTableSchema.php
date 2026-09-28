<?php
/**
 * Tests for the storage tables' lifecycle: activation creates them, a
 * newer schema version upgrades them, deactivation leaves them alone, and
 * drop (uninstall / CLI) removes them.
 *
 * WP_UnitTestCase rewrites every CREATE TABLE / DROP TABLE into its
 * TEMPORARY form (the `query` filter), so tests that exercise the real
 * lifecycle lift those filters first (`real_ddl()`). Real DDL commits the
 * test's transaction, so each such test does its DDL before creating any
 * other data and leaves the tables installed for the next one.
 *
 * @package Gutenberg
 *
 * @group collaboration
 */
class Tests_Collaboration_WpSyncTableSchema extends WP_UnitTestCase {
	public function tear_down() {
		global $wpdb;

		parent::tear_down();

		// A test that dropped the tables committed that drop (real DDL ends
		// the test transaction), and anything it wrote afterwards — the
		// version option `install()` records — was just rolled back. Put
		// the schema back for the rest of the run, outside any transaction
		// so the option sticks (the connection stays in autocommit-off
		// mode between tests, hence the explicit COMMIT).
		wp_cache_delete( 'alloptions', 'options' );
		wp_cache_delete( WP_Sync_Table_Schema::DB_VERSION_OPTION, 'options' );
		if ( ! WP_Sync_Table_Schema::is_installed() || ! WP_Sync_Table_Schema::is_ready() ) {
			WP_Sync_Table_Schema::install();
			$wpdb->query( 'COMMIT' );
		}
	}

	/**
	 * Lets CREATE TABLE / DROP TABLE reach the database as written.
	 */
	private function real_ddl(): void {
		remove_filter( 'query', array( $this, '_create_temporary_tables' ) );
		remove_filter( 'query', array( $this, '_drop_temporary_tables' ) );
	}

	private function table_exists( string $table ): bool {
		global $wpdb;
		return $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) === $table;
	}

	public function test_table_names_are_registered_on_wpdb() {
		global $wpdb;

		$this->assertSame( $wpdb->prefix . 'sync_updates', $wpdb->sync_updates );
		$this->assertSame( $wpdb->prefix . 'sync_room_meta', $wpdb->sync_room_meta );
		$this->assertContains( 'sync_updates', $wpdb->tables );
		$this->assertContains( 'sync_room_meta', $wpdb->tables );

		WP_Sync_Table_Schema::register_tables();
		$this->assertSame( 1, count( array_keys( $wpdb->tables, 'sync_updates', true ) ), 'Registration is idempotent.' );
	}

	public function test_activation_creates_the_tables_and_records_the_version() {
		$this->real_ddl();
		WP_Sync_Table_Schema::drop();
		$this->assertFalse( WP_Sync_Table_Schema::is_installed() );
		$this->assertFalse( WP_Sync_Table_Schema::is_ready() );

		gutenberg_sync_engines_activate( false );

		$this->assertTrue( WP_Sync_Table_Schema::is_installed() );
		$this->assertTrue( WP_Sync_Table_Schema::is_ready() );
		$this->assertSame( WP_Sync_Table_Schema::DB_VERSION, (int) get_option( WP_Sync_Table_Schema::DB_VERSION_OPTION ) );
	}

	public function test_install_is_idempotent_and_keeps_rows() {
		$storage = new WP_Sync_Table_Storage();
		$storage->add_update( 'postType/post:1', 'kept' );

		$this->assertTrue( WP_Sync_Table_Schema::install() );
		$this->assertTrue( WP_Sync_Table_Schema::install() );

		$this->assertSame( array( 'kept' ), $storage->get_updates_after_cursor( 'postType/post:1', 0 ) );
	}

	public function test_maybe_upgrade_recreates_tables_when_no_version_is_recorded() {
		$this->real_ddl();
		WP_Sync_Table_Schema::drop();
		$this->assertFalse( WP_Sync_Table_Schema::is_installed() );

		$this->assertTrue( WP_Sync_Table_Schema::maybe_upgrade() );

		$this->assertTrue( WP_Sync_Table_Schema::is_installed() );
		$this->assertTrue( WP_Sync_Table_Schema::is_ready() );
	}

	public function test_maybe_upgrade_runs_when_the_recorded_version_is_behind() {
		update_option( WP_Sync_Table_Schema::DB_VERSION_OPTION, 0 );
		$this->assertFalse( WP_Sync_Table_Schema::is_ready() );

		$this->assertTrue( WP_Sync_Table_Schema::maybe_upgrade() );

		$this->assertTrue( WP_Sync_Table_Schema::is_ready() );
	}

	public function test_no_deactivation_hook_touches_the_tables() {
		global $wp_filter;

		$hook = 'deactivate_' . plugin_basename( GUTENBERG_SYNC_ENGINES_FILE );
		$this->assertArrayNotHasKey( $hook, $wp_filter, 'Deactivation must leave the tables and every room alone.' );
	}

	public function test_drop_removes_the_tables_and_the_version() {
		$this->real_ddl();
		global $wpdb;

		WP_Sync_Table_Schema::drop();

		$this->assertFalse( $this->table_exists( $wpdb->sync_updates ) );
		$this->assertFalse( $this->table_exists( $wpdb->sync_room_meta ) );
		$this->assertFalse( get_option( WP_Sync_Table_Schema::DB_VERSION_OPTION ) );
		$this->assertFalse( WP_Sync_Table_Schema::is_ready() );
	}

	public function test_the_storage_filter_falls_back_to_post_meta_while_the_tables_are_unusable() {
		update_option( WP_Sync_Table_Schema::DB_VERSION_OPTION, 0 );

		$this->assertInstanceOf( 'WP_Sync_Post_Meta_Storage', wp_get_sync_storage() );

		update_option( WP_Sync_Table_Schema::DB_VERSION_OPTION, WP_Sync_Table_Schema::DB_VERSION );
		$this->assertInstanceOf( 'WP_Sync_Table_Storage', wp_get_sync_storage() );
	}

	public function test_delete_all_rows_empties_every_room_but_keeps_the_tables() {
		global $wpdb;
		$storage = new WP_Sync_Table_Storage();
		$storage->add_update( 'postType/post:1', 'a' );
		$storage->set_room_engine( 'postType/post:2', 'de-rtc' );

		$this->assertTrue( WP_Sync_Table_Schema::delete_all_rows() );

		$this->assertTrue( $this->table_exists( $wpdb->sync_updates ) );
		$this->assertSame( array(), $storage->list_rooms() );
	}

	public function test_uninstall_script_drops_the_tables() {
		$this->real_ddl();
		global $wpdb;

		if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
			define( 'WP_UNINSTALL_PLUGIN', 'gutenberg-sync-engines/gutenberg-sync-engines.php' );
		}
		include dirname( GUTENBERG_SYNC_ENGINES_FILE ) . '/uninstall.php';

		$this->assertFalse( $this->table_exists( $wpdb->sync_updates ) );
		$this->assertFalse( $this->table_exists( $wpdb->sync_room_meta ) );
		$this->assertFalse( get_option( WP_Sync_Table_Schema::DB_VERSION_OPTION ) );
	}

	public function test_new_network_sites_get_tables_only_when_network_active() {
		$this->real_ddl();
		if ( ! is_multisite() ) {
			$this->markTestSkipped( 'Requires multisite.' );
		}
		global $wpdb;

		$this->assertSame( 10, has_action( 'wp_initialize_site', 'gutenberg_sync_engines_initialize_site' ) );

		$per_site = self::factory()->blog->create();
		switch_to_blog( $per_site );
		$exists_per_site = $this->table_exists( $wpdb->sync_updates );
		restore_current_blog();
		$this->assertFalse( $exists_per_site, 'A per-site activation model creates tables only where the plugin activates.' );

		update_site_option( 'active_sitewide_plugins', array( plugin_basename( GUTENBERG_SYNC_ENGINES_FILE ) => time() ) );
		$network_site = self::factory()->blog->create();
		delete_site_option( 'active_sitewide_plugins' );

		switch_to_blog( $network_site );
		$exists_network = $this->table_exists( $wpdb->sync_updates );
		restore_current_blog();
		$this->assertTrue( $exists_network );

		// Real DDL committed these sites; remove them (and their tables).
		wp_delete_site( $per_site );
		wp_delete_site( $network_site );
	}

	public function test_network_activation_creates_tables_on_every_site() {
		$this->real_ddl();
		if ( ! is_multisite() ) {
			$this->markTestSkipped( 'Requires multisite.' );
		}
		global $wpdb;

		$site_ids = array( self::factory()->blog->create(), self::factory()->blog->create() );

		gutenberg_sync_engines_activate( true );

		foreach ( $site_ids as $site_id ) {
			switch_to_blog( $site_id );
			$exists = $this->table_exists( $wpdb->sync_updates );
			restore_current_blog();
			$this->assertTrue( $exists, "Site {$site_id} has no tables." );
		}

		// Real DDL committed these sites; remove them (and their tables).
		foreach ( $site_ids as $site_id ) {
			wp_delete_site( $site_id );
		}
	}
}
