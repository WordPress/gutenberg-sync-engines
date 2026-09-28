/**
 * Sanitizes a captured collaboration-session fixture for sharing.
 *
 *   node tests/debugging/replay/sanitize.mjs fixture.json [out=sanitized.json]
 *
 * Mirrors the community RTC performance harness's sanitizer
 * (WordPress/distributed-rtc-performance-testing rtc-helpers.php
 * capture-sanitize), so fixtures from either capture pipeline sanitize the
 * same way:
 *
 * - keeps only frames that touch a `postType/post:` room, reduced to that
 *   one room;
 * - normalizes the room to `postType/post:0` (replay retargets it anyway)
 *   and `after` to 0 (replay tracks cursors itself);
 * - strips awareness (user names, colors) and the captured responses.
 *
 * Additively to the community format, this repo's exports carry `engine`,
 * `transport`, `base_title`, and `base_content` (the post state at capture
 * start, which replay uses to recreate the starting document); those are
 * preserved. NOTE: a sanitized fixture still contains the DOCUMENT CONTENT
 * — it lives in the update payloads (and `base_content`) by construction.
 * Sanitization removes user identity and site-specific ids, not the text
 * that was typed.
 */
import fs from 'node:fs';

const args = process.argv.slice( 2 );
const positional = args.filter( ( token ) => ! token.includes( '=' ) );
const named = Object.fromEntries(
	args
		.filter( ( token ) => token.includes( '=' ) )
		.map( ( token ) => {
			const eq = token.indexOf( '=' );
			return [ token.slice( 0, eq ), token.slice( eq + 1 ) ];
		} )
);

const inputPath = positional[ 0 ];
if ( ! inputPath ) {
	console.error(
		'Usage: node tests/debugging/replay/sanitize.mjs <fixture.json> [out=sanitized.json]'
	);
	process.exit( 1 );
}

const fixture = JSON.parse( fs.readFileSync( inputPath, 'utf8' ) );

const isPostRoom = ( room ) =>
	typeof room?.room === 'string' && room.room.startsWith( 'postType/post:' );

const frames = [];
for ( const frame of fixture.frames ?? [] ) {
	const postRoom = ( frame.request?.rooms ?? [] ).find( isPostRoom );
	if ( ! postRoom ) {
		continue;
	}
	frames.push( {
		n: frame.n ?? frames.length + 1,
		elapsed_ms: frame.elapsed_ms ?? 0,
		client_id: frame.client_id ?? 0,
		request: {
			rooms: [
				{
					room: 'postType/post:0',
					client_id: postRoom.client_id ?? frame.client_id ?? 0,
					awareness: {},
					after: 0,
					updates: postRoom.updates ?? [],
				},
			],
		},
	} );
}

const out = {
	session_id: fixture.session_id ?? '',
	frame_count: frames.length,
	// Additive keys from this repo's capture exports (absent from
	// community-harness fixtures; `?? ''` keeps the output shape stable).
	engine: fixture.engine ?? '',
	transport: fixture.transport ?? '',
	base_title: fixture.base_title ?? '',
	base_content: fixture.base_content ?? '',
	frames,
};

const json = JSON.stringify( out );
if ( named.out ) {
	fs.writeFileSync( named.out, json + '\n' );
	console.error(
		`sanitized ${ frames.length }/${
			( fixture.frames ?? [] ).length
		} frames -> ${ named.out }`
	);
} else {
	console.log( json );
}
