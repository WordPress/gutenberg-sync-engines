<?php
/**
 * Tests for the plugin's table storage: the WP_Sync_Storage contract
 * (cursors, ordering, lineage, awareness) plus the optional capabilities
 * engines feature-detect (room meta, non-creating reads, reset), all
 * against the real tables.
 *
 * @package Gutenberg
 *
 * @group collaboration
 */
class Tests_Collaboration_WpSyncTableStorage extends WP_UnitTestCase {
	private function storage(): WP_Sync_Table_Storage {
		return new WP_Sync_Table_Storage();
	}

	private function room(): string {
		return 'postType/post:' . wp_rand( 100000, 999999 );
	}

	public function test_the_plugin_substitutes_table_storage_for_the_framework_default() {
		$this->assertInstanceOf( 'WP_Sync_Table_Storage', wp_get_sync_storage() );
		$this->assertInstanceOf( 'WP_Sync_Table_Storage', gutenberg_sync_engines_storage() );
	}

	public function test_a_storage_another_plugin_substituted_is_respected() {
		$other = new WP_Sync_Bench_Memory_Storage_Stub();
		$early = static function () use ( $other ) {
			return $other;
		};
		add_filter( '__unstable_wp_sync_storage', $early, 5 );
		$resolved = wp_get_sync_storage();
		remove_filter( '__unstable_wp_sync_storage', $early, 5 );

		$this->assertSame( $other, $resolved );
	}

	public function test_updates_come_back_in_order_after_the_cursor() {
		$storage = $this->storage();
		$room    = $this->room();

		$this->assertSame( array(), $storage->get_updates_after_cursor( $room, 0 ) );
		$this->assertSame( 0, $storage->get_cursor( $room ) );
		$this->assertSame( 0, $storage->get_update_count( $room ) );

		$this->assertTrue( $storage->add_update( $room, array( 'n' => 1 ) ) );
		$this->assertTrue( $storage->add_update( $room, array( 'n' => 2 ) ) );
		$this->assertTrue( $storage->add_update( $room, 'three' ) );

		$this->assertSame( array( array( 'n' => 1 ), array( 'n' => 2 ), 'three' ), $storage->get_updates_after_cursor( $room, 0 ) );
		$cursor = $storage->get_cursor( $room );
		$this->assertGreaterThan( 0, $cursor );
		$this->assertSame( 3, $storage->get_update_count( $room ) );

		$this->assertSame( array(), $storage->get_updates_after_cursor( $room, $cursor ) );
		$this->assertSame( array( 'three' ), $storage->get_updates_after_cursor( $room, $cursor - 1 ) );
	}

	public function test_the_cursor_is_the_rows_insert_id() {
		global $wpdb;
		$storage = $this->storage();
		$room    = $this->room();

		$storage->add_update( $room, 'a' );
		$insert_id = (int) $wpdb->insert_id;
		$storage->get_updates_after_cursor( $room, 0 );

		$this->assertSame( $insert_id, $storage->get_cursor( $room ) );
	}

	public function test_meta_and_lineage_writes_leave_insert_id_naming_the_last_update_row() {
		global $wpdb;
		$storage = $this->storage();
		$room    = $this->room();

		// Push the meta table's counter well past the update table's.
		for ( $i = 0; $i < 5; $i++ ) {
			$storage->set_room_meta( $room . '-warm', 'k' . $i, $i );
		}

		$storage->add_update( $room, 'row' );
		$row_id = (int) $wpdb->insert_id;
		$this->assertGreaterThan( 0, $row_id );

		$storage->set_room_engine( $room, 'yjs-server' );
		$storage->set_room_meta( $room, 'wrappers', array( 'w' ) );
		$storage->set_room_meta( $room, 'wrappers', array( 'w', 'w2' ) );
		$storage->set_awareness_state( $room, array( array( 'client_id' => 1 ) ) );

		$this->assertSame( $row_id, (int) $wpdb->insert_id, 'Engines read the cursor of the row they just appended after stamping lineage and meta.' );
	}

	public function test_cursor_caches_refresh_only_on_read() {
		$storage = $this->storage();
		$room    = $this->room();

		$storage->add_update( $room, 'a' );
		$this->assertSame( 0, $storage->get_cursor( $room ), 'A write must not touch the cursor cache.' );
		$this->assertSame( 0, $storage->get_update_count( $room ) );

		$storage->get_updates_after_cursor( $room, PHP_INT_MAX );
		$this->assertGreaterThan( 0, $storage->get_cursor( $room ), 'An empty far-cursor read still refreshes the cache.' );
		$this->assertSame( 1, $storage->get_update_count( $room ) );
	}

	public function test_rooms_are_isolated() {
		$storage = $this->storage();
		$a       = $this->room();
		$b       = $a . '-other';

		$storage->add_update( $a, 'in a' );
		$storage->add_update( $b, 'in b' );

		$this->assertSame( array( 'in a' ), $storage->get_updates_after_cursor( $a, 0 ) );
		$this->assertSame( array( 'in b' ), $storage->get_updates_after_cursor( $b, 0 ) );
	}

	public function test_trimming_keeps_cursors_monotonic() {
		$storage = $this->storage();
		$room    = $this->room();

		$storage->add_update( $room, 'one' );
		$storage->add_update( $room, 'two' );
		$storage->get_updates_after_cursor( $room, 0 );
		$before = $storage->get_cursor( $room );

		$this->assertTrue( $storage->remove_updates_before_cursor( $room, $before ) );
		$this->assertSame( array( 'two' ), $storage->get_updates_after_cursor( $room, 0 ), 'The row AT the cursor survives.' );
		$this->assertSame( 1, $storage->get_update_count( $room ) );

		$storage->add_update( $room, 'three' );
		$storage->get_updates_after_cursor( $room, 0 );
		$this->assertGreaterThan( $before, $storage->get_cursor( $room ), 'Ids are never reused after a trim.' );
	}

	public function test_engine_lineage_is_write_once() {
		$storage = $this->storage();
		$room    = $this->room();

		$this->assertNull( $storage->get_room_engine( $room ) );
		$this->assertNull( $storage->peek_room_engine( $room ) );

		$this->assertTrue( $storage->set_room_engine( $room, 'intent-log' ) );
		$this->assertTrue( $storage->set_room_engine( $room, 'yjs-server' ), 'A second stamp is a harmless no-op.' );

		$this->assertSame( 'intent-log', $storage->get_room_engine( $room ) );
		$this->assertSame( 'intent-log', ( new WP_Sync_Table_Storage() )->peek_room_engine( $room ) );
	}

	public function test_looking_at_a_room_never_creates_it() {
		$storage = $this->storage();
		$room    = $this->room();

		$storage->get_room_engine( $room );
		$storage->peek_room_engine( $room );
		$storage->get_room_meta( $room, 'anything' );
		$storage->get_awareness_state( $room );
		$storage->get_updates_after_cursor( $room, 0 );

		$this->assertFalse( $storage->get_room_size( $room )['found'] );
		$this->assertSame( array(), array_filter( $storage->list_rooms(), static fn( $r ) => $r['room'] === $room ) );
	}

	public function test_awareness_is_whole_array_last_writer_wins() {
		$storage = $this->storage();
		$room    = $this->room();

		$this->assertSame( array(), $storage->get_awareness_state( $room ) );

		$this->assertTrue(
			$storage->set_awareness_state(
				$room,
				array(
					5 => array( 'client_id' => 5 ),
					7 => array( 'client_id' => 7 ),
				)
			)
		);
		$this->assertSame( array( array( 'client_id' => 5 ), array( 'client_id' => 7 ) ), $storage->get_awareness_state( $room ) );

		$this->assertTrue( $storage->set_awareness_state( $room, array( array( 'client_id' => 9 ) ) ) );
		$this->assertSame( array( array( 'client_id' => 9 ) ), $storage->get_awareness_state( $room ) );

		$this->assertTrue( $storage->set_awareness_state( $room, array() ) );
		$this->assertSame( array(), $storage->get_awareness_state( $room ) );
	}

	public function test_room_versions_change_on_every_write_and_read_in_one_lookup() {
		global $wpdb;
		$storage = $this->storage();
		$room    = $this->room();
		$other   = $room . '-other';

		$this->assertSame(
			array(
				$room  => null,
				$other => null,
			),
			$storage->get_room_versions( array( $room, $other ) ),
			'Never written: no counter.'
		);

		$storage->add_update( $room, 'a' );
		$this->assertSame( '1', $storage->get_room_versions( array( $room ) )[ $room ] );
		$storage->set_awareness_state( $room, array( array( 'client_id' => 1 ) ) );
		$storage->set_room_meta( $room, 'k', 'v' );
		$storage->set_room_engine( $room, 'intent-log' );
		$storage->add_update( $other, 'b' );

		$before   = $wpdb->num_queries;
		$versions = $storage->get_room_versions( array( $room, $other, str_repeat( 'x', 1000 ) ) );
		$this->assertSame( 1, $wpdb->num_queries - $before, 'All rooms in one query.' );
		$this->assertSame(
			array(
				$room  => '3',
				$other => '1',
			),
			$versions,
			'Every notified write bumps (lineage stamping is not one); an unstorable room is left out.'
		);

		$storage->reset_room( $room );
		$this->assertSame( array( $room => null ), $storage->get_room_versions( array( $room ) ), 'A reset leaves no row; absence is the change.' );
		$storage->add_update( $room, 'c' );
		$this->assertSame( '1', $storage->get_room_versions( array( $room ) )[ $room ] );
	}

	public function test_room_versions_live_only_in_a_persistent_object_cache() {
		$this->with_persistent_object_cache(
			function () {
				global $wpdb;
				$storage = $this->storage();
				$room    = $this->room();

				$storage->add_update( $room, 'a' );
				$storage->set_awareness_state( $room, array( array( 'client_id' => 1 ) ) );
				$this->assertSame( '2', $storage->get_room_versions( array( $room ) )[ $room ] );
				$this->assertSame(
					'0',
					$wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->sync_room_meta} WHERE room = %s AND meta_key = %s", $room, WP_Sync_Table_Storage::VERSION_KEY ) ),
					'Never a row with a persistent cache.'
				);

				$storage->reset_room( $room );
				$this->assertSame( '3', $storage->get_room_versions( array( $room ) )[ $room ], 'A cached counter is kept and bumped by a reset.' );
			}
		);
	}

	/**
	 * Runs a callback with `wp_using_ext_object_cache()` reporting a
	 * persistent cache. The test suite's in-memory cache stands in for it:
	 * within one test it outlives every storage instance, like a real
	 * persistent cache outlives requests.
	 *
	 * @param callable $callback What to run.
	 */
	private function with_persistent_object_cache( callable $callback ): void {
		// The flag is null in the PHPUnit bootstrap, and passing null back
		// would leave it set: restore an explicit false in that case.
		$previous = wp_using_ext_object_cache( true );
		try {
			$callback();
		} finally {
			wp_using_ext_object_cache( (bool) $previous );
		}
	}

	private function count_queries( callable $callback ): int {
		global $wpdb;
		$before = $wpdb->num_queries;
		$callback();
		return $wpdb->num_queries - $before;
	}

	public function test_with_a_persistent_object_cache_awareness_never_touches_the_tables() {
		global $wpdb;
		$room = $this->room();

		$this->with_persistent_object_cache(
			function () use ( $room, $wpdb ) {
				$entries = array(
					array(
						'client_id'  => 5,
						'state'      => array( 'user' => 'five' ),
						'updated_at' => 100,
						'wp_user_id' => 1,
					),
				);

				$queries = $this->count_queries(
					function () use ( $room, $entries ) {
						$this->assertSame( array(), $this->storage()->get_awareness_state( $room ) );
						$this->assertTrue( $this->storage()->set_awareness_state( $room, $entries ) );
						$this->assertSame( $entries, $this->storage()->get_awareness_state( $room ), 'A fresh instance reads what another wrote.' );
					}
				);
				$this->assertSame( 0, $queries, 'Presence lives in the cache only.' );

				$this->assertNull(
					$wpdb->get_var( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->sync_room_meta} WHERE room = %s AND meta_key = %s", $room, WP_Sync_Table_Storage::AWARENESS_KEY ) ),
					'No awareness row is written.'
				);

				$this->assertTrue( $this->storage()->reset_room( $room ) );
				$this->assertSame( array(), $this->storage()->get_awareness_state( $room ), 'A reset forgets the cached presence.' );
			}
		);
	}

	public function test_with_a_persistent_object_cache_the_write_once_keys_are_read_once() {
		$room = $this->room();

		$this->with_persistent_object_cache(
			function () use ( $room ) {
				$storage = $this->storage();

				// Absence is never cached: an unstamped room is re-read.
				$this->assertSame( 1, $this->count_queries( fn() => $this->assertNull( $storage->get_room_engine( $room ) ) ) );
				$this->assertSame( 1, $this->count_queries( fn() => $this->assertNull( $storage->get_room_engine( $room ) ) ) );

				$this->assertTrue( $storage->set_room_engine( $room, 'intent-log' ) );
				$this->assertSame( 0, $this->count_queries( fn() => $this->assertSame( 'intent-log', $this->storage()->get_room_engine( $room ) ) ), 'The read-back after stamping primed the cache.' );

				$this->assertSame( 1, $this->count_queries( fn() => $this->assertNull( $storage->get_room_meta( $room, WP_Sync_Table_Storage::GENERATION_KEY ) ) ) );
				$this->assertTrue( $storage->set_room_meta( $room, WP_Sync_Table_Storage::GENERATION_KEY, 'g7' ) );
				$this->assertSame( 1, $this->count_queries( fn() => $this->assertSame( 'g7', $this->storage()->get_room_meta( $room, WP_Sync_Table_Storage::GENERATION_KEY ) ) ), 'First read after the write hits the table.' );
				$this->assertSame( 0, $this->count_queries( fn() => $this->assertSame( 'g7', $this->storage()->get_room_meta( $room, WP_Sync_Table_Storage::GENERATION_KEY ) ) ), 'Second read is served from the cache.' );

				// Engine bookkeeping is never cached.
				$storage->set_room_meta( $room, 'checkpoint', array( 'cursor' => 3 ) );
				$this->assertSame( 1, $this->count_queries( fn() => $storage->get_room_meta( $room, 'checkpoint' ) ) );
				$this->assertSame( 1, $this->count_queries( fn() => $storage->get_room_meta( $room, 'checkpoint' ) ) );

				$this->assertTrue( $storage->reset_room( $room ) );
				$this->assertNull( $this->storage()->get_room_engine( $room ), 'A reset forgets the cached lineage.' );
				$this->assertNull( $this->storage()->get_room_meta( $room, WP_Sync_Table_Storage::GENERATION_KEY ), 'A reset forgets the cached generation.' );
			}
		);
	}

	public function test_without_a_persistent_object_cache_every_read_hits_the_tables() {
		$this->assertNotTrue( wp_using_ext_object_cache(), 'The suite runs without a persistent cache.' );
		$storage = $this->storage();
		$room    = $this->room();

		$storage->set_room_engine( $room, 'de-rtc' );
		$storage->set_awareness_state( $room, array( array( 'client_id' => 1 ) ) );

		$this->assertSame( 1, $this->count_queries( fn() => $this->assertSame( 'de-rtc', $storage->get_room_engine( $room ) ) ) );
		$this->assertSame( 1, $this->count_queries( fn() => $this->assertSame( 'de-rtc', $storage->get_room_engine( $room ) ) ) );
		$this->assertSame( 1, $this->count_queries( fn() => $this->assertCount( 1, $storage->get_awareness_state( $room ) ) ) );
		$this->assertSame( 1, $this->count_queries( fn() => $this->assertCount( 1, $storage->get_awareness_state( $room ) ) ) );
	}

	public function test_room_meta_round_trips_and_replaces() {
		$storage = $this->storage();
		$room    = $this->room();

		$this->assertNull( $storage->get_room_meta( $room, 'checkpoint' ) );

		$this->assertTrue(
			$storage->set_room_meta(
				$room,
				'checkpoint',
				array(
					'cursor' => 12,
					'seq'    => 3,
				)
			)
		);
		$this->assertSame(
			array(
				'cursor' => 12,
				'seq'    => 3,
			),
			$storage->get_room_meta( $room, 'checkpoint' )
		);

		$this->assertTrue( $storage->set_room_meta( $room, 'checkpoint', 42 ) );
		$this->assertSame( 42, $storage->get_room_meta( $room, 'checkpoint' ) );

		$this->assertTrue( $storage->set_room_meta( $room, 'floor', 'ünïcödé & "quotes"' ) );
		$this->assertSame( 'ünïcödé & "quotes"', $storage->get_room_meta( $room, 'floor' ) );

		$this->assertSame(
			array(
				'checkpoint' => 42,
				'floor'      => 'ünïcödé & "quotes"',
			),
			$storage->get_all_room_meta( $room ),
			'Engine meta only: the reserved lineage and awareness rows stay out.'
		);
	}

	public function test_a_large_value_survives() {
		$storage = $this->storage();
		$room    = $this->room();
		$blob    = str_repeat( 'x', 2 * 1024 * 1024 );

		$this->assertTrue( $storage->set_room_meta( $room, 'doc', $blob ) );
		$this->assertSame( $blob, $storage->get_room_meta( $room, 'doc' ) );

		$this->assertTrue( $storage->add_update( $room, array( 'data' => $blob ) ) );
		$this->assertSame( strlen( $blob ), strlen( $storage->get_updates_after_cursor( $room, 0 )[0]['data'] ) );
	}

	public function test_reset_room_deletes_everything_and_nothing_else() {
		$storage = $this->storage();
		$room    = $this->room();
		$other   = $room . '-keep';

		$storage->add_update( $room, 'row' );
		$storage->set_room_engine( $room, 'intent-log' );
		$storage->set_awareness_state( $room, array( array( 'client_id' => 1 ) ) );
		$storage->set_room_meta( $room, 'checkpoint', 1 );
		$storage->add_update( $other, 'other row' );
		$storage->set_room_engine( $other, 'de-rtc' );
		$storage->get_updates_after_cursor( $room, 0 );

		$this->assertTrue( $storage->reset_room( $room ) );

		$this->assertSame( array(), $storage->get_updates_after_cursor( $room, 0 ) );
		$this->assertSame( 0, $storage->get_cursor( $room ) );
		$this->assertNull( $storage->get_room_engine( $room ) );
		$this->assertSame( array(), $storage->get_awareness_state( $room ) );
		$this->assertNull( $storage->get_room_meta( $room, 'checkpoint' ) );
		$this->assertFalse( $storage->get_room_size( $room )['found'] );

		$this->assertSame( array( 'other row' ), $storage->get_updates_after_cursor( $other, 0 ) );
		$this->assertSame( 'de-rtc', $storage->get_room_engine( $other ) );

		$this->assertTrue( $storage->reset_room( $room ), 'A room with nothing stored is already reset.' );
	}

	public function test_diagnostic_reads_describe_the_room() {
		$storage = $this->storage();
		$room    = $this->room();

		$storage->set_room_engine( $room, 'yjs-server' );
		$storage->add_update(
			$room,
			array(
				'type' => 'a',
				'data' => 'first',
			)
		);
		$storage->add_update(
			$room,
			array(
				'type' => 'b',
				'data' => 'second',
			)
		);
		$storage->get_updates_after_cursor( $room, 0 );

		$listed = array_values( array_filter( $storage->list_rooms(), static fn( $r ) => $r['room'] === $room ) );
		$this->assertCount( 1, $listed );
		$this->assertSame( 'yjs-server', $listed[0]['engine'] );
		$this->assertSame( 2, $listed[0]['rows'] );
		$this->assertSame( $storage->get_cursor( $room ), $listed[0]['cursor'] );
		$this->assertNotSame( '', $listed[0]['last_update_gmt'] );

		$size = $storage->get_room_size( $room );
		$this->assertTrue( $size['found'] );
		$this->assertSame( 2, $size['rows'] );
		$this->assertSame( $storage->get_cursor( $room ), $size['cursor'] );
		$this->assertGreaterThan( 0, $size['bytes'] );

		$last = $storage->get_last_updates( $room, 1 );
		$this->assertCount( 1, $last );
		$this->assertSame( $storage->get_cursor( $room ), $last[0]['cursor'] );
		$this->assertSame( 'b', json_decode( $last[0]['data'], true )['type'] );
	}

	public function test_peek_room_reports_existence_and_row_bounds_without_creating() {
		$storage = $this->storage();
		$room    = $this->room();

		$this->assertSame(
			array(
				'found'        => false,
				'first_cursor' => 0,
				'cursor'       => 0,
			),
			$storage->peek_room( $room )
		);
		$this->assertFalse( $storage->get_room_size( $room )['found'], 'Peeking creates nothing.' );

		// Meta alone makes the room exist, with no row bounds.
		$storage->set_awareness_state( $room, array() );
		$this->assertSame(
			array(
				'found'        => true,
				'first_cursor' => 0,
				'cursor'       => 0,
			),
			$storage->peek_room( $room )
		);

		$storage->add_update( $room, array( 'type' => 'a' ) );
		$first = $storage->peek_room( $room );
		$this->assertTrue( $first['found'] );
		$this->assertGreaterThan( 0, $first['first_cursor'] );
		$this->assertSame( $first['first_cursor'], $first['cursor'] );

		$storage->add_update( $room, array( 'type' => 'b' ) );
		$storage->get_updates_after_cursor( $room, 0 );
		$second = $storage->peek_room( $room );
		$this->assertSame( $first['first_cursor'], $second['first_cursor'], 'The first row is stable.' );
		$this->assertSame( $storage->get_cursor( $room ), $second['cursor'] );
		$this->assertGreaterThan( $second['first_cursor'], $second['cursor'] );

		$this->assertTrue( $storage->reset_room( $room ) );
		$this->assertFalse( $storage->peek_room( $room )['found'] );
	}

	public function test_rooms_that_do_not_fit_the_column_are_refused() {
		$storage = $this->storage();
		$room    = str_repeat( 'r', 192 );

		$this->assertFalse( $storage->add_update( $room, 'x' ) );
		$this->assertFalse( $storage->set_room_engine( $room, 'intent-log' ) );
		$this->assertFalse( $storage->set_room_meta( $room, 'k', 'v' ) );
		$this->assertSame( array(), $storage->get_updates_after_cursor( $room, 0 ) );
		$this->assertNull( $storage->get_room_engine( $room ) );

		$fits = str_repeat( 'r', 191 );
		$this->assertTrue( $storage->add_update( $fits, 'x' ) );
		$this->assertSame( array( 'x' ), $storage->get_updates_after_cursor( $fits, 0 ) );
	}

	public function test_tables_follow_switch_to_blog() {
		if ( ! is_multisite() ) {
			$this->markTestSkipped( 'Requires multisite.' );
		}
		global $wpdb;

		$main = $wpdb->sync_updates;
		$site = self::factory()->blog->create();
		switch_to_blog( $site );
		$switched = $wpdb->sync_updates;
		restore_current_blog();

		$this->assertNotSame( $main, $switched );
		$this->assertSame( $main, $wpdb->sync_updates );
	}
}

/**
 * A stand-in "other plugin" storage for the substitution test.
 */
class WP_Sync_Bench_Memory_Storage_Stub implements WP_Sync_Storage {
	public function add_update( string $room, $update ): bool {
		return true;
	}
	public function get_awareness_state( string $room ): array {
		return array();
	}
	public function get_cursor( string $room ): int {
		return 0;
	}
	public function get_update_count( string $room ): int {
		return 0;
	}
	public function get_updates_after_cursor( string $room, int $cursor ): array {
		return array();
	}
	public function remove_updates_before_cursor( string $room, int $cursor ): bool {
		return true;
	}
	public function set_awareness_state( string $room, array $awareness ): bool {
		return true;
	}
	public function get_room_engine( string $room ): ?string {
		return null;
	}
	public function set_room_engine( string $room, string $engine ): bool {
		return true;
	}
}
