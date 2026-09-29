/**
 * Launches the plugin's REAL daemon-served transport lane for the e2e
 * suite: selects a transport on the TESTS site and runs the
 * `wp collaboration sync-server` PHP daemon in the tests env's cli
 * container with host port 8787 published (the daemon must bind 0.0.0.0 —
 * a loopback-bound or unpublished daemon is silently unreachable from the
 * browser).
 *
 * The websocket transport and the `sse-daemon` transport are both served
 * by that one daemon on that one port, so one launcher starts either:
 * `--transport=<slug>` selects which the site negotiates, and it defaults
 * to `websocket`.
 *
 * Meant to run as a Playwright webServer command: Playwright waits on the
 * daemon's own `http://localhost:8787/health` endpoint and terminates
 * this process at teardown, at which point the previous transport
 * selection is restored and the container removed. Mirrors the fuzzer's
 * daemon machinery (tests/fuzzer/run.mjs) and the `npm run rtc:ws` dev
 * flow.
 */

/**
 * External dependencies
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
	path.dirname( fileURLToPath( import.meta.url ) ),
	'../../..'
);
const TESTS_CONFIG = '.wp-env.tests.json';
const WS_PORT = 8787;
const CONTAINER = 'rtc-e2e-ws-daemon';
// Other holders of host port 8787 (the dev env's auto-started daemon
// serves the DEV database — the wrong one for this suite; a stale fuzz
// daemon may also linger).
const OTHER_PORT_HOLDERS = [ 'wp-sync-ws-daemon', 'rtc-fuzz-ws-daemon' ];
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
// Which daemon-served transport this lane runs. Both are served by the
// same daemon, so the lane differs only in the slug the site negotiates.
const TRANSPORT =
	( process.argv.find( ( arg ) => arg.startsWith( '--transport=' ) ) ?? ''
	 ).split( '=' )[ 1 ] || 'websocket';
// The pre-suite transport selection, persisted OUTSIDE this process:
// Playwright may SIGKILL webServer process groups at teardown, so the
// in-process restore below can never be the only path back. The suite's
// globalTeardown re-runs this script with --restore-only against this
// file (per-checkout name — parallel worktrees must not collide).
const STATE_FILE = path.join(
	os.tmpdir(),
	`rtc-e2e-ws-transport-${ createHash( 'md5' )
		.update( REPO_ROOT )
		.digest( 'hex' )
		.slice( 0, 8 ) }.json`
);

/**
 * The tests env's wp-env work directory (legacy md5 name, descriptive
 * name, then a compose-file scan), mirroring wp-env's own naming.
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

const workDirectory = wpEnvWorkDirectory();
if ( ! workDirectory ) {
	// eslint-disable-next-line no-console
	console.error(
		'[rtc-real-ws-daemon] tests wp-env not found — run `npm run env:tests start` first.'
	);
	process.exit( 1 );
}
const COMPOSE_FILE = path.join( workDirectory, 'docker-compose.yml' );

function wpCli( wpArgs, { allowFailure = false } = {} ) {
	const result = spawnSync(
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
		{ encoding: 'utf8' }
	);
	if ( result.status !== 0 && ! allowFailure ) {
		throw new Error(
			`wp ${ wpArgs.join( ' ' ) } failed: ${ result.stderr }`
		);
	}
	return result;
}

function removeContainers( names ) {
	for ( const name of names ) {
		spawnSync( 'docker', [ 'rm', '-f', name ], { stdio: 'ignore' } );
	}
}

/**
 * Restores the pre-suite transport selection recorded in STATE_FILE and
 * removes the daemon container. Idempotent; a missing state file means
 * a completed (or never-started) run — nothing to do.
 */
function restoreFromStateFile() {
	let state = null;
	try {
		state = JSON.parse( readFileSync( STATE_FILE, 'utf8' ) );
	} catch {
		return;
	}
	if ( null === state.previous ) {
		wpCli( [ 'option', 'delete', TRANSPORT_OPTION ], {
			allowFailure: true,
		} );
	} else {
		wpCli( [ 'option', 'update', TRANSPORT_OPTION, state.previous ], {
			allowFailure: true,
		} );
	}
	removeContainers( [ CONTAINER ] );
	rmSync( STATE_FILE, { force: true } );
	// eslint-disable-next-line no-console
	console.log(
		'[rtc-real-ws-daemon] transport restored from state file; daemon removed.'
	);
}

if ( process.argv.includes( '--restore-only' ) ) {
	restoreFromStateFile();
	process.exit( 0 );
}

// Remember and select the transport (null = option unset).
const previous = ( () => {
	const result = wpCli( [ 'option', 'get', TRANSPORT_OPTION ], {
		allowFailure: true,
	} );
	return result.status === 0 ? result.stdout.trim() || null : null;
} )();
writeFileSync( STATE_FILE, JSON.stringify( { previous } ) );
wpCli( [ 'option', 'update', TRANSPORT_OPTION, TRANSPORT ] );
// eslint-disable-next-line no-console
console.log(
	`[rtc-real-ws-daemon] transport → ${ TRANSPORT } (was ${ previous ?? 'unset' })`
);

/*
 * Turn real-time collaboration on before starting the daemon. Playwright
 * starts webServers BEFORE global setup, so the suite's own
 * setCollaboration has not run yet — and `wp collaboration sync-server`
 * refuses to start when collaboration is off. Since
 * WordPress/gutenberg#80658 that means the
 * `gutenberg-real-time-collaboration` experiment; other experiments are
 * left alone. Global setup enables it again, harmlessly.
 */
wpCli( [
	'eval',
	"$experiments = get_option( 'gutenberg-experiments', array() ); $experiments['gutenberg-real-time-collaboration'] = true; update_option( 'gutenberg-experiments', $experiments );",
] );
// eslint-disable-next-line no-console
console.log( '[rtc-real-ws-daemon] collaboration experiment enabled' );

let restored = false;
function restore() {
	if ( restored ) {
		return;
	}
	restored = true;
	try {
		if ( null === previous ) {
			wpCli( [ 'option', 'delete', TRANSPORT_OPTION ], {
				allowFailure: true,
			} );
		} else {
			wpCli( [ 'option', 'update', TRANSPORT_OPTION, previous ], {
				allowFailure: true,
			} );
		}
	} finally {
		removeContainers( [ CONTAINER ] );
		rmSync( STATE_FILE, { force: true } );
	}
	// eslint-disable-next-line no-console
	console.log( '[rtc-real-ws-daemon] transport restored; daemon removed.' );
}

removeContainers( [ CONTAINER, ...OTHER_PORT_HOLDERS ] );

const daemon = spawn(
	'docker',
	[
		'compose',
		'-f',
		COMPOSE_FILE,
		'run',
		'--rm',
		'--name',
		CONTAINER,
		'-p',
		`${ WS_PORT }:${ WS_PORT }`,
		'cli',
		'wp',
		'collaboration',
		'sync-server',
		'--host=0.0.0.0',
		`--port=${ WS_PORT }`,
	],
	{ stdio: [ 'ignore', 'inherit', 'inherit' ] }
);

daemon.on( 'exit', ( code ) => {
	restore();
	process.exit( code ?? 0 );
} );
for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {
	process.on( signal, () => {
		restore();
		daemon.kill( 'SIGTERM' );
		// docker compose run needs a moment; the container rm in restore()
		// is the backstop.
		setTimeout( () => process.exit( 0 ), 2000 );
	} );
}
process.on( 'exit', restore );
