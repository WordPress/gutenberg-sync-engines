/**
 * The host benchmark's result line: one JSON object per run, appended to
 * a results file (one object per line). It is the format every reader
 * shares — the printed tables, the CSV export, the chart page, and a
 * future comparison against a saved reference — so its names and units
 * are a contract: add metrics freely, but never rename one or change its
 * unit without bumping RECORD_FORMAT.
 *
 * A line has four parts:
 *
 *   run          id, plan, repeat, start time, duration
 *   setup        every variable the run was given (engine, people, post
 *                size, …) — what a chart's axes and filters read
 *   environment  where it ran: plugin commit, Gutenberg pin, PHP, WP,
 *                MySQL, machine, local or CI
 *   results      a flat list of { phase, side, metric, value, unit, kind },
 *                plus { min, max } when the value is a range (server
 *                costs split across phase edges by request timelines;
 *                value is then the midpoint)
 *
 * `side` is `baseline` (the same work with the plugin deactivated) or
 * `sync` (collaborating live); the difference is left to readers.
 * `kind` says what a number depends on: `counted` numbers are decided by
 * what the software does (requests, queries, bytes, memory), `timed`
 * numbers also depend on how fast the machine is (CPU time, worker
 * time). Only counted numbers can be compared across machines.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORD_FORMAT = 'host-benchmark/1';

const REPO_ROOT = path.resolve(
	path.dirname( fileURLToPath( import.meta.url ) ),
	'../../..'
);

/**
 * Every metric a result line can carry. `from` reads the value out of one
 * side of a span summary (see summarize() in host-benchmark.mjs); `per`
 * says which spans it applies to.
 */
export const METRICS = [
	{
		metric: 'requests_per_person_min',
		unit: 'requests/person-min',
		kind: 'counted',
		from: ( s ) => s.client?.requestsPerMinute,
	},
	{
		metric: 'payload_kib_per_person_min',
		unit: 'KiB/person-min',
		kind: 'counted',
		from: ( s ) => s.client?.kbPerMinute,
	},
	{
		metric: 'ws_frames_per_person_min',
		unit: 'frames/person-min',
		kind: 'counted',
		from: ( s ) => s.client?.wsFramesPerMinute,
	},
	{
		metric: 'editor_longest_task_ms',
		unit: 'ms',
		kind: 'timed',
		from: ( s ) => s.client?.longestTaskMs,
	},
	{
		metric: 'editor_long_task_ms_per_person_min',
		unit: 'ms/person-min',
		kind: 'timed',
		from: ( s ) => s.client?.longTaskMsPerMinute,
	},
	{
		metric: 'php_requests_per_person_min',
		unit: 'requests/person-min',
		kind: 'counted',
		from: ( s ) => s.server?.requestsPerMinute,
	},
	{
		metric: 'php_cpu_ms_per_person_min',
		unit: 'ms/person-min',
		kind: 'timed',
		from: ( s ) => s.server?.cpuMsPerMinute,
	},
	{
		metric: 'php_worker_share_per_person',
		unit: 'workers/person',
		kind: 'timed',
		from: ( s ) => s.server?.workerShare,
	},
	{
		metric: 'db_queries_per_person_min',
		unit: 'queries/person-min',
		kind: 'counted',
		from: ( s ) => s.server?.dbQueriesPerMinute,
	},
	{
		metric: 'db_queries_per_php_request',
		unit: 'queries/request',
		kind: 'counted',
		from: ( s ) => {
			const queries = s.server?.dbQueriesPerMinute;
			const requests = s.server?.requestsPerMinute;
			if ( ! requests || null === queries || undefined === queries ) {
				return null;
			}
			return 'object' === typeof queries
				? { min: queries.min / requests, max: queries.max / requests }
				: queries / requests;
		},
	},
	{
		metric: 'option_writes_per_person_min',
		unit: 'writes/person-min',
		kind: 'counted',
		from: ( s ) => s.server?.optionWritesPerMinute,
	},
	{
		metric: 'php_peak_memory_mib',
		unit: 'MiB',
		kind: 'counted',
		spans: [ 'editing' ],
		from: ( s ) => s.server?.peakMemoryMaxMb,
	},
	{
		metric: 'db_fsyncs_per_person_min',
		unit: 'fsyncs/person-min',
		kind: 'counted',
		from: ( s ) => s.io?.fsyncsPerMinute,
	},
];

/**
 * Whole-job metrics: the cost of producing the final document once,
 * summed over the editing spans (saves included, idle excluded).
 */
export const JOB_METRICS = [
	{
		metric: 'requests',
		unit: 'requests',
		kind: 'counted',
		from: ( j ) => j.requests,
	},
	{
		metric: 'payload_kib',
		unit: 'KiB',
		kind: 'counted',
		from: ( j ) => j.kb,
	},
	{
		metric: 'php_cpu_s',
		unit: 's',
		kind: 'timed',
		from: ( j ) => j.serverCpuS,
	},
	{
		metric: 'payload_bytes_per_word',
		unit: 'bytes/word',
		kind: 'counted',
		from: ( j ) => ( j.tokens ? ( j.kb * 1024 ) / j.tokens : null ),
	},
	{
		metric: 'requests_per_word',
		unit: 'requests/word',
		kind: 'counted',
		from: ( j ) => ( j.tokens ? j.requests / j.tokens : null ),
	},
];

/**
 * Flattens one span summary pair (baseline + sync) into result rows.
 *
 * @param {string} phase   'editing' or 'idle'.
 * @param {Object} summary { client, baseClient, server, baseServer, io, baseIo }.
 * @return {Array<Object>} Result rows (null values left out).
 */
export function spanResults( phase, summary ) {
	const sides = {
		baseline: {
			client: summary.baseClient,
			server: summary.baseServer,
			io: summary.baseIo,
		},
		sync: {
			client: summary.client,
			server: summary.server,
			io: summary.io,
		},
	};
	const rows = [];
	for ( const definition of METRICS ) {
		if ( definition.spans && ! definition.spans.includes( phase ) ) {
			continue;
		}
		for ( const [ side, values ] of Object.entries( sides ) ) {
			pushRow( rows, phase, side, definition, definition.from( values ) );
		}
	}
	return rows;
}

function pushRow( rows, phase, side, definition, value ) {
	const round = ( number ) => Math.round( number * 1e6 ) / 1e6;
	// A range { min, max } is recorded as its midpoint, with its bounds.
	const range =
		value && 'object' === typeof value
			? { min: value.min, max: value.max }
			: null;
	const point = range ? ( range.min + range.max ) / 2 : value;
	if ( null === point || undefined === point || ! Number.isFinite( point ) ) {
		return;
	}
	rows.push( {
		phase,
		side,
		metric: definition.metric,
		value: round( point ),
		unit: definition.unit,
		kind: definition.kind,
		...( range && range.min !== range.max
			? { min: round( range.min ), max: round( range.max ) }
			: {} ),
	} );
}

/**
 * Edit delivery: how long a typed word takes to reach the other editors'
 * data, from the session report (sync side only; nobody receives edits
 * in the plugin-off phase).
 */
export const DELIVERY_METRICS = [
	{
		metric: 'delivery_p50_ms',
		unit: 'ms',
		kind: 'timed',
		from: ( d ) => d?.latencyMs?.p50,
	},
	{
		metric: 'delivery_p95_ms',
		unit: 'ms',
		kind: 'timed',
		from: ( d ) => d?.latencyMs?.p95,
	},
	{
		metric: 'delivery_max_ms',
		unit: 'ms',
		kind: 'timed',
		from: ( d ) => d?.latencyMs?.max,
	},
	{
		metric: 'typing_lag_max_ms',
		unit: 'ms',
		kind: 'timed',
		from: ( d ) => d?.scheduleLagMs?.max,
	},
];

/**
 * Builds the result rows for a whole run.
 *
 * @param {Object}      engine   The report's engine entry ({ spans, job }).
 * @param {Object|null} roomSize Room storage at rest ({ rows, bytes }).
 * @param {boolean}     withIdle Whether an idle span was measured.
 * @param {Object|null} delivery The session's delivery measurements.
 * @return {Array<Object>} Result rows.
 */
export function resultsOf( engine, roomSize, withIdle, delivery = null ) {
	const rows = [ ...spanResults( 'editing', engine.spans.editing ) ];
	if ( withIdle ) {
		rows.push( ...spanResults( 'idle', engine.spans.idle ) );
	}
	for ( const definition of JOB_METRICS ) {
		pushRow(
			rows,
			'job',
			'baseline',
			definition,
			definition.from( engine.job.base )
		);
		pushRow(
			rows,
			'job',
			'sync',
			definition,
			definition.from( engine.job.sync )
		);
	}
	for ( const definition of DELIVERY_METRICS ) {
		pushRow(
			rows,
			'editing',
			'sync',
			definition,
			definition.from( delivery )
		);
	}
	if ( roomSize ) {
		pushRow(
			rows,
			'job',
			'sync',
			{ metric: 'room_rows', unit: 'rows', kind: 'counted' },
			roomSize.rows
		);
		pushRow(
			rows,
			'job',
			'sync',
			{ metric: 'room_kib', unit: 'KiB', kind: 'counted' },
			roomSize.bytes / 1024
		);
	}
	return rows;
}

/**
 * Runs git in the repo; null when git is unavailable.
 *
 * @param {Array<string>} args Git arguments.
 * @return {string|null} Trimmed output.
 */
function git( args ) {
	try {
		return execFileSync( 'git', args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'ignore' ],
		} ).trim();
	} catch {
		return null;
	}
}

/**
 * Where a run happens: code versions and machine. The server half (PHP,
 * WP, MySQL) comes from the site's rtc-test/v1/env answer.
 *
 * @param {Object|null} server Server environment, or null.
 * @return {Object} Environment.
 */
export function runEnvironment( server ) {
	let gutenbergPin = null;
	try {
		gutenbergPin = JSON.parse(
			fs.readFileSync(
				path.join( REPO_ROOT, 'gutenberg-pin.json' ),
				'utf8'
			)
		).commit;
	} catch {
		// Not a checkout with a pin.
	}
	const cpus = os.cpus();
	return {
		pluginCommit: git( [ 'rev-parse', 'HEAD' ] ),
		// Uncommitted changes make the commit an incomplete description.
		pluginDirty: Boolean( git( [ 'status', '--porcelain' ] ) ),
		gutenbergPin,
		php: server?.php_version ?? null,
		wp: server?.wp_version ?? null,
		mysql: server?.mysql_version ?? null,
		runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
		machine: {
			os: `${ os.platform() } ${ os.release() }`,
			arch: os.arch(),
			cpus: cpus.length,
			cpuModel: cpus[ 0 ]?.model ?? null,
			memoryGiB: Math.round( os.totalmem() / 1073741824 ),
		},
	};
}

/**
 * A stable text form of an object (keys sorted at every depth), so the
 * same setup always produces the same key and hash.
 *
 * @param {*} value Value.
 * @return {string} Canonical JSON.
 */
export function canonical( value ) {
	if ( Array.isArray( value ) ) {
		return `[${ value.map( canonical ).join( ',' ) }]`;
	}
	if ( value && 'object' === typeof value ) {
		return `{${ Object.keys( value )
			.sort()
			.filter( ( key ) => undefined !== value[ key ] )
			.map(
				( key ) =>
					`${ JSON.stringify( key ) }:${ canonical( value[ key ] ) }`
			)
			.join( ',' ) }}`;
	}
	return JSON.stringify( value ?? null );
}

/**
 * Short hash of a canonical value.
 *
 * @param {*} value Value.
 * @return {string} 12 hex characters.
 */
export function shortHash( value ) {
	return createHash( 'sha1' )
		.update( canonical( value ) )
		.digest( 'hex' )
		.slice( 0, 12 );
}

/**
 * What a plugin-off (baseline) phase depends on. Two runs with the same
 * key would measure the same thing, so the second one may reuse the
 * first one's measurement. Engine, transport, and polling interval are
 * absent on purpose: the plugin is deactivated during the baseline.
 * The repeat number is part of the key, so repeats keep independent
 * baselines and the spread still includes baseline noise.
 *
 * @param {Object} setup       Run setup.
 * @param {Object} environment runEnvironment() result.
 * @param {string} baseUrl     Site measured.
 * @param {number} repeat      Repeat number (1-based).
 * @return {Object} Key.
 */
export function baselineKey( setup, environment, baseUrl, repeat ) {
	return {
		format: RECORD_FORMAT,
		baseUrl,
		windows: setup.windows,
		postSize: setup.postSize,
		postHash: setup.postHash,
		pattern: setup.pattern,
		editSeconds: setup.editSeconds,
		idleSeconds: setup.idleSeconds,
		cache: setup.cache,
		pluginCommit: environment.pluginCommit,
		pluginDirty: environment.pluginDirty,
		php: environment.php,
		wp: environment.wp,
		mysql: environment.mysql,
		repeat,
	};
}

/**
 * Parses bare key=value arguments (leading dashes allowed), for the
 * small command-line readers that take only a few.
 *
 * @param {Array<string>} argv Arguments.
 * @return {Object} Options.
 */
export function cliOptions( argv = process.argv.slice( 2 ) ) {
	return Object.fromEntries(
		argv.map( ( token ) => {
			const bare = token.replace( /^--?/, '' );
			const eq = bare.indexOf( '=' );
			return -1 === eq
				? [ bare, true ]
				: [ bare.slice( 0, eq ), bare.slice( eq + 1 ) ];
		} )
	);
}

/**
 * A small seeded random number generator (a linear congruential one):
 * the same seed always gives the same sequence.
 *
 * @param {number} seed Seed.
 * @return {Function} Returns numbers in [0, 1).
 */
export function seededRandom( seed ) {
	const M = 2147483648;
	let state = ( ( Math.floor( seed ) % M ) + M ) % M;
	return () => {
		state = ( ( ( Math.imul( state, 1103515245 ) + 12345 ) % M ) + M ) % M;
		return state / M;
	};
}

/**
 * Appends one result line to a results file (creating its directory).
 *
 * @param {string} file   Results file path.
 * @param {Object} record Result line.
 */
export function appendRecord( file, record ) {
	fs.mkdirSync( path.dirname( path.resolve( file ) ), { recursive: true } );
	fs.appendFileSync( file, JSON.stringify( record ) + '\n' );
}

/**
 * Reads every result line from a results file. A line that does not
 * parse (a run killed mid-write) is skipped with a warning.
 *
 * @param {string} file Results file path.
 * @return {Array<Object>} Result lines.
 */
export function readRecords( file ) {
	if ( ! fs.existsSync( file ) ) {
		return [];
	}
	const records = [];
	fs.readFileSync( file, 'utf8' )
		.split( '\n' )
		.forEach( ( line, index ) => {
			if ( ! line.trim() ) {
				return;
			}
			try {
				records.push( JSON.parse( line ) );
			} catch {
				console.warn(
					`${ file }:${ index + 1 }: skipped an unreadable line`
				);
			}
		} );
	return records;
}
