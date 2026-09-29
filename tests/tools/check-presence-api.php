<?php
/**
 * Drives this plugin's awareness and the advisory channel's tab list against
 * the REAL Presence API plugin, the other half of a PHPUnit suite that can
 * only use a stand-in.
 *
 * Usage (tests env, with the Presence API installed and active):
 *   npx wp-env --config .wp-env.tests.json run cli \
 *     wp plugin install presence-api --activate
 *   npx wp-env --config .wp-env.tests.json run cli \
 *     --env-cwd=wp-content/plugins/gutenberg-sync-engines \
 *     wp eval-file tests/tools/check-presence-api.php
 *
 * Exits non-zero on the first thing that does not hold.
 *
 * @package gutenberg-sync-engines
 */

global $wpdb;

$gse_failures = 0;

/**
 * Prints one result and remembers a failure.
 *
 * @param bool   $ok     Whether the check held.
 * @param string $label  What was checked.
 * @param string $detail Optional context to print alongside.
 */
function gse_presence_check( $ok, $label, $detail = '' ) {
	global $gse_failures;

	if ( ! $ok ) {
		++$gse_failures;
	}

	WP_CLI::log( ( $ok ? '  ok   ' : '  FAIL ' ) . $label . ( '' !== $detail ? " -- {$detail}" : '' ) );
}

if ( ! function_exists( 'wp_set_presence' ) ) {
	WP_CLI::error( 'The Presence API plugin is not active on this site.' );
}
if ( ! class_exists( 'WP_Sync_Awareness' ) ) {
	WP_CLI::error( 'This plugin is not active on this site.' );
}

$gse_user_id = (int) get_users(
	array(
		'role'   => 'administrator',
		'number' => 1,
		'fields' => 'ID',
	)
)[0];
wp_set_current_user( $gse_user_id );

$gse_post_id = wp_insert_post(
	array(
		'post_title'  => 'presence api check',
		'post_status' => 'draft',
	)
);
$gse_room    = 'postType/post:' . $gse_post_id;
$gse_state   = array(
	'name'     => 'Ada',
	'gseBlock' => 'p1',
);

/**
 * One stored presence row, straight from the table.
 *
 * @param string $room      Room identifier.
 * @param string $client_id The row's client id.
 * @return object|null The row, or null when there is none.
 */
function gse_presence_row( $room, $client_id ) {
	global $wpdb;

	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	return $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM {$wpdb->presence} WHERE room = %s AND client_id = %s", $room, $client_id )
	);
}

// The seam picks the backend up at all.
gse_presence_check( WP_Sync_Presence_API_Awareness_Backend::is_available(), 'the backend reports itself available' );
gse_presence_check( WP_Sync_Awareness::has_substitute_backend(), 'the seam picked the Presence API backend' );

$gse_awareness = new WP_Sync_Awareness( wp_get_sync_storage() );

// A write lands in the real table and comes back out of it unchanged.
$gse_entries = $gse_awareness->put( $gse_room, 7, $gse_state, $gse_user_id, 30 );
gse_presence_check( array( 7 ) === array_column( $gse_entries, 'client_id' ), 'a write returns the room' );
gse_presence_check( $gse_state === $gse_entries[0]['state'], 'state round trips', wp_json_encode( $gse_entries[0]['state'] ) );
gse_presence_check( $gse_user_id === $gse_entries[0]['wp_user_id'], 'the user id round trips' );
gse_presence_check( null !== gse_presence_row( $gse_room, 'gse-7' ), 'the row is in wp_presence' );
gse_presence_check( array() === wp_get_sync_storage()->get_awareness_state( $gse_room ), 'the room array stayed empty' );

// One client's write leaves another's row alone.
$gse_entries = $gse_awareness->put( $gse_room, 9, array( 'name' => 'Grace' ), $gse_user_id, 30 );
gse_presence_check( array( 7, 9 ) === array_column( $gse_entries, 'client_id' ), 'two clients coexist' );

// An idle client repeating its state writes nothing.
$gse_writes = 0;
add_filter(
	'query',
	static function ( $query ) use ( &$gse_writes ) {
		if ( false !== stripos( $query, 'INSERT INTO' ) && false !== stripos( $query, 'presence' ) ) {
			++$gse_writes;
		}
		return $query;
	}
);
$gse_awareness->put( $gse_room, 7, $gse_state, $gse_user_id, 30 );
gse_presence_check( 0 === $gse_writes, 'an idle repeat is read-only', "writes={$gse_writes}" );

// A quiet client past this backend's refresh age IS rewritten, at the oldest
// age the Presence API's own skip would still have left the row alone. Both
// ages are read off the code rather than guessed, and the check below pins
// that the one is in fact past the other.
$gse_refresh = max( 1, intdiv( 30, WP_Sync_Presence_API_Awareness_Backend::REFRESH_FRACTION ) );
$gse_skip    = function_exists( 'wp_presence_refresh_threshold' ) ? wp_presence_refresh_threshold() : $gse_refresh;

gse_presence_check(
	$gse_skip >= $gse_refresh,
	'the Presence API would skip a row this backend refreshes',
	"skip={$gse_skip}s refresh={$gse_refresh}s"
);

// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query(
	$wpdb->prepare(
		"UPDATE {$wpdb->presence} SET date_gmt = %s WHERE room = %s AND client_id = %s",
		gmdate( 'Y-m-d H:i:s', time() - $gse_skip ),
		$gse_room,
		'gse-7'
	)
);

$gse_awareness->put( $gse_room, 7, $gse_state, $gse_user_id, 30 );
$gse_age = time() - (int) strtotime( gse_presence_row( $gse_room, 'gse-7' )->date_gmt . ' UTC' );
gse_presence_check( $gse_age <= 1, 'a quiet client is refreshed anyway', "age={$gse_age}s" );

// Rows the Presence API keeps for its own screens are not collaborators,
// and a collaborator leaving does not disturb them.
wp_set_presence( $gse_room, 'editor-' . $gse_user_id, array(), $gse_user_id );
gse_presence_check( array( 7, 9 ) === array_column( $gse_awareness->entries( $gse_room, 30 ), 'client_id' ), 'rows without the gse- prefix are ignored' );

$gse_entries = $gse_awareness->forget( $gse_room, 7, 30 );
gse_presence_check( array( 9 ) === array_column( $gse_entries, 'client_id' ), 'leaving removes one client' );
gse_presence_check( null !== gse_presence_row( $gse_room, 'editor-' . $gse_user_id ), "the Presence API's own row survives" );

$gse_tab_list = apply_filters( 'wp_sync_tab_list_backend', null );
gse_presence_check( $gse_tab_list instanceof WP_Sync_Presence_API_Tab_List_Backend, 'the seam picked the Presence API tab list' );

$gse_ttl = Gutenberg_Sync_Engines_Advisory_Presence::PRESENCE_TTL;
$gse_tab = array(
	'c' => 'Ada',
	'j' => 1,
);
$gse_tab_list->put( $gse_room, 'tok-a', $gse_tab, $gse_user_id, $gse_ttl );
$gse_tab_list->put( $gse_room, 'tok-b', array( 'c' => 'Grace' ), $gse_user_id, $gse_ttl );
$gse_tabs = $gse_tab_list->tabs( $gse_room, $gse_ttl );
gse_presence_check( array( 'tok-a', 'tok-b' ) === array_keys( $gse_tabs ), 'two tabs coexist', wp_json_encode( array_keys( $gse_tabs ) ) );
gse_presence_check( $gse_tab === $gse_tabs['tok-a']['state'], 'tab state round trips' );
gse_presence_check( $gse_user_id === $gse_tabs['tok-a']['user_id'], 'the tab user id round trips' );

// The row lives as long as the channel asked, not the site's shorter default.
$gse_row      = gse_presence_row( $gse_room, 'gsetab-tok-a' );
$gse_lifetime = null === $gse_row ? 0 : strtotime( $gse_row->expires_gmt . ' UTC' ) - strtotime( $gse_row->date_gmt . ' UTC' );
gse_presence_check( $gse_ttl === $gse_lifetime, 'a tab row lasts as long as asked', "lifetime={$gse_lifetime}s" );

// A refresh the Presence API would skip as too recent is still written.
// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query(
	$wpdb->prepare(
		"UPDATE {$wpdb->presence} SET date_gmt = %s WHERE room = %s AND client_id = %s",
		gmdate( 'Y-m-d H:i:s', time() - 5 ),
		$gse_room,
		'gsetab-tok-a'
	)
);
$gse_tab_list->put( $gse_room, 'tok-a', $gse_tab, $gse_user_id, $gse_ttl );
$gse_age = time() - (int) strtotime( gse_presence_row( $gse_room, 'gsetab-tok-a' )->date_gmt . ' UTC' );
gse_presence_check( $gse_age <= 1, 'a tab refresh is always written', "age={$gse_age}s" );

gse_presence_check( array( 9 ) === array_column( $gse_awareness->entries( $gse_room, 30 ), 'client_id' ), 'awareness ignores tab rows' );
gse_presence_check( ! isset( $gse_tabs['9'] ) && 2 === count( $gse_tabs ), 'the tab list ignores awareness rows' );

$gse_tab_list->forget( $gse_room, 'tok-b' );
gse_presence_check( array( 'tok-a' ) === array_keys( $gse_tab_list->tabs( $gse_room, $gse_ttl ) ), 'leaving removes one tab' );

// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->presence} WHERE room = %s", $gse_room ) );
wp_delete_post( $gse_post_id, true );

if ( $gse_failures > 0 ) {
	WP_CLI::error( $gse_failures . ' check(s) failed.' );
}

WP_CLI::success( 'Awareness and the tab list work against the real Presence API.' );
