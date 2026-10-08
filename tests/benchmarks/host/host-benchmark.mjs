/**
 * The host cost report: what real-time collaboration adds to a server,
 * measured as the difference against the workflow it replaces — the
 * same people producing the same document by editing in series with
 * the plugin deactivated. One engine per run (comparing engines is the
 * engines suite's job); the RESULTS section prints two markdown tables
 * (editing, idle) with columns baseline/sync/delta/delta-%, then the
 * summary stats (room storage, derived capacity; whole-job totals are
 * in the json= report as engine.job).
 *
 *   npm run bench                            # this report, defaults
 *   npm run bench -- --engine=de-rtc --windows=3
 *   npm run bench -- --metrics=requests,cpu --json=host.json
 *
 * Phases, all real browser windows against a live site:
 *
 *   1. BASELINE — the plugin is deactivated (every active copy, via the
 *      REST plugins endpoint) and `windows` people edit the same draft
 *      IN SERIES: person i completes their `edit-seconds` script, saves,
 *      and leaves, then the next person takes a turn; after the last
 *      turn the tab sits idle for `idle-seconds`. This is the workflow
 *      the plugin replaces — the post lock forces turn-taking — and
 *      each person types the same script their window types in phase
 *      2, so both phases produce the same final document.
 *   2. PER ENGINE — the plugin is reactivated, real-time collaboration
 *      is enabled, and `windows` browser windows co-edit an identical
 *      draft simultaneously (each typing into its own paragraph, one
 *      save at the end) on that engine and the chosen transport.
 *
 * Setup is excluded from phase rates. Every request is counted client-side (requests,
 * bytes). Server-side, EVERY request from the windows is tagged with
 * the community harness's headers, and the whole-request measurement
 * mu-plugin (tests/benchmarks/host/mu-bench-log.php — this repo's
 * wp-env configs map it into mu-plugins) records each tagged PHP
 * request from load to shutdown: wall time, CPU, DB queries, peak
 * memory, concurrency. Because the mu-plugin works with the plugin
 * DEACTIVATED, the baseline phase gets real server-side numbers too,
 * so CPU, worker share, and memory are true baseline/sync/delta
 * comparisons. Opt-in timelines divide open-stream costs across phases
 * with explicit sample and clock bounds. Missing timelines and WebSocket
 * process costs remain unavailable. Raw rows and samples remain in JSON.
 *
 * Table rows: HTTP requests and socket frames per minute, payload bytes, PHP CPU per
 * minute, the share of one PHP worker held, options-cache
 * invalidations, database queries, database fsyncs, editor long
 * tasks, and (editing)
 * peak PHP memory per request. Caveats and how to read each metric
 * live in tests/benchmarks/README.md, which the report points at.
 *
 * Arguments (bare key=value, like every benchmark here):
 *
 *   engine=     the ONE engine to measure (intent-log | yjs-server |
 *               de-rtc | current; default: the site's current engine —
 *               comparing engines is what --suite=engines is for)
 *   transport=  http-polling | sse | websocket | current
 *   cache=      none | redis | current: the persistent object cache the
 *               site runs for the run (redis = the Redis Object Cache
 *               drop-in on the env's Redis; wp-env sites only; restored)
 *   wake=       auto | redis | cache | table: what an SSE stream sleeps
 *               on (auto = whatever the site has; cache needs
 *               cache=redis, table needs cache=none)
 *   peers=      total peers (default 2); windows= remains an alias
 *   p95-ms=     optional maximum p95 delivery delay in milliseconds
 *   max-lag-ms= maximum typing schedule delay (default 1000 ms)
 *   windows=    people per phase: collaborator windows, and the same
 *               number of one-after-the-other baseline turns (default 2)
 *   edit-seconds=      script duration per person (default 120, min 30; slow runs take longer)
 *   idle-seconds=      idle seconds per phase (default 120; 0 skips)
 *   post-size=  empty | medium | large: what the post holds before anyone
 *               types (one paragraph per person; ~20 blocks; ~200
 *               blocks with lists and groups; default empty)
 *   pattern=    own-paragraph | new-blocks: append every word to your
 *               own paragraph, or start a new paragraph per burst of
 *               words (default own-paragraph)
 *   polling-interval=  override the HTTP short-polling interval for the
 *                      run, in seconds 0-25 (0 = the plugin's defaults;
 *                      default: leave the site's setting alone; restored
 *                      afterwards)
 *   metrics=    comma list to report: requests,traffic,cpu,workers,memory,cache,queries,fsyncs,editor
 *               (default all)
 *   json=       write full results as JSON to this path
 *   record=     append this run's result line to this results file
 *               (record.mjs documents the format; the sweep runner,
 *               sweep.mjs, uses it to build a data set)
 *   baseline-cache=  a directory of saved plugin-off phases: a run whose
 *               plugin-off phase would measure exactly what a saved one
 *               did (same people, post, script, cache, code, server)
 *               reuses it instead of measuring again
 *   repeat=     repeat number recorded with the result (default 1)
 *   plan=, cell=  plan name and setup id recorded with the result
 *               (set by sweep.mjs, which resumes by them)
 *   websocket-metrics= comma-separated /bench-metrics URLs for whole-process costs
  headed=1    visible browser (debugging)
 *   --help      print the argument list and exit
 *
 * Requires a running environment with the plugin active at start (the
 * tests env: npm run env:tests start; this repo's wp-env configs mount
 * the mu-plugin), Playwright's chromium,
 * and — for the server-side columns — the diagnostics request log
 * (local/development sites, or GUTENBERG_SYNC_ENGINES_DIAGNOSTICS).
 * Environment: WP_BASE_URL / WP_USERNAME / WP_PASSWORD as usual.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';

import {
	BASE,
	COLLABORATION_EXPERIMENT,
	attachCounters,
	canvasOf,
	configureHostCache,
	configureSettings,
	dismissWelcomeGuide,
	ensureCollaborationEnabled,
	login,
	makeRestClient,
	observeSseWait,
	observeTransport,
	parseCliOptions,
	restoreHostCache,
	restoreSettings,
	selectHostBenchmarkSite,
	waitForSyncTraffic,
} from '../transport/lib.mjs';

import {
	attachAllTrafficCounters,
	editingScript,
	matchesDocument,
	serverCoverageLimits,
} from './measurement.mjs';
import {
	clockRange,
	validateTimelines,
	measureTimelines,
} from './timeline.mjs';
import { checkMeasurementSupport } from './preflight.mjs';
import {
	sampleSocketProcesses,
	socketProcessCosts,
} from './websocket-costs.mjs';

import {
	deliveryOptions,
	deliveryMeasurements,
	contentAudit,
	assessRun,
} from './delivery.mjs';
import { allowPeers, installMeasurements, readEditors } from './browser.mjs';
import {
	PATTERNS,
	POST_SIZES,
	anchorText,
	expectedTexts,
	postFixture,
} from './content.mjs';
import {
	RECORD_FORMAT,
	appendRecord,
	baselineKey,
	resultsOf,
	runEnvironment,
	shortHash,
} from './record.mjs';

const opts = parseCliOptions();

const HELP = `node tests/benchmarks/host/host-benchmark.mjs [key=value …]
(or: npm run bench -- [--key=value …])

  engine=     the ONE engine to measure (intent-log | yjs-server |
              de-rtc | current; default: the site's current engine —
              comparing engines is what --suite=engines is for)
  transport=  http-polling | sse | websocket
              (default: the site's current transport)
  cache=      none | redis | current: the persistent object cache for the
              run (redis = the Redis Object Cache drop-in on the env's
              Redis; this checkout's wp-env sites only; restored after)
  wake=       auto | redis | cache | table: what an SSE stream sleeps on
              (cache needs cache=redis, table needs cache=none)
  peers=      total peers (default 2); windows= remains an alias
  p95-ms=     optional maximum p95 delivery delay in milliseconds
  max-lag-ms= maximum typing schedule delay (default 1000 ms)
  windows=    people per phase: collaborator windows, and the same
              number of one-after-the-other baseline turns (default 2)
  edit-seconds=      script duration per person (default 120, min 30; slow runs take longer)
  idle-seconds=      idle seconds per phase (default 120; 0 skips)
  post-size=  empty | medium | large: the post before anyone types
              (default empty)
  pattern=    own-paragraph | new-blocks (default own-paragraph)
  polling-interval=  override the HTTP short-polling interval for the
                     run, in seconds 0-25 (0 = the plugin's defaults;
                     default: leave the site's setting alone; restored
                     afterwards)
  metrics=    comma list of table rows to print:
              requests,traffic,cpu,workers,memory,cache,queries,fsyncs,editor (default all)
  json=       write full results as JSON to this path
  record=     append this run's result line to this results file
  baseline-cache=  directory of saved plugin-off phases to reuse
  repeat=     repeat number recorded with the result (default 1)
  plan=, cell=  plan name and setup id recorded with the result (set by
              the sweep runner)
  websocket-metrics= comma-separated /bench-metrics URLs for whole-process costs
  headed=1    visible browser (debugging)

Environment: WP_BASE_URL (default: this checkout’s running wp-env test site),
WP_USERNAME/WP_PASSWORD (default admin/password).
`;

if ( opts.help || opts.h ) {
	process.stdout.write( HELP );
	process.exit( 0 );
}

// A mistyped argument silently measuring the wrong thing costs a whole
// multi-minute run, so unknown keys refuse up front.
const KNOWN_ARGS = [
	'engine',
	'transport',
	'cache',
	'wake',
	'windows',
	'peers',
	'p95-ms',
	'max-lag-ms',
	'edit-seconds',
	'idle-seconds',
	'polling-interval',
	'post-size',
	'pattern',
	'metrics',
	'json',
	'record',
	'baseline-cache',
	'repeat',
	'plan',
	'cell',
	'headed',
	'websocket-metrics',
];
const unknownArgs = Object.keys( opts ).filter(
	( key ) => ! KNOWN_ARGS.includes( key )
);
if ( unknownArgs.length ) {
	console.error(
		`unknown argument(s): ${ unknownArgs.join(
			', '
		) } — known: ${ KNOWN_ARGS.join( ', ' ) }` +
			( unknownArgs.includes( 'engines' )
				? '\n(the host report measures ONE engine per run — engine=<slug>; comparing engines is what --suite=engines is for)'
				: '' )
	);
	process.exit( 1 );
}
const ENGINE = String( opts.engine ?? 'current' );
if ( ENGINE.includes( ',' ) ) {
	console.error(
		'engine= takes a single engine — comparing engines is what ' +
			'suite=engines is for'
	);
	process.exit( 1 );
}
const SOCKET_METRICS = opts[ 'websocket-metrics' ]
	? String( opts[ 'websocket-metrics' ] ).split( ',' )
	: [];
const TRANSPORT = String( opts.transport ?? 'current' );
const CACHE = String( opts.cache ?? 'current' );
const WAKE = String( opts.wake ?? 'auto' );
let limits;
try {
	limits = deliveryOptions( opts );
} catch ( error ) {
	console.error( error.message );
	process.exit( 1 );
}
const WINDOWS = limits.peers;
const EDIT_SECONDS = Number( opts[ 'edit-seconds' ] ?? 120 );
const IDLE_SECONDS = Number( opts[ 'idle-seconds' ] ?? 120 );
const POLL_OVERRIDE =
	undefined === opts[ 'polling-interval' ]
		? null
		: Math.max( 0, Math.min( 25, Number( opts[ 'polling-interval' ] ) ) );
const POST_SIZE = String( opts[ 'post-size' ] ?? 'empty' );
const PATTERN = String( opts.pattern ?? 'own-paragraph' );
const JSON_PATH = opts.json ? String( opts.json ) : null;
const RECORD_PATH = opts.record ? String( opts.record ) : null;
const BASELINE_CACHE = opts[ 'baseline-cache' ]
	? String( opts[ 'baseline-cache' ] )
	: null;
const REPEAT = Number( opts.repeat ?? 1 );
const PLAN = opts.plan ? String( opts.plan ) : null;
const CELL = opts.cell ? String( opts.cell ) : null;
const RUN_STARTED = Date.now();
const HEADED = Boolean( opts.headed );
const ALL_METRICS = [
	'requests',
	'traffic',
	'cpu',
	'workers',
	'memory',
	'cache',
	'queries',
	'fsyncs',
	'editor',
];
const METRICS = opts.metrics
	? String( opts.metrics )
			.split( ',' )
			.map( ( metric ) => metric.trim() )
			.filter( Boolean )
	: ALL_METRICS;

const POLLING_INTERVAL_SETTING = 'gutenberg_sync_engines_polling_interval';

/**
 * Tags EVERY same-site request from a MEASURED page with the community
 * harness's measurement headers, labeled with the current phase's
 * scenario and approach. The whole-request mu-plugin measures every
 * tagged PHP request server-side — page loads and admin-ajax included,
 * with the plugin active or not. Only pages in the `measured` set are
 * tagged: the admin chore page's own heartbeat must not pollute the
 * per-person numbers.
 *
 * @param {import('@playwright/test').BrowserContext} context  Browser context.
 * @param {{ scenario: string, approach: string }}    tag      Mutable labels.
 * @param {Set<Object>}                               measured Pages to tag.
 * @param {Object}                                    tracking Shared request records for all peer contexts.
 */
async function installGlobalTagging(
	context,
	tag,
	measured,
	tracking = { issued: new Set(), expected: new Set(), requests: new Map() }
) {
	const origin = new URL( BASE ).origin;
	const { issued, expected, requests } = tracking;
	context.on( 'response', ( response ) => {
		const id = response.headers()[ 'x-rtc-request-id' ];
		if ( issued.has( id ) ) {
			expected.add( id );
		}
	} );
	await context.route(
		( url ) => url.origin === origin,
		async ( route ) => {
			let page = null;
			try {
				page = route.request().frame().page();
			} catch {
				// Service-worker or detached-frame request: not measured.
			}
			if ( ! page || ! measured.has( page ) ) {
				return route.continue();
			}
			const id = randomUUID();
			issued.add( id );
			const url = new URL( route.request().url() );
			const requestPath =
				url.searchParams.get( 'rest_route' ) || url.pathname;
			requests.set( id, { path: requestPath, scenario: tag.scenario } );
			// Streams opened during setup can cross a measured period. Other
			// setup requests use the MU response header: load-scripts.php and
			// load-styles.php do not boot plugins and finish before measurement.
			const phpRoute =
				url.pathname.endsWith( '.php' ) ||
				url.pathname.includes( '/wp-json/' ) ||
				url.searchParams.has( 'rest_route' );
			if (
				requestPath.includes( '/wp-sync/v1/sse' ) ||
				( tag.scenario.startsWith( 'host-' ) && phpRoute )
			) {
				expected.add( id );
			}
			await route.continue( {
				headers: {
					...route.request().headers(),
					'x-rtc-test': '1',
					'x-rtc-timeline': '1',
					'x-rtc-request-id': id,
					'x-rtc-scenario': tag.scenario,
					'x-rtc-approach': tag.approach,
					...( null !== POLL_OVERRIDE
						? { 'x-rtc-poll-delay': String( POLL_OVERRIDE ) }
						: {} ),
				},
			} );
		}
	);
	return { issued, expected, requests };
}

/**
 * Run a fixed script. A slow browser takes longer; it does not do less work.
 *
 * Under the own-paragraph pattern every word goes at the end of the
 * person's anchor paragraph. Under new-blocks the first word of each
 * burst goes into a new paragraph started (Enter) after the last
 * paragraph this person wrote, and the rest of the burst follows it.
 * Under own-paragraph the paragraph is found by its anchor word, which
 * never changes; under new-blocks, by the last word typed into it
 * (every word is unique: `w<window>t<n>x`).
 *
 * @param {Object} win   Window record.
 * @param {number} start Phase start time.
 * @return {Promise<number>} Completed token count.
 */
async function editingDriver( win, start ) {
	const script = editingScript( win.index, EDIT_SECONDS * 1000 );
	let lastText = anchorText( win.index );
	let lastBurst = null;
	for ( const token of script ) {
		await win.page.waitForTimeout(
			Math.max( 0, start + token.at - Date.now() )
		);
		const paragraph = win.canvas
			.locator( '[data-type="core/paragraph"]', {
				hasText: lastText,
			} )
			.first();
		// A busy editor answers late; a person would wait, so the run
		// does too (the editor long-task metrics record how long).
		await paragraph.click( { timeout: 60000 } );
		// End is only the end of a visual line on some platforms. Select
		// the paragraph's actual text end so wrapping cannot reorder tokens.
		await paragraph.evaluate(
			( block, scheduled ) => {
				const element = block.matches(
					'.block-editor-rich-text__editable'
				)
					? block
					: block.querySelector(
							'.block-editor-rich-text__editable'
					  );
				if ( ! element?.isContentEditable ) {
					throw new Error( 'The writer paragraph is not editable.' );
				}
				const range = element.ownerDocument.createRange();
				range.selectNodeContents( element );
				range.collapse( false );
				const selection =
					element.ownerDocument.defaultView.getSelection();
				selection.removeAllRanges();
				selection.addRange( range );
				// Timestamp actual input in the browser, excluding automation travel time.
				element.ownerDocument.addEventListener(
					'beforeinput',
					() => {
						const at = Date.now();
						element.ownerDocument.defaultView.top.__hostBench.sent[
							scheduled.text.trim()
						] = {
							at,
							lagMs: Math.max( 0, at - scheduled.due ),
						};
					},
					{ once: true, capture: true }
				);
			},
			{ text: token.text, due: start + token.at }
		);
		const startsBlock =
			'new-blocks' === PATTERN && token.burst !== lastBurst;
		if ( startsBlock ) {
			await win.page.keyboard.press( 'Enter' );
		}
		await win.page.keyboard.insertText(
			startsBlock ? token.text.trimStart() : token.text
		);
		lastBurst = token.burst;
		if ( 'new-blocks' === PATTERN ) {
			lastText = token.text.trim();
		}
	}
	await win.page.waitForTimeout(
		Math.max( 0, start + EDIT_SECONDS * 1000 - Date.now() )
	);
	return script.length;
}

/**
 * Expected fixture after this many serial authors, or all concurrent authors.
 *
 * @param {number} authors Completed authors.
 * @return {Array<string>} Expected paragraphs.
 */
function expectedDocument( authors ) {
	return expectedTexts( {
		windows: WINDOWS,
		size: POST_SIZE,
		pattern: PATTERN,
		editSeconds: EDIT_SECONDS,
		authors,
	} );
}

/**
 * Require all editors to hold the complete intended document before saving.
 *
 * @param {Array<Object>} wins     Editor windows.
 * @param {Array<string>} expected Expected paragraphs.
 */
async function verifyEditors( wins, expected ) {
	const deadline = Date.now() + 90000;
	while ( true ) {
		const contents = await Promise.all(
			wins.map( ( win ) =>
				win.page.evaluate( () =>
					window.wp.data
						.select( 'core/editor' )
						.getEditedPostContent()
				)
			)
		);
		if (
			contents.every( ( content ) =>
				matchesDocument( content, expected )
			)
		) {
			return;
		}
		if ( Date.now() >= deadline ) {
			throw new Error(
				'Editors did not reach the expected document; no cost comparison will be reported.'
			);
		}
		await wins[ 0 ].page.waitForTimeout( 250 );
	}
}

/**
 * Says where a document first differs from the expected text, for the
 * error a failed content check raises.
 *
 * @param {string}        content  Serialized post content.
 * @param {Array<string>} expected Expected texts.
 * @return {string} One-line description.
 */
function describeMismatch( content, expected ) {
	if ( typeof content !== 'string' ) {
		return 'no content';
	}
	const texts = [];
	const leftover = content
		.replace( /<!--[\s\S]*?-->/g, '' )
		.replace(
			/<(p|h[1-6]|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g,
			( _, tag, text ) => {
				texts.push(
					text
						.replace( /&nbsp;|&#160;/g, ' ' )
						.replace( /\s+/g, ' ' )
						.trim()
				);
				return '';
			}
		)
		// What is left once the text items are gone: markup, and any
		// text that sits outside them.
		.replace( /<[^>]+>/g, '' )
		.trim();
	const index = expected.findIndex( ( text, i ) => texts[ i ] !== text );
	if ( -1 === index && texts.length === expected.length ) {
		const at = content.indexOf( leftover.slice( 0, 40 ) );
		return `the texts match, but text sits outside any paragraph, heading, or list item: ${ JSON.stringify(
			leftover.slice( 0, 200 )
		) } — in context: ${ JSON.stringify(
			content.slice( Math.max( 0, at - 300 ), at + 200 )
		) }`;
	}
	if ( -1 === index ) {
		return `${
			texts.length - expected.length
		} extra text item(s) at the end`;
	}
	const cut = ( text ) =>
		undefined === text ? '(missing)' : JSON.stringify( text.slice( -80 ) );
	return `${ texts.length } text items (expected ${
		expected.length
	}); item ${ index } is ${ cut( texts[ index ] ) }, expected ${ cut(
		expected[ index ]
	) }`;
}

/**
 * Creates a draft post holding the post-size fixture (one anchor
 * paragraph per window, plus filler for medium and large), returning
 * its id. Created over REST so no editor (and no sync session) is
 * involved.
 *
 * @param {Object} rest  REST client.
 * @param {string} label Title suffix distinguishing the phases.
 * @return {Promise<number>} Post id.
 */
async function createDraft( rest, label ) {
	const { content } = postFixture( WINDOWS, POST_SIZE );
	const { status, data } = await rest.post( '/wp/v2/posts', {
		body: {
			title: `host benchmark ${ label }`,
			content,
			status: 'draft',
		},
	} );
	if ( 201 !== status || ! data?.id ) {
		throw new Error( `creating the ${ label } draft failed (${ status })` );
	}
	return data.id;
}

/**
 * Lists this plugin's entries on the REST plugins endpoint.
 *
 * @param {Object} rest REST client.
 * @return {Promise<Array<{plugin: string, status: string}>>} Entries.
 */
async function listPluginCopies( rest ) {
	const { status, data } = await rest.get( '/wp/v2/plugins' );
	if ( 200 !== status || ! Array.isArray( data ) ) {
		throw new Error(
			`GET /wp/v2/plugins returned ${ status } — cannot toggle the plugin for the baseline phase`
		);
	}
	return data
		.filter( ( row ) =>
			String( row.plugin ?? '' ).endsWith( '/gutenberg-sync-engines' )
		)
		.map( ( row ) => ( { plugin: row.plugin, status: row.status } ) );
}

/**
 * Sets one plugin's activation status over REST.
 *
 * @param {Object} rest       REST client.
 * @param {string} plugin     Plugin identifier (dir/file, no .php).
 * @param {string} wantStatus 'active' or 'inactive'.
 */
async function setPluginStatus( rest, plugin, wantStatus ) {
	const { status } = await rest.post( `/wp/v2/plugins/${ plugin }`, {
		body: { status: wantStatus },
	} );
	if ( 200 !== status ) {
		throw new Error(
			`setting ${ plugin } to ${ wantStatus } failed (${ status })`
		);
	}
}

/**
 * Opens one editor window on a post and waits for the editor to be
 * ready. The page joins the measured set before navigating, so its
 * page load is tagged (under the setup scenario) like everything else
 * it sends.
 *
 * @param {import('@playwright/test').BrowserContext} context  Browser context.
 * @param {Set<Object>}                               measured Measured pages.
 * @param {number}                                    postId   Post to open.
 * @param {number}                                    index    Window index.
 * @return {Promise<Object>} Window record.
 */
async function openEditorWindow( context, measured, postId, index ) {
	const page = await context.newPage();
	measured.add( page );
	page.on( 'close', () => measured.delete( page ) );
	const errors = [];
	let pageErrors = 0;
	let requestErrors = 0;
	page.on( 'pageerror', ( error ) => {
		pageErrors++;
		if ( errors.length < 20 ) {
			errors.push( error.message );
		}
	} );
	page.on( 'response', ( response ) => {
		if (
			response.status() >= 400 &&
			decodeURIComponent( response.url() ).includes( '/wp-sync/v1/' )
		) {
			requestErrors++;
			if ( errors.length < 20 ) {
				errors.push(
					`Sync request failed: HTTP ${ response.status() }`
				);
			}
		}
	} );
	const sync = attachCounters( page );
	const all = attachAllTrafficCounters( page, () => sync.snapshot() );
	await sync.ready;
	await page.goto(
		`${ BASE }/wp-admin/post.php?post=${ postId }&action=edit`
	);
	await dismissWelcomeGuide( page );
	await page.waitForFunction( () =>
		window.wp?.data?.select( 'core/editor' )?.getCurrentPostId()
	);
	// Filler markup that does not match a block's own save output loads
	// as an invalid block, which engines treat differently from real
	// content — refuse to measure that.
	const invalid = await page.evaluate( () => {
		const names = [];
		const walk = ( blocks ) =>
			blocks.forEach( ( block ) => {
				if ( false === block.isValid ) {
					names.push( block.name );
				}
				walk( block.innerBlocks || [] );
			} );
		walk( window.wp.data.select( 'core/block-editor' ).getBlocks() );
		return names;
	} );
	if ( invalid.length ) {
		throw new Error(
			`the post-size fixture loaded invalid blocks (${ invalid.join(
				', '
			) }) — fix its markup in content.mjs`
		);
	}
	// Main-thread tasks over 50 ms: how long the editor stops answering
	// the person using it. The canvas iframe shares this event loop.
	await page.evaluate( () => {
		window.__hostLongTasks = [];
		new window.PerformanceObserver( ( list ) =>
			list
				.getEntries()
				.forEach( ( entry ) =>
					window.__hostLongTasks.push( entry.duration )
				)
		).observe( { type: 'longtask' } );
	} );
	const win = {
		page,
		postId,
		index,
		all,
		sync,
		canvas: null,
		errors: () => ( { pageErrors, requestErrors, messages: errors } ),
	};
	win.canvas = await canvasOf( page );
	await installMeasurements( page );
	return win;
}

/**
 * Difference between two database fsync counter samples. (The data-file
 * read and write counters the probe also returns are left out: commits
 * reach disk through the redo log, and data pages flush lazily in large
 * background batches, so those counters read 0 over any span this
 * benchmark measures.)
 *
 * @param {Object|null} before Earlier sample.
 * @param {Object|null} after  Later sample.
 * @return {Object|null} Deltas, or null when either sample is missing.
 */
function diffDbIo( before, after ) {
	if ( ! before || ! after ) {
		return null;
	}
	return {
		fsyncs: after.fsyncs - before.fsyncs,
	};
}

/**
 * Per-person-per-minute database fsync rate for one span.
 *
 * @param {Object|null} delta   diffDbIo result.
 * @param {number}      ms      Span wall time.
 * @param {number}      persons Active people sharing the span.
 * @return {Object|null} Rates, or null without data.
 */
function dbIoRates( delta, ms, persons ) {
	if ( ! delta || ms <= 0 ) {
		return null;
	}
	const rate = ( value ) => ( value / ( ms * persons ) ) * 60000;
	return {
		fsyncsPerMinute: rate( delta.fsyncs ),
	};
}

/**
 * Saves the post through the editor's own save action (the button's
 * path), so the save cost lands inside the measured span the way a
 * real person's save does.
 *
 * @param {import('@playwright/test').Page} page Editor page.
 * @return {Promise<boolean>} Whether the save succeeded.
 */
async function saveViaEditor( page ) {
	return page
		.evaluate( async () => {
			await window.wp.data.dispatch( 'core/editor' ).savePost();
			return ! window.wp.data
				.select( 'core/editor' )
				.didPostSaveRequestFail();
		} )
		.catch( () => false );
}

/**
 * Refuses a span the machine slept through. The wall clock keeps
 * counting during sleep but the process clock (process.hrtime) does
 * not, so a gap between them means the span's per-minute rates would
 * divide its work by time in which nothing ran — a laptop that sleeps
 * on battery mid-sweep did exactly this.
 *
 * @param {number} wallStart Date.now() at the span start.
 * @param {bigint} monoStart process.hrtime.bigint() at the span start.
 */
function assertAwake( wallStart, monoStart ) {
	const wallMs = Date.now() - wallStart;
	const monoMs = Number( process.hrtime.bigint() - monoStart ) / 1e6;
	if ( wallMs - monoMs > 5000 ) {
		throw new Error(
			`the machine slept for about ${ Math.round(
				( wallMs - monoMs ) / 1000
			) } s during a measured span, so its per-minute rates would be wrong; keep it awake (plugged in, lid open; the sweep runs under caffeinate) and rerun`
		);
	}
}

/**
 * Runs one measured span set over a set of windows: an editing span
 * (drivers, then window 0 saves — the save is part of the editing
 * work), and optionally an idle span. Both phases run through this,
 * so the workload shape is identical; only who is present differs.
 *
 * @param {Object[]}      wins        Window records.
 * @param {Object}        tag         Mutable { scenario, approach } labels.
 * @param {Object}        rest        Administrative REST client.
 * @param {Array<string>} expected    Expected complete document.
 * @param {Function}      sampleClock Server clock probe.
 * @param {boolean}       withIdle    Run the idle span after editing.
 * @param {Function|null} sampleDbIo  Database I/O counter sampler.
 * @return {Promise<Object>} Per-window counter deltas and durations.
 */
async function measurePhase(
	wins,
	tag,
	rest,
	expected,
	sampleClock,
	withIdle = true,
	sampleDbIo = null
) {
	// Let the just-loaded pages settle so page-load assets and session
	// setup stay out of the rates.
	await wins[ 0 ].page.waitForTimeout( 3000 );

	const advisoryBefore = (
		await readEditors( wins.map( ( win ) => win.page ) )
	).map( ( editor ) => editor.advisory );

	// Long tasks per span: { max, total } in ms for each window.
	const takeLongTasks = () =>
		Promise.all(
			wins.map( ( win ) =>
				win.page
					.evaluate( () => window.__hostLongTasks.splice( 0 ) )
					.then( ( tasks ) => ( {
						max: Math.max( 0, ...tasks ),
						total: tasks.reduce( ( a, b ) => a + b, 0 ),
					} ) )
			)
		);
	await takeLongTasks();
	const socketStart = await sampleSocketProcesses( SOCKET_METRICS );
	const clockStart = await sampleClock();
	const ioStart = sampleDbIo ? await sampleDbIo() : null;
	tag.scenario = 'host-editing';
	const editStart = Date.now();
	const editStartMono = process.hrtime.bigint();
	const startAll = wins.map( ( win ) => win.all.snapshot() );
	const startSync = wins.map( ( win ) => win.sync.snapshot() );
	const tokensTyped = await Promise.all(
		wins.map( ( win ) => editingDriver( win, editStart ) )
	);
	await verifyEditors( wins, expected );
	if ( ! ( await saveViaEditor( wins[ 0 ].page ) ) ) {
		throw new Error(
			'The editing phase failed to save; no cost comparison will be reported.'
		);
	}
	const editMs = Date.now() - editStart;
	const editAll = wins.map( ( win ) => win.all.snapshot() );
	const editSync = wins.map( ( win ) => win.sync.snapshot() );
	const ioEdit = sampleDbIo ? await sampleDbIo() : null;
	const longEdit = await takeLongTasks();
	assertAwake( editStart, editStartMono );

	const socketEdit = await sampleSocketProcesses( SOCKET_METRICS );
	tag.scenario = 'host-idle';
	const idleStart = Date.now();
	const idleStartMono = process.hrtime.bigint();
	if ( withIdle && IDLE_SECONDS > 0 ) {
		await wins[ 0 ].page.waitForTimeout( IDLE_SECONDS * 1000 );
	}
	const idleMs = Date.now() - idleStart;
	const idleAll = wins.map( ( win ) => win.all.snapshot() );
	const idleSync = wins.map( ( win ) => win.sync.snapshot() );
	const ioIdle = sampleDbIo ? await sampleDbIo() : null;
	const longIdle = await takeLongTasks();
	assertAwake( idleStart, idleStartMono );
	tag.scenario = 'setup';
	const clockEnd = await sampleClock();
	const socketIdle = await sampleSocketProcesses( SOCKET_METRICS );

	// Verify outside the measurement windows: this administrative REST
	// request must not inflate elapsed editing time or database I/O.
	await verifyEditors( wins, expected );
	const saved = await rest.get(
		`/wp/v2/posts/${ wins[ 0 ].postId }?context=edit`
	);
	if (
		saved.status !== 200 ||
		! matchesDocument( saved.data?.content?.raw, expected )
	) {
		const editor = await wins[ 0 ].page.evaluate( () =>
			window.wp.data.select( 'core/editor' ).getEditedPostContent()
		);
		throw new Error(
			'Saved content does not match the intended document; no cost comparison will be reported.\n' +
				describeMismatch( saved.data?.content?.raw, expected ) +
				`\nthe editor holds: ${ describeMismatch( editor, expected ) }`
		);
	}

	const span = ( before, after ) => {
		const delta = {};
		for ( const key of Object.keys( before ) ) {
			delta[ key ] = after[ key ] - before[ key ];
		}
		return delta;
	};
	return {
		editMs,
		idleMs,
		clockProbes: [ clockStart, clockEnd ],
		socketProcesses: {
			editing: socketProcessCosts( socketStart, socketEdit ),
			idle:
				withIdle && IDLE_SECONDS > 0
					? socketProcessCosts( socketEdit, socketIdle )
					: [],
			raw: {
				start: socketStart,
				editingEnd: socketEdit,
				idleEnd: socketIdle,
			},
		},
		windows: {
			editing: { startMs: editStart, endMs: editStart + editMs },
			idle: { startMs: idleStart, endMs: idleStart + idleMs },
		},
		saveOk: true,
		contentVerified: true,
		session:
			tag.approach === 'baseline'
				? null
				: await sessionReport( wins, advisoryBefore ),
		dbIo: {
			editing: diffDbIo( ioStart, ioEdit ),
			idle: withIdle ? diffDbIo( ioEdit, ioIdle ) : null,
		},
		perWindow: wins.map( ( win, index ) => ( {
			window: index,
			tokensTyped: tokensTyped[ index ],
			longTasks: { editing: longEdit[ index ], idle: longIdle[ index ] },
			editing: {
				all: span( startAll[ index ], editAll[ index ] ),
				sync: span( startSync[ index ], editSync[ index ] ),
			},
			idle: {
				all: span( editAll[ index ], idleAll[ index ] ),
				sync: span( editSync[ index ], idleSync[ index ] ),
			},
		} ) ),
	};
}

/**
 * Delivery evidence is retained even when content verification fails.
 *
 * @param {Array<Object>}      wins           Editor windows.
 * @param {Array<Object>|null} advisoryBefore Advisory state before typing.
 * @param {string|null}        error          Phase failure, if any.
 */
async function sessionReport( wins, advisoryBefore = null, error = null ) {
	const editors = await readEditors( wins.map( ( win ) => win.page ) );
	const scripts = wins.map( ( win ) =>
		editingScript( win.index, EDIT_SECONDS * 1000 )
	);
	const result = {
		peers: wins.length,
		limits,
		error,
		pageErrors: wins.reduce(
			( total, win ) => total + win.errors().pageErrors,
			0
		),
		requestErrors: wins.reduce(
			( total, win ) => total + win.errors().requestErrors,
			0
		),
		errors: wins.map( ( win ) => win.errors() ),
		correct: editors.every( ( editor ) =>
			matchesDocument( editor.content, expectedDocument( WINDOWS ) )
		),
		delivery: deliveryMeasurements( editors, scripts ),
		content: contentAudit( editors, scripts ),
		advisoryBefore,
		advisoryAfter: editors.map( ( editor ) => editor.advisory ),
		editors,
	};
	return { ...result, ...assessRun( result, limits ) };
}

function printSession( session ) {
	const latency = session.delivery.latencyMs;
	console.log(
		'\nEdit delivery (milliseconds, from input to another editor’s data):'
	);
	console.log( '| Peers | p50 ms | p95 ms | p99 ms | Missing | Result |' );
	console.log( '| --- | --- | --- | --- | --- | --- |' );
	console.log(
		`| ${ session.peers } | ${ latency?.p50 ?? '—' } | ${
			latency?.p95 ?? '—'
		} | ${ latency?.p99 ?? '—' } | ${ session.delivery.missing } | ${
			session.passed ? 'PASS' : 'FAIL'
		} |`
	);
	console.log(
		`Final content: ${
			session.correct ? 'complete in every editor' : 'incorrect'
		}; ${ session.content.missingCopies } missing marker copies, ${
			session.content.extraCopies
		} duplicate copies; ${
			session.content.seenThenMissingCopies
		} missing copies had appeared earlier.`
	);
	console.log(
		`Maximum typing schedule delay: ${
			session.delivery.scheduleLagMs
				? Math.round( session.delivery.scheduleLagMs.max )
				: 'unavailable'
		} ms. p95 limit: ${
			limits.p95Ms === null ? 'not set' : `${ limits.p95Ms } ms`
		}.`
	);
	for ( const reason of session.reasons ) {
		console.log( `  ${ reason }` );
	}
	if ( session.advisoryAfter.some( ( peer ) => peer?.overCap ) ) {
		console.log(
			'The advisory peer limit was exceeded; polling uses its timer fallback.'
		);
	}
	console.log(
		'This measures one workload and host; it does not establish a production peer limit.'
	);
}

function writeReport( report ) {
	if ( JSON_PATH ) {
		fs.mkdirSync( path.dirname( JSON_PATH ), { recursive: true } );
		fs.writeFileSync( JSON_PATH, JSON.stringify( report, null, 2 ) );
		console.log( `\njson written: ${ JSON_PATH }` );
	}
}

/**
 * Sums one client counter over a span across a phase's windows.
 *
 * @param {Object} phase   measurePhase result.
 * @param {string} spanKey 'editing' or 'idle'.
 * @param {string} counter Counter name.
 * @return {number} Total across windows.
 */
function spanTotal( phase, spanKey, counter ) {
	return phase.perWindow.reduce(
		( total, win ) => total + win[ spanKey ].all[ counter ],
		0
	);
}

/**
 * Per-person-per-minute client rate for a span. `ms` is the span's
 * wall time and `persons` how many people were active in it — for the
 * serial baseline each accumulated session minute has exactly one
 * active person, so persons is 1 over the summed session time.
 *
 * @param {number} total   Counter total over the span.
 * @param {number} ms      Span wall time (summed for serial sessions).
 * @param {number} persons Active people sharing the span.
 * @return {number} Rate per person-minute.
 */
function ratePerPersonMinute( total, ms, persons ) {
	return ms > 0 ? ( total / ( ms * persons ) ) * 60000 : 0;
}

/**
 * Aggregates request-log rows for one approach + scenario.
 *
 * @param {Array<Object>} rows     Raw log rows.
 * @param {string}        approach Approach label to keep.
 * @param {string}        scenario Scenario label to keep.
 * @return {Object} Sums, count, and memory extremes.
 */
function aggregateServerRows( rows, approach, scenario ) {
	const kept = rows.filter(
		( row ) => row.approach === approach && row.scenario === scenario
	);
	const sum = ( key ) =>
		kept.reduce( ( total, row ) => total + ( row[ key ] ?? 0 ), 0 );
	return {
		n: kept.length,
		cpuMsSum: sum( 'total_cpu_ms' ),
		totalMsSum: sum( 'total_ms' ),
		dbQueriesSum: sum( 'db_queries' ),
		optionWritesSum: sum( 'option_writes' ),
		peakMemoryMax: kept.reduce(
			( max, row ) => Math.max( max, row.peak_memory ?? 0 ),
			0
		),
		peakMemoryMean: kept.length ? sum( 'peak_memory' ) / kept.length : 0,
	};
}

/**
 * Server-side per-person-per-minute figures for one measured span.
 *
 * @param {Object} agg     aggregateServerRows result.
 * @param {number} ms      Span duration.
 * @param {number} persons Windows sharing the span's traffic.
 * @return {Object|null} Rates, or null when the span has no rows.
 */
function serverRates( agg, ms, persons ) {
	if ( ! agg || 0 === agg.n || ms <= 0 ) {
		return null;
	}
	const minutes = ms / 60000;
	return {
		requestsPerMinute: agg.n / minutes / persons,
		cpuMsPerMinute: agg.cpuMsSum / minutes / persons,
		workerShare: agg.totalMsSum / ms / persons,
		dbQueriesPerMinute: agg.dbQueriesSum / minutes / persons,
		optionWritesPerMinute: agg.optionWritesSum / minutes / persons,
		peakMemoryMaxMb: agg.peakMemoryMax / 1048576,
		peakMemoryMeanMb: agg.peakMemoryMean / 1048576,
	};
}

/**
 * Builds one engine's summary from its phase + the shared serial
 * baseline: per-span baseline/sync rates, plus the whole-job totals —
 * both phases produce the same final document, so "what did producing
 * this document cost" is directly comparable.
 *
 * @param {Object}        phase          The engine's measurePhase result.
 * @param {Object}        baseline       Serial baseline { sessions, editMs, idleMs }.
 * @param {Array}         rows           All server rows (may be empty).
 * @param {string}        engine         Engine slug (the approach label).
 * @param {Array<string>} coverageLimits Reasons server totals are unavailable.
 * @param {Object|null}   timeline       Validated server samples and clock.
 * @return {Object} { spans, job } for the report.
 */
function summarize( phase, baseline, rows, engine, coverageLimits, timeline ) {
	// Preserve raw rows, but never present partial measurements as totals.
	if ( coverageLimits.length ) {
		rows = [];
	}
	const lastSession = baseline.sessions[ baseline.sessions.length - 1 ];
	const baseTotal = ( spanKey, counter ) =>
		'editing' === spanKey
			? baseline.sessions.reduce(
					( total, session ) =>
						total + spanTotal( session, spanKey, counter ),
					0
			  )
			: spanTotal( lastSession, spanKey, counter );

	const spans = {};
	for ( const spanKey of [ 'editing', 'idle' ] ) {
		const ms = 'editing' === spanKey ? phase.editMs : phase.idleMs;
		const baseMs =
			'editing' === spanKey ? baseline.editMs : baseline.idleMs;
		// Serial baseline: every accumulated minute has ONE active
		// person; the idle tab is one person's in both phases' baselines.
		const basePersons = 1;
		const rate = ( counter ) =>
			ratePerPersonMinute(
				spanTotal( phase, spanKey, counter ),
				ms,
				WINDOWS
			);
		const baseRate = ( counter ) =>
			ratePerPersonMinute(
				baseTotal( spanKey, counter ),
				baseMs,
				basePersons
			);
		const sumDbIo = ( deltas ) =>
			deltas.every( ( delta ) => delta )
				? deltas.reduce(
						( acc, delta ) => ( {
							fsyncs: acc.fsyncs + delta.fsyncs,
						} ),
						{ fsyncs: 0 }
				  )
				: null;
		const baseIoDelta =
			'editing' === spanKey
				? sumDbIo(
						baseline.sessions.map(
							( session ) => session.dbIo.editing
						)
				  )
				: lastSession.dbIo.idle;
		// Editor responsiveness: the longest single task any window saw,
		// and long-task time per person-minute. Rows from runs made
		// before this was measured have no longTasks: report nothing.
		const longTasks = ( sessions, msTotal, persons ) => {
			const all = sessions.flatMap( ( session ) =>
				session.perWindow.map( ( win ) => win.longTasks?.[ spanKey ] )
			);
			if ( all.some( ( entry ) => ! entry ) || msTotal <= 0 ) {
				return { longestTaskMs: null, longTaskMsPerMinute: null };
			}
			return {
				longestTaskMs: Math.max( ...all.map( ( entry ) => entry.max ) ),
				longTaskMsPerMinute: ratePerPersonMinute(
					all.reduce( ( sum, entry ) => sum + entry.total, 0 ),
					msTotal,
					persons
				),
			};
		};
		const baseSessions =
			'editing' === spanKey ? baseline.sessions : [ lastSession ];
		spans[ spanKey ] = {
			client: {
				...longTasks( [ phase ], ms, WINDOWS ),
				requestsPerMinute: rate( 'requests' ),
				wsFramesPerMinute: rate( 'wsFrames' ),
				kbPerMinute:
					( rate( 'requestBytes' ) + rate( 'responseBytes' ) ) / 1024,
			},
			baseClient: {
				...longTasks( baseSessions, baseMs, basePersons ),
				requestsPerMinute: baseRate( 'requests' ),
				wsFramesPerMinute: baseRate( 'wsFrames' ),
				kbPerMinute:
					( baseRate( 'requestBytes' ) +
						baseRate( 'responseBytes' ) ) /
					1024,
			},
			server: serverRates(
				aggregateServerRows( rows, engine, `host-${ spanKey }` ),
				ms,
				WINDOWS
			),
			baseServer: serverRates(
				aggregateServerRows( rows, 'baseline', `host-${ spanKey }` ),
				baseMs,
				basePersons
			),
			io: dbIoRates( phase.dbIo[ spanKey ], ms, WINDOWS ),
			baseIo: dbIoRates( baseIoDelta, baseMs, basePersons ),
		};
		if ( timeline && ! coverageLimits.length ) {
			const syncMeasured = measureTimelines(
				timeline.rows.filter( ( row ) => row.approach === engine ),
				[ phase.windows[ spanKey ] ],
				timeline.clock,
				WINDOWS
			);
			const baseWindows =
				spanKey === 'editing'
					? baseline.sessions.map(
							( session ) => session.windows.editing
					  )
					: [ lastSession.windows.idle ];
			const baseMeasured = measureTimelines(
				timeline.rows.filter( ( row ) => row.approach === 'baseline' ),
				baseWindows,
				timeline.clock,
				1
			);
			// Timelines bound CPU, worker time, and queries; the PHP
			// request rate still comes from the request rows.
			const withRequests = ( measured, rowRates ) =>
				measured && {
					...measured,
					requestsPerMinute: rowRates?.requestsPerMinute ?? null,
				};
			Object.assign( spans[ spanKey ], {
				server: withRequests(
					syncMeasured.rates,
					spans[ spanKey ].server
				),
				baseServer: withRequests(
					baseMeasured.rates,
					spans[ spanKey ].baseServer
				),
				serverTotals: syncMeasured.totals,
				baseServerTotals: baseMeasured.totals,
			} );
		}
	}

	// Whole-job totals over the editing spans (saves included; idle
	// excluded): the cost of producing the same final document once in
	// series and once collaboratively.
	const baseServerJob = aggregateServerRows(
		rows,
		'baseline',
		'host-editing'
	);
	const engineServerJob = aggregateServerRows( rows, engine, 'host-editing' );
	const tokens = ( sessions ) =>
		sessions.reduce(
			( total, session ) =>
				total +
				session.perWindow.reduce(
					( sum, win ) => sum + win.tokensTyped,
					0
				),
			0
		);
	const job = {
		base: {
			tokens: tokens( baseline.sessions ),
			requests: baseTotal( 'editing', 'requests' ),
			kb:
				( baseTotal( 'editing', 'requestBytes' ) +
					baseTotal( 'editing', 'responseBytes' ) ) /
				1024,
			serverCpuS: baseServerJob.n ? baseServerJob.cpuMsSum / 1000 : null,
		},
		sync: {
			tokens: tokens( [ phase ] ),
			requests: spanTotal( phase, 'editing', 'requests' ),
			kb:
				( spanTotal( phase, 'editing', 'requestBytes' ) +
					spanTotal( phase, 'editing', 'responseBytes' ) ) /
				1024,
			serverCpuS: engineServerJob.n
				? engineServerJob.cpuMsSum / 1000
				: null,
		},
	};
	if ( spans.editing.serverTotals ) {
		for ( const [ side, total ] of [
			[ 'sync', spans.editing.serverTotals ],
			[ 'base', spans.editing.baseServerTotals ],
		] ) {
			job[ side ].serverCpuS = {
				min: total.cpu_ms.min / 1000,
				max: total.cpu_ms.max / 1000,
			};
		}
	}
	return { spans, job };
}

async function main() {
	if (
		! Number.isInteger( WINDOWS ) ||
		WINDOWS < 1 ||
		! Number.isFinite( IDLE_SECONDS ) ||
		IDLE_SECONDS < 0
	) {
		throw new Error(
			'windows must be a positive integer and idle-seconds must be non-negative'
		);
	}
	if ( ! Number.isFinite( EDIT_SECONDS ) || EDIT_SECONDS < 30 ) {
		throw new Error( 'edit-seconds must be at least 30' );
	}
	if ( ! POST_SIZES.includes( POST_SIZE ) ) {
		throw new Error(
			`post-size must be one of ${ POST_SIZES.join( ', ' ) }`
		);
	}
	if ( ! PATTERNS.includes( PATTERN ) ) {
		throw new Error( `pattern must be one of ${ PATTERNS.join( ', ' ) }` );
	}
	if ( ! Number.isInteger( REPEAT ) || REPEAT < 1 ) {
		throw new Error( 'repeat must be a positive integer' );
	}
	if ( null !== POLL_OVERRIDE && ! Number.isFinite( POLL_OVERRIDE ) ) {
		throw new Error(
			'polling-interval must be a number of seconds (0-25)'
		);
	}
	const unknownMetrics = METRICS.filter(
		( metric ) => ! ALL_METRICS.includes( metric )
	);
	if ( unknownMetrics.length ) {
		throw new Error(
			`unknown metrics: ${ unknownMetrics.join(
				', '
			) } (known: ${ ALL_METRICS.join( ', ' ) })`
		);
	}

	for ( const endpoint of SOCKET_METRICS ) {
		const url = new URL( endpoint );
		if (
			! [ 'http:', 'https:' ].includes( url.protocol ) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'websocket-metrics requires HTTP(S) URLs without credentials, query strings, or fragments.'
			);
		}
	}
	selectHostBenchmarkSite();
	console.log( `target: ${ BASE }` );
	await checkMeasurementSupport( BASE );
	const socketChecks = await sampleSocketProcesses( SOCKET_METRICS );
	if ( socketChecks.some( ( entry ) => entry.error ) ) {
		throw new Error(
			'WebSocket measurement check failed before site changes. Enable GSE_BENCH_METRICS=1 on each selected server.'
		);
	}

	// Playwright's own signal handling would close the browser the
	// instant Ctrl+C lands, killing the REST transport the site-state
	// restore below runs through — so signals are handled here instead.
	// The object cache and the SSE wait are site-wide: set them before
	// any window opens (the baseline phase runs under them too).
	let hostCache = null;
	const browser = await chromium.launch( {
		headless: ! HEADED,
		handleSIGINT: false,
		handleSIGTERM: false,
	} );
	const context = await browser.newContext();
	const tag = { scenario: 'setup', approach: 'baseline' };
	const measuredPages = new Set();
	const tracking = await installGlobalTagging( context, tag, measuredPages );

	let originalSettings = null;
	let lastActive = null;
	let deactivated = [];
	let experimentWasOn = null;
	let originalPoll = 0;
	let pollChanged = false;
	let adminPage = null;
	let rest = null;

	// The run mutates real site state (plugin activation, the polling
	// interval, engine/transport, the experiment). Restoring it must
	// survive Ctrl+C, or an interrupted run leaves the site quietly
	// misconfigured — a 25 s polling interval left behind, for example,
	// makes every later measurement wrong while looking healthy.
	let cleanedUp = false;
	const cleanup = async () => {
		if ( cleanedUp ) {
			return;
		}
		cleanedUp = true;
		for ( const plugin of deactivated ) {
			await setPluginStatus( rest, plugin, 'active' ).catch( ( error ) =>
				console.warn(
					`WARNING: could not reactivate ${ plugin }: ${ error }`
				)
			);
		}
		deactivated = [];
		if ( pollChanged && rest ) {
			await rest
				.post( '/wp/v2/settings', {
					body: { [ POLLING_INTERVAL_SETTING ]: originalPoll },
				} )
				.catch( ( error ) =>
					console.warn(
						`WARNING: failed to restore the polling interval: ${ error }`
					)
				);
		}
		if (
			originalSettings &&
			adminPage &&
			lastActive &&
			( originalSettings.previous.engine !== lastActive.engine ||
				originalSettings.previous.transport !== lastActive.transport )
		) {
			await restoreSettings( adminPage, originalSettings.previous ).catch(
				( error ) =>
					console.warn(
						`WARNING: failed to restore settings: ${ error }`
					)
			);
		}
		if ( false === experimentWasOn && rest ) {
			const current = await rest.get( '/wp/v2/settings' );
			const experiments = {
				...( current.data?.[ 'gutenberg-experiments' ] || {} ),
			};
			delete experiments[ COLLABORATION_EXPERIMENT ];
			await rest
				.post( '/wp/v2/settings', {
					body: { 'gutenberg-experiments': experiments },
				} )
				.catch( () => null );
		}
		try {
			restoreHostCache( hostCache );
		} catch ( error ) {
			console.warn(
				`WARNING: failed to restore the object cache: ${ error }`
			);
		}
		await browser.close().catch( () => null );
	};
	const onSignal = ( signal ) => {
		console.error( `\n${ signal } — restoring site state before exit…` );
		cleanup().finally( () => process.exit( 130 ) );
	};
	process.once( 'SIGINT', () => onSignal( 'SIGINT' ) );
	process.once( 'SIGTERM', () => onSignal( 'SIGTERM' ) );

	try {
		hostCache = configureHostCache( { cache: CACHE, wake: WAKE } );
		adminPage = await login( context );
		rest = await makeRestClient( adminPage );
		if ( ! rest ) {
			throw new Error( 'could not obtain a REST nonce' );
		}

		// Database disk-I/O sampler: the mu-plugin answers a tagged
		// `_rtcdbio` probe with the server's InnoDB counters and exits
		// before WordPress routes — so it works with the plugin
		// deactivated (the baseline phase) and never logs itself.
		const sampleDbIo = async () => {
			try {
				const response = await adminPage.request.get(
					`${ BASE }/?_rtctest=1&_rtcdbio=1`
				);
				const data = await response.json();
				return data?.available ? data : null;
			} catch {
				return null;
			}
		};

		const sampleClock = async () => {
			const sentMs = Date.now();
			try {
				const response = await adminPage.request.get(
					`${ BASE }/?_rtctest=1&_rtcclock=1`
				);
				const data = await response.json();
				return { ...data, sentMs, receivedMs: Date.now() };
			} catch {
				return null;
			}
		};

		// The plugin must be active at start: its settings screen is how
		// engine/transport are chosen, and its diagnostics log is how the
		// server side is read out. When no copy is active (a PHPUnit run
		// wipes the tests-env database, activation included), activate one
		// — in a worktree the plugin is mounted twice, and the safe copy
		// is the directory-name one (wp-env re-activates it on every
		// start; the reverse arrangement fatals the next start), which is
		// the copy whose directory is NOT the canonical mapping name.
		const copies = await listPluginCopies( rest );
		let activeCopies = copies.filter(
			( copy ) => 'active' === copy.status
		);
		if ( ! activeCopies.length && copies.length ) {
			const preferred =
				copies.find(
					( copy ) =>
						! copy.plugin.startsWith( 'gutenberg-sync-engines/' )
				) ?? copies[ 0 ];
			console.log(
				`no active gutenberg-sync-engines copy — activating ${ preferred.plugin }…`
			);
			await setPluginStatus( rest, preferred.plugin, 'active' );
			activeCopies = [ { ...preferred, status: 'active' } ];
		}
		if ( ! activeCopies.length ) {
			throw new Error(
				`no gutenberg-sync-engines plugin on ${ BASE } — install and activate it, then rerun`
			);
		}

		// Choose the engine/transport up front (recording what to restore
		// at the end), and whether the collaboration experiment was on.
		originalSettings = await configureSettings(
			adminPage,
			ENGINE,
			TRANSPORT
		);
		lastActive = originalSettings.active;
		const engine = originalSettings.active.engine;
		const settingsBefore = await rest.get( '/wp/v2/settings' );
		experimentWasOn = Boolean(
			settingsBefore.data?.[ 'gutenberg-experiments' ]?.[
				COLLABORATION_EXPERIMENT
			]
		);
		originalPoll = Number(
			settingsBefore.data?.[ POLLING_INTERVAL_SETTING ] ?? 0
		);
		if ( null !== POLL_OVERRIDE && POLL_OVERRIDE !== originalPoll ) {
			const updated = await rest.post( '/wp/v2/settings', {
				body: { [ POLLING_INTERVAL_SETTING ]: POLL_OVERRIDE },
			} );
			if ( 200 !== updated.status ) {
				throw new Error(
					`setting the polling interval to ${ POLL_OVERRIDE }s failed (${ updated.status })`
				);
			}
			pollChanged = true;
		}
		await ensureCollaborationEnabled( adminPage );
		await rest.del( '/rtc-test/v1/log' ).catch( () => null );

		// Say exactly what this run will measure, and where it runs,
		// before spending minutes measuring it.
		console.log( 'configuration:' );
		console.log( '  suite=host' );
		console.log( `  engine=${ engine }` );
		console.log( `  transport=${ originalSettings.active.transport }` );
		console.log(
			`  cache=${ CACHE } wake=${ WAKE }${
				hostCache
					? ` (was cache=${ hostCache.previous.cache } wake=${ hostCache.previous.wake })`
					: ''
			}`
		);
		console.log( `  edit-seconds=${ EDIT_SECONDS }` );
		console.log( `  idle-seconds=${ IDLE_SECONDS }` );
		console.log(
			`  peers=${ WINDOWS } (separate browser connection pools)`
		);
		console.log(
			`  post-size=${ POST_SIZE } (${
				postFixture( WINDOWS, POST_SIZE ).blocks
			} blocks)`
		);
		console.log( `  pattern=${ PATTERN }` );
		console.log(
			`  p95-ms=${ limits.p95Ms ?? 'not set' } max-lag-ms=${
				limits.maxLagMs
			}`
		);
		console.log(
			'  The client join limit is overridden only in benchmark browsers.'
		);
		// The interval only governs the HTTP short-polling transport;
		// under the other transports the line would mislead. 0 stored
		// means the plugin defaults, which during a session with
		// collaborators is five seconds — print the effective value.
		if ( 'http-polling' === originalSettings.active.transport ) {
			if ( null !== POLL_OVERRIDE ) {
				console.log( `  polling-interval=${ POLL_OVERRIDE }` );
			} else if ( originalPoll > 0 ) {
				console.log(
					`  polling-interval=${ originalPoll } (site setting)`
				);
			} else {
				console.log( '  polling-interval=5 (default)' );
			}
		}
		if ( undefined !== opts.metrics ) {
			console.log( `  metrics=${ METRICS.join( ',' ) }` );
		}
		if ( JSON_PATH ) {
			console.log( `  json=${ JSON_PATH }` );
		}

		const envResponse = await rest.get( '/rtc-test/v1/env' );
		const serverEnv = 200 === envResponse.status ? envResponse.data : null;
		if ( serverEnv ) {
			console.log( 'environment:' );
			console.log( `  server: PHP ${ serverEnv.php_version }` );
			console.log( `  wp: ${ serverEnv.wp_version }` );
			console.log( `  mysql: ${ serverEnv.mysql_version }` );
		}

		// The run's setup, as it will be recorded. The baseline key is
		// what the plugin-off phase depends on: a saved phase with the
		// same key measured exactly this, so it is reused.
		const environment = runEnvironment( serverEnv );
		const fixture = postFixture( WINDOWS, POST_SIZE );
		const setup = {
			engine,
			transport: originalSettings.active.transport,
			delivery: originalSettings.active.delivery,
			cache: CACHE,
			wake: WAKE,
			windows: WINDOWS,
			postSize: POST_SIZE,
			postBlocks: fixture.blocks,
			postBytes: fixture.bytes,
			// Identifies the exact starting content, which can change
			// between runs on the same commit in an uncommitted tree.
			postHash: shortHash( fixture.content ),
			pattern: PATTERN,
			editSeconds: EDIT_SECONDS,
			idleSeconds: IDLE_SECONDS,
			// 0 = the plugin's defaults.
			pollingInterval: POLL_OVERRIDE ?? originalPoll,
		};
		const savedBaselineFile = BASELINE_CACHE
			? path.join(
					BASELINE_CACHE,
					`${ shortHash(
						baselineKey( setup, environment, BASE, REPEAT )
					) }.json`
			  )
			: null;

		const storageState = await context.storageState();
		const editorContext = async () => {
			const peerContext = await browser.newContext( { storageState } );
			await installGlobalTagging(
				peerContext,
				tag,
				measuredPages,
				tracking
			);
			await allowPeers( peerContext, WINDOWS );
			return peerContext;
		};

		// ---------------- Phase 1: baseline (plugin deactivated) --------
		// The baseline is the workflow the plugin replaces: the same
		// number of people producing the same document by editing IN
		// SERIES — person i types their part, saves, and leaves, then
		// person i+1 takes a turn. Each person types the same script
		// their window types in the sync phase, so the final document
		// matches in size and shape and the whole-job totals are
		// directly comparable.
		let baseline = null;
		let baselinePost = null;
		let savedBaselineRows = null;
		if ( savedBaselineFile && fs.existsSync( savedBaselineFile ) ) {
			const saved = JSON.parse(
				fs.readFileSync( savedBaselineFile, 'utf8' )
			);
			baseline = saved.baseline;
			baselinePost = saved.postId;
			savedBaselineRows = saved.serverRows;
			// The saved phase's PHP requests count as this run's: the
			// server totals and timelines below require every tracked
			// request to have its row.
			for ( const row of savedBaselineRows ) {
				tracking.issued.add( row.request_id );
				tracking.expected.add( row.request_id );
			}
			console.log( '' );
			console.log(
				`Reusing the saved baseline phase (plugin deactivated): ${ savedBaselineFile }`
			);
		} else {
			baselinePost = await createDraft( rest, 'baseline' );
			console.log( '' );
			console.log( 'Running baseline phase (plugin deactivated)…' );
			console.log(
				`  ${ WINDOWS } person(s) editing post ${ baselinePost } in series…`
			);
			for ( const copy of activeCopies ) {
				await setPluginStatus( rest, copy.plugin, 'inactive' );
				deactivated.push( copy.plugin );
			}

			const baselineSessions = [];
			for ( let person = 0; person < WINDOWS; person++ ) {
				const isLast = person === WINDOWS - 1;
				console.log( `  baseline step ${ person + 1 }/${ WINDOWS }…` );
				const win = await openEditorWindow(
					await editorContext(),
					measuredPages,
					baselinePost,
					person
				);
				const session = await measurePhase(
					[ win ],
					tag,
					rest,
					expectedDocument( person + 1 ),
					sampleClock,
					isLast,
					sampleDbIo
				);
				await win.page.context().close();
				if ( session.perWindow[ 0 ].editing.sync.requests > 0 ) {
					throw new Error(
						'a baseline step made sync requests — the plugin was still active, so the comparison is meaningless'
					);
				}
				baselineSessions.push( session );
			}
			baseline = {
				sessions: baselineSessions,
				editMs: baselineSessions.reduce(
					( total, session ) => total + session.editMs,
					0
				),
				idleMs: baselineSessions[ baselineSessions.length - 1 ].idleMs,
			};

			for ( const plugin of deactivated ) {
				await setPluginStatus( rest, plugin, 'active' );
			}
			deactivated = [];

			if ( savedBaselineFile ) {
				const logged = await rest.get( '/rtc-test/v1/log' );
				fs.mkdirSync( BASELINE_CACHE, { recursive: true } );
				fs.writeFileSync(
					savedBaselineFile,
					JSON.stringify( {
						key: baselineKey( setup, environment, BASE, REPEAT ),
						postId: baselinePost,
						baseline,
						serverRows: ( Array.isArray( logged.data )
							? logged.data
							: []
						).filter(
							( row ) =>
								'baseline' === row.approach &&
								tracking.issued.has( row.request_id )
						),
					} )
				);
			}
		}

		// ---------------- Phase 2: the sync phase ------------------------
		tag.approach = engine;
		const post = await createDraft( rest, engine );
		console.log( 'Running sync phase…' );
		console.log(
			`  ${ WINDOWS } person(s) editing post ${ post } simultaneously…`
		);

		const wins = [];
		for ( let index = 0; index < WINDOWS; index++ ) {
			const win = await openEditorWindow(
				await editorContext(),
				measuredPages,
				post,
				index
			);
			if (
				( await win.page.evaluate(
					() => window.__hostBenchmarkLimit
				) ) !== WINDOWS
			) {
				throw new Error(
					'The benchmark peer-limit override did not load.'
				);
			}
			await waitForSyncTraffic( win.page, win.sync, String( index ) );
			wins.push( win );
		}
		// Polling carries the initial join even when SSE is selected. Wait
		// for the selected receive transport after all peers have joined.
		// A solo SSE editor may correctly remain quiet without a stream.
		let observed = observeTransport( wins[ 0 ].sync );
		const selectedTransport = originalSettings.active.transport;
		if (
			! (
				WINDOWS === 1 &&
				[ 'sse', 'sse-daemon' ].includes( selectedTransport )
			)
		) {
			const deadline = Date.now() + 45000;
			while (
				wins.some(
					( win ) =>
						observeTransport( win.sync ) !==
						( selectedTransport === 'sse-daemon'
							? 'sse'
							: selectedTransport )
				)
			) {
				if ( Date.now() >= deadline ) {
					throw new Error(
						`selected transport "${ selectedTransport }" did not become active in every editor`
					);
				}
				await wins[ 0 ].page.waitForTimeout( 250 );
			}
			observed = observeTransport( wins[ 0 ].sync );
		}

		let phase;
		try {
			phase = await measurePhase(
				wins,
				tag,
				rest,
				expectedDocument( WINDOWS ),
				sampleClock,
				true,
				sampleDbIo
			);
		} catch ( error ) {
			const session = await sessionReport( wins, null, error.message );
			printSession( session );
			writeReport( {
				schemaVersion: 3,
				measurement: { contentVerified: false },
				environment: {
					date: new Date().toISOString(),
					baseUrl: BASE,
					peers: WINDOWS,
					engine,
					delivery: originalSettings.active.delivery,
					transportRequested: selectedTransport,
					pollingIntervalSeconds: POLL_OVERRIDE ?? originalPoll,
					editSeconds: EDIT_SECONDS,
					idleSeconds: IDLE_SECONDS,
					browserIsolation: 'peer',
				},
				session,
			} );
			throw error;
		}
		observed = observeTransport( wins[ 0 ].sync );
		for ( const win of wins ) {
			const edited = phase.perWindow[ win.index ].editing.sync;
			if (
				0 === edited.dataRequests &&
				0 === edited.sseBytesReceived &&
				0 === edited.wsSyncFramesSent + edited.wsSyncFramesReceived
			) {
				throw new Error(
					`sync window ${ win.index } made no sync data traffic while editing — dead session, numbers unusable`
				);
			}
			await win.page.context().close();
		}
		tag.approach = 'baseline';

		// Disk per room: what this session's server-side history holds
		// at rest (community feedback: growth on low-traffic sites).
		const roomSize = await rest
			.get(
				`/rtc-test/v1/room-size?room=${ encodeURIComponent(
					`postType/post:${ post }`
				) }`
			)
			.then( ( response ) =>
				200 === response.status && response.data?.found
					? response.data
					: null
			)
			.catch( () => null );

		// ---------------- Collect and report ----------------------------
		// A closed browser stream can occupy PHP until its next write notices
		// the disconnect. Wait for every tagged PHP request's shutdown row.
		let serverRows = [];
		const collectionDeadline = Date.now() + 20000;
		while ( true ) {
			const logResponse = await rest.get( '/rtc-test/v1/log' );
			serverRows = Array.isArray( logResponse.data )
				? logResponse.data
				: [];
			// A reused baseline phase was logged by an earlier run: its
			// rows come from the saved file, and this run's log holds
			// only the sync phase.
			if ( savedBaselineRows ) {
				serverRows = [
					...savedBaselineRows,
					...serverRows.filter(
						( row ) => 'baseline' !== row.approach
					),
				];
			}
			const received = new Set(
				serverRows.map( ( row ) => row.request_id )
			);
			if (
				[ ...tracking.expected ].every( ( id ) =>
					received.has( id )
				) ||
				Date.now() >= collectionDeadline
			) {
				break;
			}
			await adminPage.waitForTimeout( 250 );
		}
		let timeline = null;
		let timelineError = null;
		try {
			const clock = clockRange( [
				...baseline.sessions.flatMap(
					( session ) => session.clockProbes
				),
				...phase.clockProbes,
			] );
			const rows = serverRows.filter( ( row ) =>
				tracking.issued.has( row.request_id )
			);
			validateTimelines( rows, tracking.expected, clock );
			timeline = { clock, rows };
		} catch ( error ) {
			timelineError = error.message;
		}

		const muPresent = serverRows.some(
			( row ) => 'baseline' === row.approach
		);

		const coverageLimits = serverCoverageLimits( {
			muMeasurement: muPresent,
			timeline: Boolean( timeline ),
			transport: wins.some(
				( win ) => win.sync.snapshot().sseStreams > 0
			)
				? 'sse'
				: observed,
			sockets: wins.some( ( win ) => {
				const counters = win.sync.snapshot();
				return counters.wsFramesSent + counters.wsFramesReceived > 0;
			} ),
		} );

		if ( timelineError ) {
			coverageLimits.push( timelineError );
		}

		const report = {
			schemaVersion: 3,
			session: phase.session,
			measurement: {
				contentVerified: true,
				missingRequests: [ ...tracking.expected ]
					.filter(
						( id ) =>
							! serverRows.some(
								( row ) => row.request_id === id
							)
					)
					.map( ( id ) => ( {
						requestId: id,
						...tracking.requests.get( id ),
					} ) ),
				timeline: timeline
					? {
							clock: timeline.clock,
							requests: timeline.rows.length,
							samples: timeline.rows.reduce(
								( sum, row ) =>
									sum + row.timeline.samples.length,
								0
							),
							truncatedRequests: timeline.rows.filter(
								( row ) => row.timeline.truncated
							).length,
							method: 'Timestamp overlap for worker time; lower/upper bounds for CPU and query work across sample and clock boundaries.',
					  }
					: null,
				serverCoverageLimits: coverageLimits,
				traffic:
					'HTTP body, SSE, and WebSocket payload bytes; excludes headers, protocol overhead, compression effects, and WebRTC.',
			},
			environment: {
				date: new Date().toISOString(),
				baseUrl: BASE,
				windows: WINDOWS,
				peers: WINDOWS,
				browserIsolation: 'peer',
				editSeconds: EDIT_SECONDS,
				idleSeconds: IDLE_SECONDS,
				postSize: POST_SIZE,
				pattern: PATTERN,
				muMeasurement: muPresent,
				timeline: Boolean( timeline ),
				server: serverEnv,
				cache: CACHE,
				wake: WAKE,
				delivery: originalSettings.active.delivery,
				transportRequested: selectedTransport,
				pollingIntervalSeconds: POLL_OVERRIDE ?? originalPoll,
			},
			baseline: {
				postId: baselinePost,
				reusedFrom: savedBaselineRows ? savedBaselineFile : null,
				detail: baseline,
			},
			engine: {
				engine,
				transport: observed,
				sseWait: observeSseWait( wins[ 0 ].sync ),
				postId: post,
				roomSize,
				...summarize(
					phase,
					baseline,
					serverRows,
					engine,
					coverageLimits,
					timeline
				),
				detail: phase,
			},
			serverRows,
		};

		printReport( report );

		printSession( phase.session );
		if ( RECORD_PATH && phase.session.passed ) {
			appendRecord( RECORD_PATH, {
				format: RECORD_FORMAT,
				run: {
					plan: PLAN,
					cell: CELL,
					repeat: REPEAT,
					startedAt: new Date( RUN_STARTED ).toISOString(),
					durationS: Math.round(
						( Date.now() - RUN_STARTED ) / 1000
					),
					baselineReused: Boolean( savedBaselineRows ),
					serverCoverageLimits: coverageLimits,
				},
				setup: { ...setup, transport: observed },
				environment: { ...environment, baseUrl: BASE },
				results: resultsOf(
					report.engine,
					roomSize,
					IDLE_SECONDS > 0,
					phase.session.delivery
				),
			} );
			console.log( `result line appended: ${ RECORD_PATH }` );
		}
		writeReport( report );
		if ( ! phase.session.passed ) {
			process.exitCode = 1;
		}
	} finally {
		await cleanup();
	}
}

/**
 * Renders the RESULTS section: two markdown tables (editing, idle),
 * then the summary stats and the pointer to the README.
 *
 * @param {Object} report Assembled report.
 */
function printReport( report ) {
	const env = report.environment;
	const bounds = ( value ) =>
		typeof value === 'number' ? { min: value, max: value } : value;
	const fmt = ( value, decimals ) => {
		if ( value === null || value === undefined ) {
			return '—';
		}
		const { min, max } = bounds( value );
		return min === max
			? min.toFixed( decimals )
			: `${ min.toFixed( decimals ) }–${ max.toFixed( decimals ) }`;
	};
	const delta = ( base, sync, decimals ) => {
		if (
			base === null ||
			base === undefined ||
			sync === null ||
			sync === undefined
		) {
			return '—';
		}
		const a = bounds( base );
		const b = bounds( sync );
		return fmt( { min: b.min - a.max, max: b.max - a.min }, decimals );
	};
	const pct = ( base, sync ) => {
		if (
			typeof base !== 'number' ||
			typeof sync !== 'number' ||
			base === 0
		) {
			return '—';
		}
		return `${ Math.round( ( ( sync - base ) / base ) * 100 ) }%`;
	};

	// One markdown table per span: the first column names the span
	// ("metric (editing)"), so row labels stay clean. The label column
	// is left-aligned, the number columns right-aligned.
	const renderTable = ( title, rows ) => {
		const headers = [ title, 'baseline', 'sync', 'delta', 'delta %' ];
		const widths = headers.map( ( header, column ) =>
			Math.max(
				header.length,
				...rows.map( ( row ) => row[ column ].length )
			)
		);
		const pad = ( cell, column ) =>
			0 === column
				? cell.padEnd( widths[ column ] )
				: cell.padStart( widths[ column ] );
		const line = ( cells ) => `| ${ cells.map( pad ).join( ' | ' ) } |`;
		console.log( line( headers ) );
		console.log(
			`| ${ widths
				.map( ( width, column ) =>
					0 === column
						? '-'.repeat( width )
						: `${ '-'.repeat( width - 1 ) }:`
				)
				.join( ' | ' ) } |`
		);
		for ( const row of rows ) {
			console.log( line( row ) );
		}
	};

	const buildSpanRows = ( entry, spanKey ) => {
		const span = entry.spans[ spanKey ];
		const rows = [];
		const push = ( metric, label, base, sync, decimals ) => {
			if ( METRICS.includes( metric ) ) {
				rows.push( [
					label,
					fmt( base, decimals ),
					fmt( sync, decimals ),
					delta( base, sync, decimals ),
					pct( base, sync ),
				] );
			}
		};
		push(
			'requests',
			'HTTP requests/min',
			span.baseClient.requestsPerMinute,
			span.client.requestsPerMinute,
			1
		);
		push(
			'traffic',
			'payload KiB/min',
			span.baseClient.kbPerMinute,
			span.client.kbPerMinute,
			1
		);
		push(
			'requests',
			'WebSocket frames/min',
			span.baseClient.wsFramesPerMinute,
			span.client.wsFramesPerMinute,
			1
		);
		push(
			'editor',
			'editor longest task ms',
			span.baseClient.longestTaskMs,
			span.client.longestTaskMs,
			0
		);
		push(
			'editor',
			'editor long-task ms/min',
			span.baseClient.longTaskMsPerMinute,
			span.client.longTaskMsPerMinute,
			0
		);
		push(
			'cpu',
			'PHP CPU ms/min',
			span.baseServer?.cpuMsPerMinute ?? null,
			span.server?.cpuMsPerMinute ?? null,
			1
		);
		push(
			'workers',
			'PHP worker share',
			span.baseServer?.workerShare ?? null,
			span.server?.workerShare ?? null,
			3
		);
		push(
			'cache',
			'options-cache invalidations/min',
			span.baseServer?.optionWritesPerMinute ?? null,
			span.server?.optionWritesPerMinute ?? null,
			1
		);
		push(
			'queries',
			'DB queries/min',
			span.baseServer?.dbQueriesPerMinute ?? null,
			span.server?.dbQueriesPerMinute ?? null,
			1
		);
		push(
			'fsyncs',
			'DB fsyncs/min',
			span.baseIo?.fsyncsPerMinute ?? null,
			span.io?.fsyncsPerMinute ?? null,
			1
		);
		if ( 'editing' === spanKey && METRICS.includes( 'memory' ) ) {
			const base = span.baseServer;
			const sync = span.server;
			rows.push( [
				'peak PHP memory MiB/overlapping request',
				base ? fmt( base.peakMemoryMaxMb, 1 ) : '—',
				sync ? fmt( sync.peakMemoryMaxMb, 1 ) : '—',
				base && sync
					? delta( base.peakMemoryMaxMb, sync.peakMemoryMaxMb, 1 )
					: '—',
				base && sync
					? pct( base.peakMemoryMaxMb, sync.peakMemoryMaxMb )
					: '—',
			] );
		}
		return rows;
	};

	const entry = report.engine;
	console.log( '' );
	console.log( 'RESULTS' );
	console.log( '=======' );
	console.log( '' );
	renderTable( 'metric (editing)', buildSpanRows( entry, 'editing' ) );
	if ( env.idleSeconds > 0 ) {
		console.log( '' );
		renderTable( 'metric (idle)', buildSpanRows( entry, 'idle' ) );
	}

	if ( entry.detail.socketProcesses.editing.length ) {
		console.log(
			'\nWebSocket processes: whole-process costs; sampled periods bracket editing and idle.'
		);
		console.log(
			'Includes unrelated clients and measurement overhead. Memory is sampled at the boundaries, not a peak. Not added to PHP totals.'
		);
		const sessions = [
			...report.baseline.detail.sessions.map( ( session, index ) => [
				`baseline ${ index + 1 }`,
				session,
			] ),
			[ 'sync', entry.detail ],
		];
		for ( const [ label, session ] of sessions ) {
			for ( const period of [ 'editing', 'idle' ] ) {
				for ( const cost of session.socketProcesses[ period ] ) {
					console.log(
						`${ label } ${ period } ${ cost.endpoint }: ${
							cost.error ||
							`${ cost.sampledMs.toFixed(
								0
							) } ms sampled; CPU ${ cost.cpuMs.toFixed(
								1
							) } ms; ${ cost.queries } queries; ${
								cost.memoryKind
							} MiB ${ (
								cost.memoryStartBytes / 1048576
							).toFixed( 1 ) } to ${ (
								cost.memoryEndBytes / 1048576
							).toFixed( 1 ) }`
						}`
					);
				}
			}
		}
	}

	// Stats: single-value results that fit no table. (The whole-job
	// totals stay in the JSON report as engine.job.)
	console.log( '' );
	console.log(
		'content: every editor and saved post verified against the same fixed script'
	);
	console.log( `traffic: ${ report.measurement.traffic }` );
	for ( const reason of report.measurement.serverCoverageLimits ) {
		console.log( `server totals unavailable: ${ reason }` );
	}
	if ( report.measurement.timeline ) {
		console.log(
			`server measurement: ${ report.measurement.timeline.method }`
		);
		console.log(
			'Memory is the peak of overlapping requests, including measurement overhead; it is not a per-phase allocation.'
		);
	}
	console.log( 'stats:' );
	if ( entry.roomSize ) {
		console.log(
			`  logical room storage: ${
				entry.roomSize.rows
			} rows, ${ Math.round( entry.roomSize.bytes / 1024 ) } KiB`
		);
	}
	const share = entry.spans.editing.server?.workerShare;
	const editShare = typeof share === 'number' ? share : share?.max;
	if ( editShare > 0 ) {
		console.log(
			`  derived capacity: ~${ ( 1 / editShare ).toFixed(
				2
			) } editors per PHP worker (estimate without queueing or spare capacity; not a tested limit)`
		);
	}

	console.log( '' );
	if ( ! env.muMeasurement ) {
		console.log(
			'baseline server columns unavailable: the whole-request ' +
				'measurement mu-plugin recorded nothing — map ' +
				'tests/benchmarks/host/mu-bench-log.php into mu-plugins ' +
				'(this repo’s wp-env configs do; restart the env once) ' +
				'and rerun'
		);
	}
	console.log(
		'caveats, method, and how to read each metric: tests/benchmarks/README.md'
	);
}

main().catch( ( error ) => {
	console.error( String( error?.message ?? error ) );
	if ( error?.stack ) {
		console.error(
			String( error.stack ).split( '\n' ).slice( 1 ).join( '\n' )
		);
	}
	process.exit( 1 );
} );
