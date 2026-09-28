<?php
/**
 * Replays a yjs-server room's stored rows one at a time (issue #38
 * diagnosis), printing the top-level block summary after each row so the
 * exact row that corrupts a block is visible.
 *
 * Usage (tests env):
 *   npm run env:tests -- run cli wp eval-file \
 *     wp-content/plugins/<plugin-dir>/tests/tools/trace-yjs-room-rows.php \
 *     "postType/post:<id>"
 *
 * @package gutenberg-sync-engines
 */

$gse_room = $args[0] ?? null;
if ( ! $gse_room ) {
	WP_CLI::error( 'Usage: wp eval-file trace-yjs-room-rows.php <room>' );
}

require_once __DIR__ . '/../../includes/lib/y-php-loader.php';
gutenberg_sync_engines_load_y_php();

$gse_storage = new WP_Sync_Table_Storage();
$gse_rows    = $gse_storage->get_updates_after_cursor( $gse_room, 0 );
WP_CLI::log( count( $gse_rows ) . ' rows' );

/**
 * One-line summary of a block subtree.
 *
 * @param mixed $block Block JSON.
 * @return string Summary.
 */
function gse_block_summary( $block ) {
	if ( $block instanceof stdClass ) {
		$block = (array) $block;
	}
	if ( ! is_array( $block ) ) {
		return '?';
	}
	$children = array();
	foreach ( (array) ( $block['innerBlocks'] ?? array() ) as $child ) {
		$children[] = gse_block_summary( $child );
	}
	$name  = preg_replace( '/^core\//', '', (string) ( $block['name'] ?? '?' ) );
	$valid = $block['isValid'] ?? null;
	$tag   = $name;
	if ( true !== $valid ) {
		$tag .= '[isValid=' . ( null === $valid ? 'MISSING' : ( false === $valid ? 'FALSE' : 'odd' ) ) . ']';
	}
	if ( isset( $block['_save'] ) ) {
		$tag .= '*'; // Carries a _save mirror.
	}
	return $tag . ( array() === $children ? '' : '(' . implode( ',', $children ) . ')' );
}

$gse_doc  = new \Yjs\Utils\Doc();
$gse_prev = '';
$gse_i    = 0;
foreach ( $gse_rows as $gse_row ) {
	++$gse_i;
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
		WP_CLI::log( "row {$gse_i}: SKIPPED (" . $e->getMessage() . ')' );
		continue;
	}

	$gse_record = $gse_doc->getMap( 'document' );
	$gse_blocks = $gse_record->get( 'blocks' );
	$gse_line   = '(no blocks array)';
	if ( $gse_blocks instanceof \Yjs\Types\YArray ) {
		$gse_parts = array();
		foreach ( $gse_blocks->toJSON() as $gse_block ) {
			$gse_parts[] = gse_block_summary( $gse_block );
		}
		$gse_line = implode( ' | ', $gse_parts );
	}
	$gse_label = $gse_row['type'] . ' by ' . ( $gse_row['client_id'] ?? '?' ) . ', ' . strlen( (string) $gse_row['data'] ) . 'b';
	if ( $gse_line === $gse_prev ) {
		WP_CLI::log( "row {$gse_i} ({$gse_label}): (blocks unchanged)" );
		continue;
	}
	$gse_prev = $gse_line;
	WP_CLI::log( "row {$gse_i} ({$gse_label}): {$gse_line}" );
}
