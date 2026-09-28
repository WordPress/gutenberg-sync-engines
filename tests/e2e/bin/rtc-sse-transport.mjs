/**
 * Selects the SSE transport on the TESTS site for the sse-only e2e suite
 * and restores the previous selection afterwards.
 *
 *   --select        remember the current transport, require the tests
 *                   env's Redis container, select `sse`
 *   --restore-only  put the remembered transport back (idempotent)
 *
 * The suite's global setup runs --select after the default setup, and
 * its global teardown runs --restore-only. The previous selection is
 * persisted OUTSIDE the process (a per-checkout state file), so an
 * aborted run can still be restored by the next one. Mirrors the
 * websocket lane's launcher (rtc-real-ws-daemon.mjs) without a daemon:
 * SSE runs on ordinary PHP requests, woken by Redis.
 */

/**
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
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
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
const STATE_FILE = path.join(
	os.tmpdir(),
	`rtc-e2e-sse-transport-${ createHash( 'md5' )
		.update( REPO_ROOT )
		.digest( 'hex' )
		.slice( 0, 8 ) }.json`
);

/**
 * The tests env's wp-env work directory (legacy md5 name, descriptive
 * name, then a compose-file scan), mirroring wp-env's own naming.
 */
function wpEnvWorkDirectory() {
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
		'[rtc-sse-transport] tests wp-env not found — run `npm run env:tests start` first.'
	);
	process.exit( 1 );
}
const COMPOSE_FILE = path.join( workDirectory, 'docker-compose.yml' );
// The tests config's afterStart hook runs Redis as a sibling container
// named after the work directory (see the redis:start script).
const REDIS_CONTAINER = `${ path.basename( workDirectory ) }-redis`;

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
	rmSync( STATE_FILE, { force: true } );
	// eslint-disable-next-line no-console
	console.log(
		`[rtc-sse-transport] transport restored (${
			state.previous ?? 'unset'
		}).`
	);
}

if ( process.argv.includes( '--restore-only' ) ) {
	restoreFromStateFile();
	process.exit( 0 );
}

// A leftover state file means an aborted run: put its selection back
// first so "previous" below is the real pre-suite value.
restoreFromStateFile();

const redisState = spawnSync(
	'docker',
	[ 'inspect', '-f', '{{.State.Running}}', REDIS_CONTAINER ],
	{ encoding: 'utf8' }
);
if ( 0 !== redisState.status || 'true' !== redisState.stdout.trim() ) {
	// eslint-disable-next-line no-console
	console.error(
		`[rtc-sse-transport] Redis container ${ REDIS_CONTAINER } is ${
			0 === redisState.status ? 'stopped' : 'absent'
		}; without it every tab receives over polling and this suite certifies nothing. ` +
			'Run `npm run env:tests start` (its afterStart hook runs `npm run redis:start`).'
	);
	process.exit( 1 );
}

const previous = ( () => {
	const result = wpCli( [ 'option', 'get', TRANSPORT_OPTION ], {
		allowFailure: true,
	} );
	return result.status === 0 ? result.stdout.trim() || null : null;
} )();
writeFileSync( STATE_FILE, JSON.stringify( { previous } ) );
wpCli( [ 'option', 'update', TRANSPORT_OPTION, 'sse' ] );
// eslint-disable-next-line no-console
console.log(
	`[rtc-sse-transport] transport → sse (was ${
		previous ?? 'unset'
	}); Redis ${ REDIS_CONTAINER } running.`
);
