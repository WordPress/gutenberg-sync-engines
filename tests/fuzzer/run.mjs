#!/usr/bin/env node

/**
 * RTC fuzz matrix runner — the one-command entrypoint (`npm run fuzz`).
 *
 * Sweeps the seeded browser fuzz spec (specs/collaboration-fuzz.spec.ts)
 * across every engine × transport combination:
 *
 *   1. Ensures wp-env is running (starts it if not) and derives the tests
 *      site URL from the generated compose file, so autoPort drift or a
 *      FOREIGN wp-env on :8889 cannot silently retarget the run.
 *   2. Per combo: selects the engine (`wp_sync_engine`) and transport
 *      (`gutenberg_sync_engines_transport`) on the tests site via wp-cli,
 *      empties every room (room lineage is stamped per engine;
 *      stale collection rooms 409 over websocket where healing can't run),
 *      and — for websocket combos — runs the `wp collaboration sync-server`
 *      daemon through the compose file with the port PUBLISHED and the
 *      daemon bound to 0.0.0.0 (an unpublished/loopback daemon is silently
 *      unreachable from the browser; see AGENTS.md).
 *   3. Runs the fuzz spec for the seed batch, reading results from the
 *      Playwright JSON report.
 *   4. Re-runs failing seeds once (traces on) to split REPRODUCIBLE
 *      failures from flakes, then groups failures by normalized signature.
 *   5. Restores the site's previous engine/transport and writes
 *      summary.md + summary.ndjson under the run's artifact directory.
 *
 * Usage:
 *   npm run fuzz                                  # full matrix, 5 seeds each
 *   npm run fuzz -- --seeds=20 --steps=15
 *   npm run fuzz -- --engines=yjs-server --transports=websocket
 *   npm run fuzz -- --combos=intent-log/http-polling --seed-list=42 \
 *       --trace=retain-on-failure                 # replay one seed
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath( import.meta.url );
const FUZZER_ROOT = path.dirname( __filename );
const REPO_ROOT = path.resolve( FUZZER_ROOT, '../..' );

const ENGINE_OPTION = 'wp_sync_engine';
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
const WS_PORT = Number.parseInt( process.env.RTC_FUZZ_WS_PORT || '8787', 10 );
const WS_DAEMON_CONTAINER = 'rtc-fuzz-ws-daemon';
// The DEV env's afterStart hook auto-starts its own daemon under this name
// (tests/e2e/bin/rtc-dev.mjs); it serves the DEV database but holds host
// port 8787, so websocket combos must displace it. `npm run env start` (or
// `npm run rtc:ws`) brings it back after a fuzz run.
const DEV_WS_DAEMON_CONTAINER = 'wp-sync-ws-daemon';
// The fuzzer targets the TESTS environment (a single-site wp-env: services
// are plain `cli`/`wordpress`, port from WP_ENV_PORT).
const TESTS_CONFIG = '.wp-env.tests.json';

const DEFAULT_ENGINES = [ 'intent-log', 'yjs-server', 'de-rtc' ];

/*
 * Documented engine capability gaps the fuzzer must not "rediscover"
 * (docs/engine-comparison.md): an action an engine cannot sync is dropped
 * from that engine's lanes instead of being reported as divergence.
 *
 * No engine declares a gap today. De-rtc used to declare `syncsTitle:
 * false`, but it syncs the title now — the whole entity property map rides
 * every commit (src/engines/de-rtc/doc-bridge.ts, readFlatProperties) and
 * the server merges it per property. Add an entry here only alongside the
 * doc that documents the gap.
 */
const ENGINE_CAPABILITIES = {};
const DEFAULT_TRANSPORTS = [ 'http-polling', 'sse', 'websocket' ];

const CLI_OPTIONS = {
	engines: { type: 'string' },
	transports: { type: 'string' },
	combos: { type: 'string' },
	seeds: { type: 'string' },
	'seed-start': { type: 'string' },
	'seed-list': { type: 'string' },
	steps: { type: 'string' },
	users: { type: 'string' },
	trace: { type: 'string' },
	out: { type: 'string' },
	'no-recheck': { type: 'boolean' },
	shrink: { type: 'boolean' },
	'no-faults': { type: 'boolean' },
	'no-lifecycle': { type: 'boolean' },
	'fault-rate': { type: 'string' },
	'burst-rate': { type: 'string' },
	profile: { type: 'string' },
	'no-reload': { type: 'boolean' },
	headed: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

function readArgs( argv ) {
	const { values } = parseArgs( { args: argv, options: CLI_OPTIONS } );
	if ( values.help ) {
		printUsage();
		process.exit( 0 );
	}
	const int = ( value, fallback ) =>
		undefined === value ? fallback : Number.parseInt( value, 10 );
	const list = ( value ) =>
		undefined === value ? null : value.split( ',' ).filter( Boolean );
	const combos = list( values.combos );
	return {
		combos:
			combos &&
			combos.map( ( token ) => {
				const [ engine, transport ] = token.split( '/' );
				if ( ! engine || ! transport ) {
					throw new Error(
						`--combos entries must be engine/transport, got "${ token }"`
					);
				}
				return { engine, transport };
			} ),
		engines: list( values.engines ) ?? DEFAULT_ENGINES,
		transports: list( values.transports ) ?? DEFAULT_TRANSPORTS,
		headed: Boolean( values.headed ),
		burstRate: values[ 'burst-rate' ] ?? null,
		faultRate: values[ 'fault-rate' ] ?? null,
		noFaults: Boolean( values[ 'no-faults' ] ),
		noLifecycle: Boolean( values[ 'no-lifecycle' ] ),
		noReload: Boolean( values[ 'no-reload' ] ),
		out: values.out
			? path.resolve( values.out )
			: path.join( FUZZER_ROOT, 'artifacts' ),
		profile: values.profile ?? null,
		recheck: ! values[ 'no-recheck' ],
		shrink: Boolean( values.shrink ),
		seedList: list( values[ 'seed-list' ] ),
		seedStart: int( values[ 'seed-start' ], 1 ),
		seeds: int( values.seeds, 5 ),
		steps: int( values.steps, 12 ),
		trace: values.trace ?? null,
		users: int( values.users, 2 ),
	};
}

function printUsage() {
	process.stdout.write(
		[
			'Usage: npm run fuzz -- [options]',
			'',
			'  --engines=a,b        Engines to sweep (default: intent-log,yjs-server,de-rtc)',
			'  --transports=a,b     Transports to sweep (default: http-polling,sse,websocket)',
			'  --combos=e/t,...     Explicit engine/transport pairs (overrides the cross product)',
			'  --seeds=N            Seeds per combo (default: 5)',
			'  --seed-start=N       First seed (default: 1)',
			'  --seed-list=1,2,3    Explicit seeds (overrides --seeds/--seed-start)',
			'  --steps=N            Actions per seed (default: 12)',
			'  --users=N            Collaborators; 3 adds a seeded late joiner (default: 2)',
			'  --trace=MODE         Playwright trace mode for the sweep (default: off; rechecks always retain-on-failure)',
			'  --no-recheck         Skip the failing-seed recheck pass',
			'  --shrink             Bisect each reproducible failure to a minimal --steps (one exemplar per signature; a shrunk run is seeded fresh, so only the failure signature is guaranteed to match)',
			'  --profile=NAME       Action-weighting profile: undo | concurrency (default: uniform grammar; replay with the same profile)',
			'  --no-faults          Disable sync fault injection',
			'  --no-reload          Disable mid-run and final reload milestones',
			'  --headed             Headed browsers',
			'  --out=DIR            Artifact root (default: tests/fuzzer/artifacts)',
			'',
		].join( '\n' )
	);
}

function log( message ) {
	process.stdout.write( `[fuzz] ${ message }\n` );
}

function runCommand( command, commandArgs, options = {} ) {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( command, commandArgs, {
			cwd: options.cwd || REPO_ROOT,
			env: { ...process.env, ...( options.env || {} ) },
			stdio: options.stdio || [ 'ignore', 'pipe', 'pipe' ],
		} );
		let stdout = '';
		let stderr = '';
		if ( child.stdout ) {
			child.stdout.on( 'data', ( chunk ) => {
				stdout += chunk.toString();
			} );
		}
		if ( child.stderr ) {
			child.stderr.on( 'data', ( chunk ) => {
				stderr += chunk.toString();
			} );
		}
		child.on( 'error', reject );
		child.on( 'exit', ( code ) => {
			if ( code === 0 || options.allowFailure ) {
				resolve( { code, stderr, stdout } );
				return;
			}
			reject(
				new Error(
					`${ command } ${ commandArgs.join(
						' '
					) } exited with code ${ code }\n${ stderr || stdout }`
				)
			);
		} );
	} );
}

// Set once the env is up (ensureEnv); wp-cli helpers need it.
let COMPOSE_FILE = null;

/**
 * Run wp-cli on the TESTS site through the generated compose file rather
 * than `wp-env run`: compose gives deterministic stdout (`wp-env run`
 * interleaves spinner/status lines with the command output, which breaks
 * option-value and id parsing).
 *
 * @param {string[]} wpArgs  wp-cli arguments.
 * @param {Object}   options runCommand options.
 */
function runWpCli( wpArgs, options = {} ) {
	if ( ! COMPOSE_FILE ) {
		throw new Error( 'wp-cli called before the env was resolved.' );
	}
	return runCommand(
		'docker',
		[
			'compose',
			'-f',
			COMPOSE_FILE,
			'run',
			'--rm',
			'-T',
			'cli',
			'wp',
			...wpArgs,
		],
		options
	);
}

/**
 * The wp-env work directory for this checkout, mirroring wp-env's own
 * naming (legacy md5 dir, then descriptive dir, then a compose-file scan).
 */
function wpEnvWorkDirectory() {
	// Mirror wp-env's own home derivation (get-cache-directory.js): with
	// snap installed it uses PUBLIC ~/wp-env, not ~/.wp-env — GitHub's
	// Ubuntu runners ship snapd, which is how CI ended up looking in the
	// wrong place while every macOS checkout worked.
	const home =
		process.env.WP_ENV_HOME ||
		path.join( os.homedir(), existsSync( '/snap' ) ? 'wp-env' : '.wp-env' );
	const configFilePath = path.join( REPO_ROOT, TESTS_CONFIG );
	const hash = createHash( 'md5' ).update( configFilePath ).digest( 'hex' );

	const legacy = path.join( home, hash );
	if ( existsSync( legacy ) ) {
		return legacy;
	}
	// wp-env's descriptive naming: wp-env-<project-dir>[-<variant>]-<hash8>,
	// where the variant comes from the config filename (.wp-env.tests.json
	// -> "tests").
	const descriptive = path.join(
		home,
		`wp-env-${ path.basename( REPO_ROOT ) }-tests-${ hash.slice( 0, 8 ) }`
	);
	if ( existsSync( descriptive ) ) {
		return descriptive;
	}
	const needle = `${ REPO_ROOT }:`;
	try {
		for ( const entry of readdirSync( home ) ) {
			const composeFile = path.join( home, entry, 'docker-compose.yml' );
			try {
				if ( readFileSync( composeFile, 'utf8' ).includes( needle ) ) {
					return path.join( home, entry );
				}
			} catch {
				// Not a work directory; keep scanning.
			}
		}
	} catch {
		// No wp-env home yet.
	}
	return null;
}

/**
 * The tests site port, read from the compose file's
 * `${WP_ENV_TESTS_PORT:-<port>}` mapping (autoPort bakes the chosen port
 * into the default).
 *
 * @param {string} composeFile Path to docker-compose.yml.
 */
function testsSitePort( composeFile ) {
	try {
		const match = readFileSync( composeFile, 'utf8' ).match(
			/\$\{WP_ENV_PORT:-(\d+)\}:80/
		);
		if ( match ) {
			return Number.parseInt( match[ 1 ], 10 );
		}
	} catch {
		// Fall through.
	}
	return 8889;
}

async function isEnvRunning( composeFile ) {
	try {
		const { stdout } = await runCommand( 'docker', [
			'compose',
			'-f',
			composeFile,
			'ps',
			'--services',
			'--status',
			'running',
		] );
		return stdout.split( '\n' ).includes( 'wordpress' );
	} catch {
		return false;
	}
}

async function ensureEnv() {
	let workDirectory = wpEnvWorkDirectory();
	const composeFile = workDirectory
		? path.join( workDirectory, 'docker-compose.yml' )
		: null;
	if ( composeFile && ( await isEnvRunning( composeFile ) ) ) {
		log( 'wp-env is already running.' );
	} else {
		log( 'Starting the tests wp-env (this can take a while)…' );
		await runCommand(
			'npx',
			[ 'wp-env', '--config', TESTS_CONFIG, 'start' ],
			{
				stdio: [ 'ignore', 'inherit', 'inherit' ],
			}
		);
		workDirectory = wpEnvWorkDirectory();
	}
	if ( ! workDirectory ) {
		throw new Error( 'Could not locate the wp-env work directory.' );
	}
	return workDirectory;
}

async function waitForHealth( url, timeoutMs ) {
	const deadline = Date.now() + timeoutMs;
	while ( Date.now() < deadline ) {
		try {
			const response = await fetch( url, {
				signal: AbortSignal.timeout( 2000 ),
			} );
			if ( response.ok ) {
				return true;
			}
		} catch {
			// Not up yet.
		}
		await new Promise( ( resolve ) => setTimeout( resolve, 1000 ) );
	}
	return false;
}

/**
 * Read an option from the tests site; null when unset.
 *
 * @param {string} name Option name.
 */
async function getOption( name ) {
	const result = await runWpCli( [ 'option', 'get', name ], {
		allowFailure: true,
	} );
	if ( result.code !== 0 ) {
		return null;
	}
	return result.stdout.trim() || null;
}

async function setOption( name, value ) {
	if ( value === null ) {
		await runWpCli( [ 'option', 'delete', name ], { allowFailure: true } );
		return;
	}
	await runWpCli( [ 'option', 'update', name, value ] );
}

/**
 * Turns real-time collaboration on. Since WordPress/gutenberg#80658 the
 * framework gates RTC on the `gutenberg-real-time-collaboration`
 * experiment rather than the old `wp_collaboration_enabled` option. Other
 * experiments are left alone.
 */
async function enableCollaborationExperiment() {
	await runWpCli( [
		'eval',
		"$experiments = get_option( 'gutenberg-experiments', array() ); $experiments['gutenberg-real-time-collaboration'] = true; update_option( 'gutenberg-experiments', $experiments );",
	] );
}

/**
 * Empty every room on the tests site (all update rows, lineage, and meta in
 * the plugin's storage tables). Rooms are rebuildable change-feeds; a fresh
 * combo must not inherit another engine's room lineage.
 */
async function wipeSyncRooms() {
	const { stdout } = await runWpCli( [
		'collaboration',
		'rooms',
		'list',
		'--format=count',
	] );
	const count = Number.parseInt( stdout.trim(), 10 ) || 0;
	await runWpCli( [ 'collaboration', 'storage', 'reset', '--yes' ] );
	return count;
}

/**
 * The SSE transport wakes its streams through Redis, which the tests
 * config's afterStart hook runs as a sibling container of the env
 * (`<work directory name>-redis`). Without it every tab silently
 * receives over polling, and an sse combo would certify nothing.
 *
 * @param {string} workDirectory The tests env's wp-env work directory.
 */
function assertRedisRunning( workDirectory ) {
	const container = `${ path.basename( workDirectory ) }-redis`;
	const state = spawnSync(
		'docker',
		[ 'inspect', '-f', '{{.State.Running}}', container ],
		{ encoding: 'utf8' }
	);
	if ( 0 !== state.status || 'true' !== state.stdout.trim() ) {
		throw new Error(
			`sse combos need Redis, but container ${ container } is ${
				0 === state.status ? 'stopped' : 'absent'
			} — npm run env:tests start (its afterStart hook runs npm run redis:start)`
		);
	}
}

function stopWsDaemon() {
	spawnSync( 'docker', [ 'rm', '-f', WS_DAEMON_CONTAINER ], {
		stdio: 'ignore',
	} );
}

/**
 * Frees host port 8787 for the fuzz daemon: removes a stale fuzz daemon and
 * the DEV env's auto-started daemon (which serves the dev database — wrong
 * DB for the tests site this run targets).
 */
function clearDaemonPortHolders() {
	stopWsDaemon();
	spawnSync( 'docker', [ 'rm', '-f', DEV_WS_DAEMON_CONTAINER ], {
		stdio: 'ignore',
	} );
}

/**
 * Start the plugin's PHP websocket sync daemon against the TESTS site via
 * the generated compose file. `-p` publishes the port to the host and
 * `--host=0.0.0.0` makes the daemon reachable through it; without BOTH the
 * browser's ws://localhost connection is refused and clients retry silently.
 *
 * @param {string} composeFile Path to docker-compose.yml.
 */
async function startWsDaemon( composeFile ) {
	clearDaemonPortHolders();
	const daemon = spawn(
		'docker',
		[
			'compose',
			'-f',
			composeFile,
			'run',
			'--rm',
			'--name',
			WS_DAEMON_CONTAINER,
			'-p',
			`${ WS_PORT }:${ WS_PORT }`,
			'cli',
			'wp',
			'collaboration',
			'sync-server',
			'--host=0.0.0.0',
			`--port=${ WS_PORT }`,
		],
		{ stdio: [ 'ignore', 'pipe', 'pipe' ] }
	);
	daemon.stdout.on( 'data', () => {} );
	daemon.stderr.on( 'data', () => {} );

	const healthy = await waitForHealth(
		`http://localhost:${ WS_PORT }/health`,
		45000
	);
	if ( ! healthy ) {
		stopWsDaemon();
		throw new Error(
			`websocket daemon did not answer http://localhost:${ WS_PORT }/health within 45s`
		);
	}
	return daemon;
}

/**
 * Collapse a Playwright error into a stable signature so the same root
 * cause groups across seeds: first meaningful line, ANSI stripped, marker
 * tokens and volatile numbers normalized.
 *
 * @param {string} message Raw error message.
 */
function failureSignature( message ) {
	if ( ! message ) {
		return 'unknown-failure';
	}
	// eslint-disable-next-line no-control-regex -- Stripping ANSI color codes.
	const stripped = message.replace( /\u001b\[[0-9;]*m/g, '' );
	const firstLine =
		stripped
			.split( '\n' )
			.map( ( line ) => line.trim() )
			.find( ( line ) => line.length > 0 ) || 'unknown-failure';
	return firstLine
		.replace( /f\d+s\d+u\d+-[a-z]+/g, '<marker>' )
		.replace( /\d{3,}/g, '<n>' )
		.slice( 0, 200 );
}

/**
 * Flatten the Playwright JSON report into per-seed results.
 *
 * @param {string} reportPath Path to the JSON report.
 */
async function readReport( reportPath ) {
	const report = JSON.parse( await fs.readFile( reportPath, 'utf8' ) );
	const results = [];
	const walkSuites = ( suites ) => {
		for ( const suite of suites || [] ) {
			for ( const spec of suite.specs || [] ) {
				const seedMatch = spec.title.match( /seed (\d+)/ );
				const seed = seedMatch
					? Number.parseInt( seedMatch[ 1 ], 10 )
					: null;
				for ( const specTest of spec.tests || [] ) {
					const lastResult =
						specTest.results?.[ specTest.results.length - 1 ];
					results.push( {
						error:
							lastResult?.error?.message ||
							lastResult?.errors?.[ 0 ]?.message ||
							null,
						ok: spec.ok,
						seed,
						status: lastResult?.status || 'unknown',
					} );
				}
			}
			walkSuites( suite.suites );
		}
	};
	walkSuites( report.suites );
	return results;
}

/**
 * Run the fuzz spec once for a combo + seed set.
 *
 * @param {Object}  options               Invocation options.
 * @param {Object}  options.combo         { engine, transport }.
 * @param {string}  options.baseUrl       Tests site URL.
 * @param {string}  options.comboDir      Artifact directory for this combo.
 * @param {Array}   options.seeds         Seeds to run (strings or numbers).
 * @param {Object}  options.args          Parsed CLI args.
 * @param {string}  options.phase         'sweep', 'recheck', or a shrink probe label.
 * @param {?number} options.stepsOverride Steps for this invocation (default: args.steps).
 */
async function runPlaywright( {
	combo,
	baseUrl,
	comboDir,
	seeds,
	args,
	phase,
	stepsOverride = null,
} ) {
	const reportPath = path.join( comboDir, `${ phase }-report.json` );
	const outputDir = path.join( comboDir, `${ phase }-artifacts` );
	await fs.mkdir( outputDir, { recursive: true } );

	const capabilities = ENGINE_CAPABILITIES[ combo.engine ] || {};
	const env = {
		RTC_FUZZ_ENGINE: combo.engine,
		RTC_FUZZ_JSON_REPORT: reportPath,
		RTC_FUZZ_OUTPUT_DIR: outputDir,
		RTC_FUZZ_SEEDS: seeds.join( ',' ),
		RTC_FUZZ_STEPS: String( stepsOverride ?? args.steps ),
		RTC_FUZZ_TRACE:
			phase === 'recheck' ? 'retain-on-failure' : args.trace || 'off',
		RTC_FUZZ_TRANSPORT: combo.transport,
		RTC_FUZZ_USERS: String( args.users ),
		WP_BASE_URL: baseUrl,
	};
	if ( false === capabilities.syncsTitle ) {
		env.RTC_FUZZ_SYNC_TITLE = '0';
	}
	if ( args.noFaults ) {
		env.RTC_FUZZ_DISABLE_SYNC_FAULTS = '1';
	}
	if ( args.noLifecycle ) {
		env.RTC_FUZZ_DISABLE_LIFECYCLE = '1';
	}
	if ( args.faultRate !== null ) {
		env.RTC_FUZZ_FAULT_RATE = args.faultRate;
	}
	if ( args.burstRate !== null ) {
		env.RTC_FUZZ_BURST_RATE = args.burstRate;
	}
	if ( args.noReload ) {
		env.RTC_FUZZ_DISABLE_RELOAD = '1';
	}
	if ( args.profile ) {
		env.RTC_FUZZ_PROFILE = args.profile;
	}

	const playwrightArgs = [
		'playwright',
		'test',
		'--config',
		path.join( FUZZER_ROOT, 'playwright.config.ts' ),
	];
	if ( args.headed ) {
		playwrightArgs.push( '--headed' );
	}

	await runCommand( 'npx', playwrightArgs, {
		allowFailure: true,
		env,
		stdio: [ 'ignore', 'inherit', 'inherit' ],
	} );

	if ( ! existsSync( reportPath ) ) {
		throw new Error(
			`Playwright produced no JSON report for ${ combo.engine }/${ combo.transport } (${ phase }); the harness itself failed — check the output above.`
		);
	}
	return readReport( reportPath );
}

async function main() {
	const args = readArgs( process.argv.slice( 2 ) );

	// Fail fast on missing build prerequisites. An unbuilt subtree still
	// activates as a plugin, but gutenberg.php refuses to load the
	// collaboration framework — every seed then burns its full timeout
	// waiting for an editor that will never boot, with no diagnosis.
	const prerequisites = [
		{
			relativePath: 'gutenberg/build',
			what: 'vendored Gutenberg subtree is not built',
			fix: 'cd gutenberg && npm install --ignore-scripts && npm run build',
		},
		{
			relativePath: 'build/sync-engines.js',
			what: "plugin's client bundle is not built",
			fix: 'npm run build',
		},
	];
	for ( const prerequisite of prerequisites ) {
		try {
			await fs.access(
				path.join( REPO_ROOT, prerequisite.relativePath )
			);
		} catch {
			throw new Error(
				`The ${ prerequisite.what } (missing ${ prerequisite.relativePath }). ` +
					`Run: ${ prerequisite.fix }`
			);
		}
	}

	const combos =
		args.combos ??
		args.engines.flatMap( ( engine ) =>
			args.transports.map( ( transport ) => ( { engine, transport } ) )
		);
	const seeds =
		args.seedList ??
		Array.from( { length: args.seeds }, ( _value, offset ) =>
			String( args.seedStart + offset )
		);

	const runId = new Date()
		.toISOString()
		.replace( /[:T]/g, '-' )
		.slice( 0, 17 );
	const runDir = path.join( args.out, `fuzz-${ runId }` );
	await fs.mkdir( runDir, { recursive: true } );
	log( `Run directory: ${ path.relative( REPO_ROOT, runDir ) }` );
	log(
		`Matrix: ${ combos
			.map( ( c ) => `${ c.engine }/${ c.transport }` )
			.join( ', ' ) } — ${ seeds.length } seed(s) × ${
			args.steps
		} steps × ${ args.users } users`
	);

	// The subtree's own Playwright copy must not shadow this plugin's
	// (the classic "two @playwright/test instances" failure).
	for ( const duplicate of [
		'gutenberg/node_modules/@playwright/test',
		'gutenberg/node_modules/playwright',
	] ) {
		await fs.rm( path.join( REPO_ROOT, duplicate ), {
			force: true,
			recursive: true,
		} );
	}

	const workDirectory = await ensureEnv();
	const composeFile = path.join( workDirectory, 'docker-compose.yml' );
	COMPOSE_FILE = composeFile;
	const baseUrl =
		process.env.WP_BASE_URL ||
		`http://localhost:${ testsSitePort( composeFile ) }`;
	log( `Tests site: ${ baseUrl }` );

	const restRoot = await waitForHealth( `${ baseUrl }/wp-json/`, 15000 );
	if ( ! restRoot ) {
		throw new Error( `Tests site REST root unreachable at ${ baseUrl }` );
	}

	// Remember the site's engine/transport to restore afterwards.
	const previousEngine = await getOption( ENGINE_OPTION );
	const previousTransport = await getOption( TRANSPORT_OPTION );

	const ndjsonPath = path.join( runDir, 'summary.ndjson' );
	const comboSummaries = [];
	// `${ comboKey }|${ signature }` → minimal failing step count (--shrink).
	const shrinkMap = new Map();
	let reproducibleFailures = 0;

	try {
		for ( const combo of combos ) {
			const comboKey = `${ combo.engine }/${ combo.transport }`;
			const comboDir = path.join(
				runDir,
				`${ combo.engine }--${ combo.transport }`
			);
			await fs.mkdir( comboDir, { recursive: true } );
			log( `=== ${ comboKey } ===` );

			await enableCollaborationExperiment();
			await setOption( ENGINE_OPTION, combo.engine );
			await setOption( TRANSPORT_OPTION, combo.transport );
			const wiped = await wipeSyncRooms();
			if ( wiped ) {
				log( `Emptied ${ wiped } sync-storage room(s).` );
			}

			if ( combo.transport === 'sse' ) {
				assertRedisRunning( workDirectory );
			}

			// The daemon caches options at boot: start it AFTER the engine
			// flip, per combo.
			let daemon = null;
			if ( combo.transport === 'websocket' ) {
				log( 'Starting websocket sync daemon…' );
				daemon = await startWsDaemon( composeFile );
				log( `Daemon healthy on ws://localhost:${ WS_PORT }.` );
			}

			let sweep;
			try {
				sweep = await runPlaywright( {
					args,
					baseUrl,
					combo,
					comboDir,
					phase: 'sweep',
					seeds,
				} );
			} finally {
				// Keep the daemon up for the recheck below only if the sweep
				// succeeded in producing a report.
				if ( daemon && ! args.recheck ) {
					stopWsDaemon();
					daemon = null;
				}
			}

			const failedSeeds = sweep
				.filter( ( result ) => result.status !== 'passed' )
				.map( ( result ) => result.seed )
				.filter( ( seed ) => seed !== null );

			let recheck = [];
			if ( failedSeeds.length && args.recheck ) {
				log(
					`Rechecking ${ failedSeeds.length } failing seed(s) with traces on…`
				);
				recheck = await runPlaywright( {
					args,
					baseUrl,
					combo,
					comboDir,
					phase: 'recheck',
					seeds: failedSeeds,
				} );
			}

			// Bisect one exemplar per reproduced signature down to the
			// smallest failing --steps, while this combo's engine/transport
			// (and daemon) are still configured. A shrunk run is seeded
			// fresh — fewer steps reshuffles milestone placement — so only
			// the failure signature is required to match.
			if ( args.shrink ) {
				const shrunkSignatures = new Set();
				for ( const failure of recheck.filter(
					( result ) => result.status !== 'passed'
				) ) {
					const signature = failureSignature( failure.error );
					if ( shrunkSignatures.has( signature ) ) {
						continue;
					}
					shrunkSignatures.add( signature );
					let hi = args.steps;
					let lo = 0;
					while ( hi - lo > 1 ) {
						const mid = Math.floor( ( lo + hi ) / 2 );
						log(
							`Shrinking ${ comboKey }#${ failure.seed }: trying ${ mid } step(s)…`
						);
						const probe = await runPlaywright( {
							args,
							baseUrl,
							combo,
							comboDir,
							phase: `shrink-s${ failure.seed }-${ mid }`,
							seeds: [ failure.seed ],
							stepsOverride: mid,
						} );
						const failed = probe.find(
							( result ) =>
								String( result.seed ) ===
									String( failure.seed ) &&
								result.status !== 'passed' &&
								failureSignature( result.error ) === signature
						);
						if ( failed ) {
							hi = mid;
						} else {
							lo = mid;
						}
					}
					log(
						`Shrunk ${ comboKey }#${ failure.seed } to ${ hi } step(s).`
					);
					shrinkMap.set( `${ comboKey }|${ signature }`, hi );
				}
			}

			if ( daemon ) {
				stopWsDaemon();
			}

			const recheckBySeed = new Map(
				recheck.map( ( result ) => [ result.seed, result ] )
			);
			const records = sweep.map( ( result ) => {
				const rechecked = recheckBySeed.get( result.seed );
				let verdict = 'passed';
				if ( result.status !== 'passed' ) {
					if ( ! args.recheck ) {
						verdict = 'failed';
					} else if ( rechecked?.status === 'passed' ) {
						verdict = 'flaky';
					} else {
						verdict = 'reproducible';
					}
				}
				return {
					combo: comboKey,
					engine: combo.engine,
					error: result.error,
					recheckError: rechecked?.error ?? null,
					seed: result.seed,
					signature:
						result.status !== 'passed'
							? failureSignature(
									rechecked?.error ?? result.error
							  )
							: null,
					status: result.status,
					transport: combo.transport,
					verdict,
				};
			} );

			for ( const record of records ) {
				await fs.appendFile(
					ndjsonPath,
					JSON.stringify( record ) + '\n'
				);
			}

			const passed = records.filter(
				( r ) => r.verdict === 'passed'
			).length;
			const flaky = records.filter(
				( r ) => r.verdict === 'flaky'
			).length;
			const reproducible = records.filter(
				( r ) => r.verdict === 'reproducible' || r.verdict === 'failed'
			);
			reproducibleFailures += reproducible.length;
			comboSummaries.push( {
				comboKey,
				flaky,
				passed,
				records,
				reproducible,
				total: records.length,
			} );
			log(
				`${ comboKey }: ${ passed }/${ records.length } passed, ${ flaky } flaky, ${ reproducible.length } reproducible.`
			);
		}
	} finally {
		stopWsDaemon();
		log( 'Restoring previous engine/transport settings…' );
		await setOption( ENGINE_OPTION, previousEngine ).catch( () => {} );
		await setOption( TRANSPORT_OPTION, previousTransport ).catch(
			() => {}
		);
	}

	const summaryLines = [
		'# RTC fuzz run summary',
		'',
		`- Run: \`${ path.basename( runDir ) }\``,
		`- Seeds: ${ seeds.join( ', ' ) } (${ args.steps } steps, ${
			args.users
		} users${ args.profile ? `, profile: ${ args.profile }` : '' })`,
		`- Faults: ${
			args.noFaults ? 'disabled' : 'enabled (HTTP transports)'
		}`,
		'',
		'| Combo | Passed | Flaky | Reproducible |',
		'| --- | --- | --- | --- |',
	];
	for ( const summary of comboSummaries ) {
		summaryLines.push(
			`| ${ summary.comboKey } | ${ summary.passed }/${ summary.total } | ${ summary.flaky } | ${ summary.reproducible.length } |`
		);
	}
	const signatureMap = new Map();
	for ( const summary of comboSummaries ) {
		for ( const record of summary.reproducible ) {
			const entry = signatureMap.get( record.signature ) || {
				combos: new Set(),
				example: record,
				seeds: [],
			};
			entry.combos.add( record.combo );
			entry.seeds.push( `${ record.combo }#${ record.seed }` );
			signatureMap.set( record.signature, entry );
		}
	}
	if ( signatureMap.size ) {
		summaryLines.push( '', '## Reproducible failure signatures', '' );
		for ( const [ signature, entry ] of signatureMap ) {
			const shrunkSteps = shrinkMap.get(
				`${ entry.example.combo }|${ signature }`
			);
			summaryLines.push(
				`- \`${ signature }\``,
				`  - combos: ${ [ ...entry.combos ].join( ', ' ) }`,
				`  - seeds: ${ entry.seeds.join( ', ' ) }`,
				`  - replay: \`npm run fuzz -- --combos=${
					entry.example.combo
				} --seed-list=${ entry.example.seed } --steps=${
					shrunkSteps ?? args.steps
				}${
					args.profile ? ` --profile=${ args.profile }` : ''
				} --trace=retain-on-failure\`${
					shrunkSteps ? ` (shrunk from ${ args.steps } steps)` : ''
				}`
			);
		}
	}
	summaryLines.push( '' );
	await fs.writeFile(
		path.join( runDir, 'summary.md' ),
		summaryLines.join( '\n' )
	);

	process.stdout.write( '\n' + summaryLines.join( '\n' ) + '\n' );
	log( `Artifacts: ${ path.relative( REPO_ROOT, runDir ) }` );
	process.exit( reproducibleFailures ? 1 : 0 );
}

// Ensure a stray SIGINT still removes the daemon container.
for ( const signal of [ 'SIGINT', 'SIGTERM' ] ) {
	process.on( signal, () => {
		stopWsDaemon();
		process.exit( 130 );
	} );
}

main().catch( ( error ) => {
	stopWsDaemon();
	process.stderr.write( `${ error?.stack || error }\n` );
	process.exit( 1 );
} );
