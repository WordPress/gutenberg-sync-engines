/**
 * Replays a captured collaboration-session fixture against a live site as
 * real HTTP traffic — the capture→sanitize→replay lane adopted from the
 * community RTC performance harness
 * (WordPress/distributed-rtc-performance-testing), speaking its fixture
 * format (either a raw `wp collaboration capture export` or a sanitized
 * fixture from sanitize.mjs).
 *
 *   node tests/debugging/replay/replay.mjs fixture.json [--speed=1] [--json=out.json]
 *
 * Each captured frame is re-sent to POST /wp-json/wp-sync/v1/updates at its
 * captured offset (scaled by `speed`), retargeted at a fresh post seeded
 * from the fixture's `base_title`/`base_content` so engines that validate
 * against server state see the document the session actually started from.
 * Frames replay on per-client lanes: a client's frames stay ordered (its
 * cursor comes from its previous response), while different clients
 * interleave concurrently like the captured session did.
 *
 * Requests carry the community harness's tags (X-RTC-Test / X-RTC-Scenario
 * / X-RTC-Approach), so a site with this plugin's diagnostics enabled logs
 * server-side metrics per request — the tool prints that report after the
 * replay (see includes/diagnostics/class-gutenberg-sync-engines-request-log.php).
 *
 * Arguments (--key=value flags):
 *
 *   --fixture=    fixture path (or first positional argument)
 *   --speed=      time scale: 2 = twice as fast, 0 = no pacing (default 1)
 *   --post=       replay into this existing post id instead of creating one
 *   --scenario=   scenario label for tagged requests (default: replay)
 *   --approach=   approach label; default lets the server auto-label
 *                 <engine>/<transport>
 *   --force       replay even when the fixture's engine differs from the
 *                 site's active engine (expect voids/409s — the room fence
 *                 and update-type validation are engine-specific)
 *   --clearlog    DELETE the server-side benchmark log before replaying
 *   --json=       write the full per-frame results as JSON here
 *
 * Environment: WP_BASE_URL (default http://localhost:8889, the wp-env
 * tests site), WP_USERNAME/WP_PASSWORD (default admin/password). The user
 * must be able to edit the target post. Collaboration must be enabled on
 * the site (the route 404s otherwise).
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const BASE = process.env.WP_BASE_URL ?? 'http://localhost:8889';
const USER = process.env.WP_USERNAME ?? 'admin';
const PASS = process.env.WP_PASSWORD ?? 'password';

const { values: opts, positionals } = parseArgs( {
	allowPositionals: true,
	options: {
		fixture: { type: 'string' },
		speed: { type: 'string', default: '1' },
		post: { type: 'string' },
		scenario: { type: 'string', default: 'replay' },
		approach: { type: 'string' },
		force: { type: 'boolean', default: false },
		clearlog: { type: 'boolean', default: false },
		json: { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false },
	},
} );

const FIXTURE_PATH = opts.fixture ?? positionals[ 0 ];
const SPEED = Number( opts.speed );
const SCENARIO = opts.scenario;
const APPROACH = opts.approach ?? null;
const FORCE = opts.force;
const CLEAR_LOG = opts.clearlog;
const JSON_PATH = opts.json ?? null;

if ( opts.help || ! FIXTURE_PATH ) {
	console.error(
		'Usage: node tests/debugging/replay/replay.mjs <fixture.json> [--speed=1] [--post=<id>] [--scenario=<label>] [--approach=<label>] [--force] [--clearlog] [--json=out.json]'
	);
	process.exit( opts.help ? 0 : 1 );
}
if ( ! Number.isFinite( SPEED ) || SPEED < 0 ) {
	throw new Error( 'speed must be a non-negative number (0 = no pacing)' );
}

/**
 * Minimal cookie jar: collects Set-Cookie values across responses and
 * serializes them into a Cookie header (Node's fetch does not keep
 * cookies).
 */
class CookieJar {
	constructor() {
		this.cookies = new Map();
	}

	absorb( response ) {
		const raw =
			typeof response.headers.getSetCookie === 'function'
				? response.headers.getSetCookie()
				: [ response.headers.get( 'set-cookie' ) ].filter( Boolean );
		for ( const line of raw ) {
			const pair = line.split( ';' )[ 0 ];
			const eq = pair.indexOf( '=' );
			if ( eq > 0 ) {
				this.cookies.set(
					pair.slice( 0, eq ).trim(),
					pair.slice( eq + 1 ).trim()
				);
			}
		}
	}

	header() {
		return [ ...this.cookies.entries() ]
			.map( ( [ name, value ] ) => `${ name }=${ value }` )
			.join( '; ' );
	}
}

const jar = new CookieJar();

async function jarFetch( url, init = {} ) {
	const headers = { cookie: jar.header(), ...( init.headers ?? {} ) };
	const response = await fetch( url, {
		...init,
		headers,
		redirect: 'manual',
	} );
	jar.absorb( response );
	return response;
}

/** Logs in via wp-login.php and returns a fresh REST nonce. */
async function login() {
	// Seed the test cookie WordPress checks on the login POST.
	await jarFetch( `${ BASE }/wp-login.php` );
	const body = new URLSearchParams( {
		log: USER,
		pwd: PASS,
		'wp-submit': 'Log In',
		redirect_to: `${ BASE }/wp-admin/`,
		testcookie: '1',
	} );
	await jarFetch( `${ BASE }/wp-login.php`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	} );
	if (
		! [ ...jar.cookies.keys() ].some( ( k ) =>
			k.startsWith( 'wordpress_logged_in' )
		)
	) {
		throw new Error(
			`Login failed for "${ USER }" at ${ BASE } — check WP_USERNAME/WP_PASSWORD/WP_BASE_URL.`
		);
	}
	// Core's built-in rest-nonce AJAX action (used by heartbeat re-auth).
	const nonceResponse = await jarFetch(
		`${ BASE }/wp-admin/admin-ajax.php?action=rest-nonce`
	);
	const nonce = ( await nonceResponse.text() ).trim();
	if ( ! /^[a-f0-9]{10}$/.test( nonce ) ) {
		throw new Error(
			`Could not obtain a REST nonce (got: ${ nonce.slice( 0, 40 ) })`
		);
	}
	return nonce;
}

async function rest( nonce, method, path, body = null, extraHeaders = {} ) {
	// rest_route form: works under every permalink structure (a plain-
	// permalink site serves /wp-json as the homepage).
	const url = `${ BASE }/index.php?rest_route=${ encodeURIComponent(
		path
	) }`;
	const response = await jarFetch( url, {
		method,
		headers: {
			'content-type': 'application/json',
			'x-wp-nonce': nonce,
			...extraHeaders,
		},
		body: body ? JSON.stringify( body ) : undefined,
	} );
	let data = null;
	try {
		data = await response.json();
	} catch {
		// Non-JSON body (HTML error page): leave data null.
	}
	return { status: response.status, data };
}

/**
 * Floor-index percentile over a sorted array (the benchmark convention).
 *
 * @param {number[]} sorted Ascending values.
 * @param {number}   p      Percentile 0–100.
 * @return {number} The percentile value.
 */
function percentile( sorted, p ) {
	const index = Math.min(
		sorted.length - 1,
		Math.floor( ( p / 100 ) * sorted.length )
	);
	return sorted[ index ];
}

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

const isPostRoom = ( room ) =>
	typeof room?.room === 'string' && room.room.startsWith( 'postType/post:' );

async function main() {
	const fixture = JSON.parse( fs.readFileSync( FIXTURE_PATH, 'utf8' ) );
	const allFrames = fixture.frames ?? [];

	// Reduce every frame to its post room (raw exports can carry multi-room
	// requests; sanitized fixtures already have exactly one).
	const frames = [];
	for ( const frame of allFrames ) {
		const postRoom = ( frame.request?.rooms ?? [] ).find( isPostRoom );
		if ( postRoom ) {
			frames.push( { frame, postRoom } );
		}
	}
	if ( ! frames.length ) {
		throw new Error(
			'The fixture has no frames touching a postType/post room.'
		);
	}

	const nonce = await login();

	// Engine fence: replaying an engine's wire vocabulary into a different
	// engine measures rejection paths, not merges.
	if ( fixture.engine ) {
		const settings = await rest( nonce, 'GET', '/wp/v2/settings' );
		const activeEngine = settings.data?.wp_sync_engine ?? null;
		if ( activeEngine && activeEngine !== fixture.engine ) {
			const message =
				`Fixture was captured under engine "${ fixture.engine }" but the site runs ` +
				`"${ activeEngine }". Switch the engine (Settings → Collaboration) or pass --force.`;
			if ( ! FORCE ) {
				throw new Error( message );
			}
			console.warn( `WARNING: ${ message }` );
		}
	} else {
		console.warn(
			'WARNING: the fixture carries no engine metadata (community-harness capture?); ' +
				'skipping the engine check.'
		);
	}

	// Target post: given, or a fresh draft seeded from the captured base
	// state so the engine's genesis matches what the session started from.
	let postId = opts.post ? Number( opts.post ) : null;
	if ( ! postId ) {
		const created = await rest( nonce, 'POST', '/wp/v2/posts', {
			title: fixture.base_title || 'RTC replay target',
			content: fixture.base_content || '',
			status: 'draft',
		} );
		if ( 201 !== created.status ) {
			throw new Error(
				`Could not create the replay target post (HTTP ${ created.status }): ` +
					JSON.stringify( created.data )?.slice( 0, 200 )
			);
		}
		postId = created.data.id;
		console.log(
			`replay target: new draft post ${ postId }` +
				( fixture.base_content
					? ' (seeded from captured base content)'
					: '' )
		);
	}
	const room = `postType/post:${ postId }`;

	if ( CLEAR_LOG ) {
		await rest( nonce, 'DELETE', '/rtc-test/v1/log' );
	}

	const tagHeaders = {
		'x-rtc-test': '1',
		'x-rtc-scenario': SCENARIO,
		...( APPROACH ? { 'x-rtc-approach': APPROACH } : {} ),
	};

	console.log(
		`replaying ${ frames.length } frames (${ allFrames.length } captured) ` +
			`at speed=${ SPEED }${
				SPEED ? 'x' : ' (no pacing)'
			} into ${ room }`
	);

	// Per-client lanes: each client's frames run in order against its own
	// tracked cursor; separate clients interleave on the captured schedule.
	const lanes = new Map(); // client_id -> { chain: Promise, cursor: number }
	const results = [];
	const startedAt = Date.now();

	for ( const { frame, postRoom } of frames ) {
		const clientId = Number( frame.client_id ?? postRoom.client_id ?? 0 );
		if ( ! lanes.has( clientId ) ) {
			lanes.set( clientId, { chain: Promise.resolve(), cursor: 0 } );
		}
		const lane = lanes.get( clientId );
		lane.chain = lane.chain.then( async () => {
			if ( SPEED > 0 ) {
				const dueAt = startedAt + ( frame.elapsed_ms ?? 0 ) / SPEED;
				const wait = dueAt - Date.now();
				if ( wait > 0 ) {
					await sleep( wait );
				}
			}
			const requestBody = {
				rooms: [
					{
						room,
						client_id: clientId,
						// Captured awareness replays verbatim (real
						// user-shaped states); sanitized/missing awareness
						// replays as null — a synthetic state without a user
						// object crashes the editor's collaborator-avatar UI
						// in any window open on the target post.
						awareness:
							postRoom.awareness &&
							Object.keys( postRoom.awareness ).length
								? postRoom.awareness
								: null,
						after: lane.cursor,
						updates: postRoom.updates ?? [],
					},
				],
			};
			const sentAt = Date.now();
			const { status, data } = await rest(
				nonce,
				'POST',
				'/wp-sync/v1/updates',
				requestBody,
				tagHeaders
			);
			const ms = Date.now() - sentAt;

			const roomOut = data?.rooms?.[ 0 ] ?? {};
			if ( Number.isInteger( roomOut.end_cursor ) ) {
				lane.cursor = roomOut.end_cursor;
			}
			const dispositions = {};
			for ( const entry of roomOut.dispositions ?? [] ) {
				const key = entry?.disposition ?? entry?.status ?? 'unknown';
				const label =
					'voided' === key && entry?.reason
						? `voided:${ entry.reason }`
						: key;
				dispositions[ label ] = ( dispositions[ label ] ?? 0 ) + 1;
			}
			results.push( {
				n: frame.n,
				client_id: clientId,
				elapsed_ms: frame.elapsed_ms ?? 0,
				updates_in: ( postRoom.updates ?? [] ).length,
				status,
				ms,
				dispositions,
				error: 200 !== status ? data?.code ?? null : null,
			} );
		} );
	}
	await Promise.all( [ ...lanes.values() ].map( ( lane ) => lane.chain ) );
	const wallMs = Date.now() - startedAt;

	// ── Summary ──
	results.sort( ( a, b ) => a.n - b.n );
	const latencies = results.map( ( r ) => r.ms ).sort( ( a, b ) => a - b );
	const statuses = {};
	const dispositions = {};
	let updatesIn = 0;
	for ( const r of results ) {
		statuses[ r.status ] = ( statuses[ r.status ] ?? 0 ) + 1;
		updatesIn += r.updates_in;
		for ( const [ key, count ] of Object.entries( r.dispositions ) ) {
			dispositions[ key ] = ( dispositions[ key ] ?? 0 ) + count;
		}
	}
	const mean =
		latencies.reduce( ( sum, value ) => sum + value, 0 ) / latencies.length;

	const summary = {
		fixture: {
			path: FIXTURE_PATH,
			session_id: fixture.session_id ?? '',
			engine: fixture.engine ?? null,
			transport: fixture.transport ?? null,
			frames: allFrames.length,
		},
		replay: {
			baseUrl: BASE,
			post: postId,
			room,
			speed: SPEED,
			scenario: SCENARIO,
			clients: lanes.size,
			framesSent: results.length,
			updatesSent: updatesIn,
			wallMs,
		},
		statuses,
		dispositions,
		clientMs: {
			min: latencies[ 0 ],
			p50: percentile( latencies, 50 ),
			p90: percentile( latencies, 90 ),
			max: latencies[ latencies.length - 1 ],
			mean: Math.round( mean * 10 ) / 10,
		},
		frames: results,
	};

	console.log( '' );
	console.log(
		`── replay done: ${ results.length } frames, ${ updatesIn } updates, ` +
			`${ lanes.size } clients, ${ ( wallMs / 1000 ).toFixed( 1 ) }s ──`
	);
	console.log(
		`  status codes: ${ Object.entries( statuses )
			.map( ( [ code, count ] ) => `${ code }×${ count }` )
			.join( ', ' ) }`
	);
	if ( Object.keys( dispositions ).length ) {
		console.log(
			`  dispositions: ${ Object.entries( dispositions )
				.map( ( [ key, count ] ) => `${ key }=${ count }` )
				.join( ', ' ) }`
		);
	}
	console.log(
		`  client ms: min ${ summary.clientMs.min }  p50 ${ summary.clientMs.p50 }  ` +
			`p90 ${ summary.clientMs.p90 }  max ${ summary.clientMs.max }  mean ${ summary.clientMs.mean }`
	);

	// Server-side metrics, when the site's diagnostics module is active.
	const report = await rest( nonce, 'GET', '/rtc-test/v1/report' );
	if ( 200 === report.status && report.data?.text ) {
		console.log( '' );
		console.log( '── server-side request log (rtc-test/v1/report) ──' );
		console.log( report.data.text );
		summary.serverReport = report.data.text;
	} else {
		console.log(
			'  (no server-side request log — the site is not local/development ' +
				'or lacks GUTENBERG_SYNC_ENGINES_DIAGNOSTICS)'
		);
		summary.serverReport = null;
	}

	if ( JSON_PATH ) {
		fs.writeFileSync( JSON_PATH, JSON.stringify( summary, null, 2 ) );
		console.log( `json written: ${ JSON_PATH }` );
	}
}

main().catch( ( error ) => {
	console.error( String( error?.message ?? error ) );
	process.exit( 1 );
} );
