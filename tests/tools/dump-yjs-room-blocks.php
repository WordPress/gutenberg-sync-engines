<?php
/**
 * Dumps a yjs-server room's block tree (issue #38 diagnosis): each block's
 * clientId, whether it still carries a `_save` mirror, whether the room
 * wrapper map has an entry for it — then the engine's materialized content,
 * where a container that lost both renders WITHOUT its wrapper element.
 *
 * Usage (tests env):
 *   npm run env:tests -- run cli wp eval-file \
 *     wp-content/plugins/<plugin-dir>/tests/tools/dump-yjs-room-blocks.php \
 *     "postType/post:<id>"
 *
 * @package gutenberg-sync-engines
 */

$gse_room = $args[0] ?? null;
if ( ! $gse_room ) {
	WP_CLI::error( 'Usage: wp eval-file dump-yjs-room-blocks.php <room>' );
}

require_once __DIR__ . '/../../includes/lib/y-php-loader.php';
gutenberg_sync_engines_load_y_php();

$gse_storage = new WP_Sync_Table_Storage();
$gse_storage->get_updates_after_cursor( $gse_room, 0 );
$gse_meta     = $gse_storage->get_room_meta( $gse_room, 'yjs_server_doc' );
$gse_wrappers = $gse_storage->get_room_meta( $gse_room, 'yjs_server_wrappers' );
$gse_wrappers = is_array( $gse_wrappers ) ? $gse_wrappers : array();

if ( ! is_array( $gse_meta ) || ! is_string( $gse_meta['doc'] ?? null ) ) {
	WP_CLI::error( 'No canonical doc for room ' . $gse_room );
}

$gse_doc = new \Yjs\Utils\Doc();
\Yjs\applyUpdateV2( $gse_doc, \Yjs\Lib0\Buffer::fromBase64( $gse_meta['doc'] ) );

// Apply rows past the stamped cursor, like load_room does.
$gse_rows = $gse_storage->get_updates_after_cursor( $gse_room, (int) ( $gse_meta['cursor'] ?? 0 ) );
foreach ( $gse_rows as $gse_row ) {
	try {
		if ( 'snapshot' === $gse_row['type'] ) {
			$gse_decoded = json_decode( $gse_row['data'], true );
			if ( is_array( $gse_decoded ) && is_string( $gse_decoded['doc'] ?? null ) ) {
				\Yjs\applyUpdateV2( $gse_doc, \Yjs\Lib0\Buffer::fromBase64( $gse_decoded['doc'] ) );
			}
		} else {
			\Yjs\applyUpdateV2( $gse_doc, \Yjs\Lib0\Buffer::fromBase64( (string) $gse_row['data'] ) );
		}
	} catch ( \Throwable $e ) {
		WP_CLI::log( 'row skipped: ' . $e->getMessage() );
	}
}

$gse_record = $gse_doc->getMap( 'document' );
$gse_blocks = $gse_record->get( 'blocks' );
if ( ! ( $gse_blocks instanceof \Yjs\Types\YArray ) ) {
	WP_CLI::error( 'No blocks array' );
}

/**
 * Prints one block subtree.
 *
 * @param array $block    Block JSON.
 * @param array $wrappers Wrapper map.
 * @param int   $depth    Indent depth.
 */
function gse_dump_block( $block, $wrappers, $depth = 0 ) {
	if ( $block instanceof stdClass ) {
		$block = (array) $block;
	}
	$attrs = $block['attributes'] ?? array();
	if ( $attrs instanceof stdClass ) {
		$attrs = (array) $attrs;
	}
	$cid  = $block['clientId'] ?? '?';
	$save = isset( $block['_save'] ) ? (string) wp_json_encode( $block['_save'] ) : '(none)';
	$wrap = isset( $wrappers[ $cid ] ) ? 'wrapper:YES' : 'wrapper:no';
	WP_CLI::log(
		str_repeat( '  ', $depth ) . ( $block['name'] ?? '?' )
		. ' cid=' . $cid
		. ' isValid=' . (string) wp_json_encode( $block['isValid'] ?? null )
		. ' ' . $wrap
		. ' _save=' . $save
	);
	foreach ( (array) ( $block['innerBlocks'] ?? array() ) as $child ) {
		gse_dump_block( $child, $wrappers, $depth + 1 );
	}
}

foreach ( $gse_blocks->toJSON() as $gse_block ) {
	gse_dump_block( $gse_block, $gse_wrappers );
}
WP_CLI::log( 'wrapper keys: ' . implode( ', ', array_keys( $gse_wrappers ) ) );

$gse_engine = new WP_Yjs_Server_Engine( new WP_Sync_Table_Storage() );
WP_CLI::log( '--- materialized ---' );
WP_CLI::log( (string) $gse_engine->materialize( $gse_room ) );
