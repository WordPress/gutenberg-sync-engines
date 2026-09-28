#!/usr/bin/env node

/**
 * Local RTC transport switcher.
 *
 * Modes, selected by --mode=<websockets|daemon|http|doctor|cache>:
 *
 *   cache: --on copies the Redis Object Cache drop-in in (a persistent
 *   object cache on the env's sync-redis container, through the plugin's
 *   bundled Predis client — no PHP extension), --off removes it; --tests
 *   targets the tests env. With the drop-in on, the SSE transport detects
 *   Redis by itself and the room storage keeps presence in the cache.
 *
 *   websockets: one-command start for the real websocket transport. Ensures
 *   wp-env is running, points the site at the websocket transport, and runs
 *   the `wp collaboration sync-server` PHP daemon inside the wp-env cli
 *   container with its port published to the host (wp-env alone cannot
 *   publish extra container ports, and the daemon must bind 0.0.0.0 for the
 *   published port to reach it — a loopback-bound daemon is unreachable even
 *   through a published port). Open two browser windows on the dev site and
 *   edit the same post to collaborate over the socket.
 *
 *   daemon: run the daemon WITHOUT changing what the site has selected — no
 *   transport or collaboration option is touched (the plugin-copy fixup
 *   still runs; the daemon command cannot exist without it). This is the
 *   mode `.wp-env.json` runs (detached) from its afterStart lifecycle
 *   script, so the daemon is always available after `wp-env start` while
 *   the site's transport choice stays whatever it was. A daemon serving a
 *   site that has HTTP polling selected is idle and harmless.
 *
 *   http: switch the site back to the HTTP polling transport and stop the
 *   daemon (if running).
 *
 * --detach starts the daemon container in the background and exits once it
 * answers its health check, instead of staying attached. The daemon binds
 * host port 8787 under a fixed container name, so across multiple wp-env
 * checkouts (worktrees) the most recently started environment owns it.
 *
 * (In the lifecycle script, `|| true` keeps a daemon failure — e.g. an
 * unbuilt subtree — from failing `wp-env start` itself; the diagnosis
 * still prints.)
 *
 * The serverless peer-relay test WebSocket provider this script used to
 * manage is only useful to client-merging engines; since the yjs-relay
 * engine was removed, both remaining engines are server-authoritative and
 * the relay demonstrates nothing. The e2e websocket suite manages that
 * fixture itself (tests/e2e/config/rtc-websocket-setup.ts); this script now
 * deactivates the fixture plugin in both modes so it never shadows the real
 * transport.
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const REPO_ROOT = process.cwd();
const TEST_PROVIDER_PLUGIN_SLUG =
	'sync-engines-test-plugins/rtc-websocket-provider';
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
const ADVISORY_OPTION = 'gutenberg_sync_engines_advisory_channel';
const DAEMON_CONTAINER_NAME = 'wp-sync-ws-daemon';

const { values: CLI } = parseArgs( {
	options: {
		mode: { type: 'string', default: 'websockets' },
		port: { type: 'string' },
		detach: { type: 'boolean', default: false },
		on: { type: 'boolean', default: false },
		off: { type: 'boolean', default: false },
		tests: { type: 'boolean', default: false },
	},
} );

const DEFAULT_PORT = 8787;
const WS_PORT = Number.parseInt(
	CLI.port || process.env.WP_SYNC_WEBSOCKET_PORT || '',
	10
);
// The announced socket URL (ws://<WP_SYNC_WEBSOCKET_HOST>:<WP_SYNC_WEBSOCKET_PORT>)
// comes from wp-config constants, so a non-default port here must be
// matched by WP_SYNC_WEBSOCKET_PORT in .wp-env.json's config.
const PORT = Number.isNaN( WS_PORT ) ? DEFAULT_PORT : WS_PORT;

function parseMode() {
	const mode = CLI.mode;
	if (
		! [ 'websockets', 'daemon', 'http', 'doctor', 'cache' ].includes( mode )
	) {
		throw new Error(
			`Unknown --mode=${ mode }. Expected "websockets", "daemon", "http", "doctor", or "cache".`
		);
	}
	return mode;
}

function runCommand( command, args, options = {} ) {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( command, args, {
			cwd: REPO_ROOT,
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
			if ( code === 0 ) {
				resolve( stdout );
				return;
			}
			reject(
				new Error(
					`${ command } ${ args.join(
						' '
					) } exited with code ${ code }\n${ stderr }`
				)
			);
		} );
	} );
}

function runWpCli( wpArgs, { allowFailure = false, configFile = null } = {} ) {
	const promise = runCommand( 'npx', [
		'wp-env',
		...( configFile ? [ '--config', configFile ] : [] ),
		'run',
		'cli',
		'wp',
		...wpArgs,
	] );
	if ( ! allowFailure ) {
		return promise;
	}
	return promise.catch( () => undefined );
}

/**
 * Turns real-time collaboration on. Since WordPress/gutenberg#80658 the
 * framework gates RTC on the `gutenberg-real-time-collaboration`
 * experiment rather than the old `wp_collaboration_enabled` option (which
 * Gutenberg now deletes on upgrade). Other experiments are left alone.
 */
/**
 * Whether the site runs a persistent object cache (the drop-in loaded).
 *
 * @param {Object}      options            Options.
 * @param {string|null} options.configFile wp-env config (null: dev).
 * @return {Promise<boolean|null>} True/false, or null when wp-cli failed.
 */
async function hasPersistentObjectCache( { configFile = null } = {} ) {
	const out = await runWpCli(
		[ 'eval', 'echo (int) wp_using_ext_object_cache();' ],
		{ configFile, allowFailure: true }
	);
	return undefined === out ? null : '1' === out.trim();
}

/**
 * cache mode: put the Redis Object Cache drop-in in or take it out.
 */
async function cacheMode() {
	if ( CLI.on === CLI.off ) {
		throw new Error( '--mode=cache needs exactly one of --on or --off.' );
	}
	const configFile = CLI.tests ? '.wp-env.tests.json' : null;
	const label = CLI.tests ? 'tests env' : 'dev env';
	if ( CLI.on ) {
		// The plugin ships the drop-in; wp redis enable copies it in.
		await runWpCli( [ 'plugin', 'activate', 'redis-cache' ], {
			configFile,
			allowFailure: true,
		} );
	}
	await runWpCli( [ 'redis', CLI.on ? 'enable' : 'disable' ], {
		configFile,
		allowFailure: true,
	} );
	const state = await hasPersistentObjectCache( { configFile } );
	if ( state !== CLI.on ) {
		throw new Error(
			`${ label }: the drop-in is ${
				state ? 'still on' : 'not on'
			} after wp redis ${
				CLI.on ? 'enable' : 'disable'
			} — is the redis-cache plugin installed (listed in the wp-env config) and Redis running (npm run doctor)?`
		);
	}
	process.stdout.write(
		`${ label }: Redis object cache drop-in ${
			CLI.on
				? 'ON — a persistent object cache on sync-redis; the SSE transport now detects Redis by itself'
				: 'OFF — no persistent object cache'
		}.\n`
	);
}

async function enableCollaborationExperiment( { configFile = null } = {} ) {
	process.stdout.write( 'Enabling collaboration experiment... ' );
	await runWpCli(
		[
			'eval',
			"$experiments = get_option( 'gutenberg-experiments', array() ); $experiments['gutenberg-real-time-collaboration'] = true; update_option( 'gutenberg-experiments', $experiments );",
		],
		{ configFile }
	);
	process.stdout.write( 'done\n' );
}

/**
 * The wp-env work directory for this checkout, mirroring wp-env's own
 * naming: the legacy md5( config file path ) directory when it exists,
 * else `wp-env-<project-dir>[-<variant>]-<md5 short hash>` (the variant
 * comes from the config filename: .wp-env.tests.json → `tests`).
 *
 * @param {string} configBasename Config filename (default: .wp-env.json).
 * @return {string} Absolute path to the work directory.
 */
function wpEnvWorkDirectory( configBasename = '.wp-env.json' ) {
	// Mirror wp-env's own home derivation (get-cache-directory.js): with
	// snap installed it uses PUBLIC ~/wp-env, not ~/.wp-env — GitHub's
	// Ubuntu runners ship snapd, which is how CI ended up looking in the
	// wrong place while every macOS checkout worked.
	const home =
		process.env.WP_ENV_HOME ||
		path.join( os.homedir(), existsSync( '/snap' ) ? 'wp-env' : '.wp-env' );
	const configFilePath = path.join( REPO_ROOT, configBasename );
	const hash = createHash( 'md5' ).update( configFilePath ).digest( 'hex' );

	const legacy = path.join( home, hash );
	if ( existsSync( legacy ) ) {
		return legacy;
	}

	const variant = configBasename
		.replace( /^\.wp-env\.?/, '' )
		.replace( /\.?json$/, '' );
	const descriptive = path.join(
		home,
		`wp-env-${ path.basename( REPO_ROOT ) }${
			variant ? `-${ variant }` : ''
		}-${ hash.slice( 0, 8 ) }`
	);
	if ( existsSync( descriptive ) ) {
		return descriptive;
	}

	if ( '.wp-env.json' === configBasename ) {
		// Last resort (renamed checkout, older wp-env): scan for the compose
		// file that mounts this checkout as the plugin. The TESTS config
		// mounts the same plugin, so its work dir would also match — skip
		// the `-tests-` variant or a stopped dev env reads as running on
		// the tests site's port.
		const needle = `${ REPO_ROOT }:/var/www/html/wp-content/plugins/gutenberg-sync-engines`;
		for ( const entry of readdirSync( home ) ) {
			if ( entry.includes( '-tests-' ) ) {
				continue;
			}
			const composeFile = path.join( home, entry, 'docker-compose.yml' );
			try {
				if ( readFileSync( composeFile, 'utf8' ).includes( needle ) ) {
					return path.join( home, entry );
				}
			} catch {
				// Not a work directory; keep scanning.
			}
		}
	}

	throw new Error(
		`Could not find the wp-env work directory for ${ REPO_ROOT } (${ configBasename }) under ${ home }. Has wp-env ever started here?`
	);
}

/**
 * The dev site port, read from the compose file's `${WP_ENV_PORT:-<port>}`
 * mapping (autoPort bakes the chosen port into the default).
 *
 * @param {string} composeFile Path to docker-compose.yml.
 * @return {number} Dev site port.
 */
function devSitePort( composeFile ) {
	try {
		const match = readFileSync( composeFile, 'utf8' ).match(
			/\$\{WP_ENV_PORT:-(\d+)\}:80/
		);
		if ( match ) {
			return Number.parseInt( match[ 1 ], 10 );
		}
	} catch {
		// Fall through to the default.
	}
	return 8888;
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
 * Whether the wp-env WordPress service is already running (so a slow —
 * and, with autoPort, potentially port-shuffling — `wp-env start` can be
 * skipped).
 *
 * @param {string} composeFile Path to docker-compose.yml.
 * @return {Promise<boolean>} True when the dev site container is running.
 */
async function isEnvRunning( composeFile ) {
	try {
		const services = await runCommand( 'docker', [
			'compose',
			'-f',
			composeFile,
			'ps',
			'--services',
			'--status',
			'running',
		] );
		return services.split( '\n' ).includes( 'wordpress' );
	} catch {
		return false;
	}
}

/**
 * Verifies the pieces the daemon needs and activates the right plugins,
 * failing with a diagnosis instead of wp-cli's opaque "'collaboration' is
 * not a registered wp command".
 *
 * The framework only exists when the vendored Gutenberg subtree is BUILT
 * (an unbuilt gutenberg.php bails before loading lib/, so the plugin goes
 * dormant), and in a git worktree wp-env mounts this plugin twice — under
 * the checkout's directory name (the plugins-list entry) AND as
 * gutenberg-sync-engines (the mapping). Activating a second copy while one
 * is active is a fatal redeclare, and `wp-env start` re-activates the
 * plugins-list copy on EVERY start — so the only steady state that
 * survives a restart is: directory-name copy active, mapping copy
 * inactive. Keep exactly one copy active, preferring that one.
 */
async function ensurePluginsReady() {
	if ( ! existsSync( path.join( REPO_ROOT, 'gutenberg/build' ) ) ) {
		throw new Error(
			'The vendored Gutenberg subtree is not built, so the collaboration framework cannot load.\n' +
				'Run: cd gutenberg && npm install --ignore-scripts && npm run build'
		);
	}
	if ( ! existsSync( path.join( REPO_ROOT, 'build/sync-engines.js' ) ) ) {
		throw new Error(
			"The plugin's client bundle is not built, so the editor has no engines or transports.\n" +
				'Run: npm run build'
		);
	}

	// The Gutenberg framework loads from this plugin's BUNDLED copy (the
	// subtree is no longer mounted as its own plugin), so only this plugin
	// needs activating.
	process.stdout.write( 'Activating plugins... ' );
	const plugins = JSON.parse(
		await runWpCli( [
			'plugin',
			'list',
			'--fields=name,status,file',
			'--format=json',
		] )
	);
	const copies = plugins.filter( ( plugin ) =>
		plugin.file.endsWith( '/gutenberg-sync-engines.php' )
	);
	const keep =
		copies.find( ( p ) => p.name === path.basename( REPO_ROOT ) ) ||
		copies.find( ( p ) => p.name === 'gutenberg-sync-engines' ) ||
		copies[ 0 ];
	if ( ! keep ) {
		throw new Error(
			'The gutenberg-sync-engines plugin is not installed in this wp-env.'
		);
	}
	for ( const plugin of copies ) {
		if ( plugin !== keep && 'active' === plugin.status ) {
			await runWpCli( [ 'plugin', 'deactivate', plugin.name ] );
		}
	}
	if ( 'active' !== keep.status ) {
		await runWpCli( [ 'plugin', 'activate', keep.name ] );
	}
	process.stdout.write( 'done\n' );

	try {
		await runWpCli( [ 'cli', 'has-command', 'collaboration sync-server' ] );
	} catch {
		throw new Error(
			'The `wp collaboration sync-server` command is still not registered even with the plugins active.\n' +
				'Check `wp plugin list` and PHP notices on the dev site.'
		);
	}
}

async function runWebSocketsMode( mode ) {
	let workDirectory = null;
	try {
		workDirectory = wpEnvWorkDirectory();
	} catch {
		// Never started here; wp-env start below will create it.
	}

	if (
		workDirectory &&
		( await isEnvRunning(
			path.join( workDirectory, 'docker-compose.yml' )
		) )
	) {
		process.stdout.write( 'wp-env is already running.\n' );
	} else {
		process.stdout.write( 'Starting wp-env... ' );
		await runCommand( 'npx', [ 'wp-env', 'start' ] );
		process.stdout.write( 'done\n' );
		workDirectory = wpEnvWorkDirectory();
	}

	await ensurePluginsReady();

	if ( 'websockets' === mode ) {
		process.stdout.write(
			'Deactivating the e2e test provider plugin (if active)... '
		);
		await runWpCli( [ 'plugin', 'deactivate', TEST_PROVIDER_PLUGIN_SLUG ], {
			allowFailure: true,
		} );
		process.stdout.write( 'done\n' );

		process.stdout.write( 'Selecting the websocket transport... ' );
		await enableCollaborationExperiment();
		await runWpCli( [ 'option', 'update', TRANSPORT_OPTION, 'websocket' ] );
		process.stdout.write( 'done\n' );
	}

	// A previous daemon (crashed terminal, orphaned run) would still hold
	// the published port; replace it.
	await runCommand( 'docker', [ 'rm', '-f', DAEMON_CONTAINER_NAME ], {
		stdio: 'ignore',
	} ).catch( () => undefined );

	const composeFile = path.join( workDirectory, 'docker-compose.yml' );
	const sitePort = devSitePort( composeFile );
	const detach = CLI.detach;

	const daemon = spawn(
		'docker',
		[
			'compose',
			'-f',
			composeFile,
			'run',
			'--rm',
			...( detach ? [ '-d' ] : [] ),
			'-T',
			'--name',
			DAEMON_CONTAINER_NAME,
			'-p',
			`${ PORT }:${ PORT }`,
			'cli',
			'wp',
			'collaboration',
			'sync-server',
			'--host=0.0.0.0',
			`--port=${ PORT }`,
		],
		{ stdio: [ 'ignore', 'inherit', 'inherit' ] }
	);

	if ( detach ) {
		const [ runExitCode ] = await once( daemon, 'exit' );
		if ( 0 !== runExitCode ) {
			throw new Error( 'Failed to start the daemon container.' );
		}
		const healthy = await waitForHealth(
			`http://localhost:${ PORT }/health`,
			30000
		);
		if ( ! healthy ) {
			throw new Error(
				`The daemon container started but never answered http://localhost:${ PORT }/health; check \`docker logs ${ DAEMON_CONTAINER_NAME }\`.`
			);
		}
		process.stdout.write(
			`Websocket sync daemon running detached at ws://localhost:${ PORT }.\n` +
				( 'websockets' === mode
					? `RTC is on the websocket transport: open two windows at http://localhost:${ sitePort }/wp-admin and edit the same post.\n`
					: 'The site transport selection was left untouched; `npm run rtc:ws` switches the site onto the websocket transport.\n' ) +
				'Stop the daemon with `npm run rtc:http` (or `docker rm -f ' +
				DAEMON_CONTAINER_NAME +
				'`).\n'
		);
		return;
	}

	// Ctrl+C (and `kill <pid>`) lands here, not in the container: killing the
	// docker CLIENT alone detaches and leaves the container running, so
	// remove the container explicitly.
	let shuttingDown = false;
	const shutdown = () => {
		if ( shuttingDown ) {
			return;
		}
		shuttingDown = true;
		spawnSync( 'docker', [ 'rm', '-f', DAEMON_CONTAINER_NAME ], {
			stdio: 'ignore',
		} );
		if ( ! daemon.killed ) {
			daemon.kill( 'SIGTERM' );
		}
	};
	process.on( 'SIGINT', shutdown );
	process.on( 'SIGTERM', shutdown );

	waitForHealth( `http://localhost:${ PORT }/health`, 30000 ).then(
		( healthy ) => {
			if ( healthy ) {
				process.stdout.write(
					`\nWebsocket sync daemon reachable at ws://localhost:${ PORT }.\n` +
						( 'websockets' === mode
							? `RTC is on the websocket transport: open two windows at http://localhost:${ sitePort }/wp-admin and edit the same post.\n`
							: 'The site transport selection was left untouched; `npm run rtc:ws` switches the site onto the websocket transport.\n' ) +
						'Press Ctrl+C to stop the daemon; `npm run rtc:http` stops it AND switches the site back to HTTP polling.\n\n'
				);
			} else if ( daemon.exitCode === null ) {
				process.stdout.write(
					`\nWARNING: the daemon did not answer http://localhost:${ PORT }/health within 30s.\n` +
						'The browser cannot reach it; check the daemon output above.\n\n'
				);
			}
		}
	);

	const [ code ] = await once( daemon, 'exit' );
	// A container we removed on purpose makes the docker client exit
	// non-zero; that is a clean stop, not a failure.
	process.exit( shuttingDown ? 0 : code ?? 0 );
}

async function runHttpMode() {
	process.stdout.write(
		'Deactivating the e2e test provider plugin (if active)... '
	);
	await runWpCli( [ 'plugin', 'deactivate', TEST_PROVIDER_PLUGIN_SLUG ], {
		allowFailure: true,
	} );
	process.stdout.write( 'done\n' );

	process.stdout.write( 'Selecting the http-polling transport... ' );
	await runWpCli( [ 'option', 'update', TRANSPORT_OPTION, 'http-polling' ] );
	process.stdout.write( 'done\n' );

	await enableCollaborationExperiment();

	process.stdout.write( 'Stopping the websocket daemon (if running)... ' );
	spawnSync( 'docker', [ 'rm', '-f', DAEMON_CONTAINER_NAME ], {
		stdio: 'ignore',
	} );
	process.stdout.write( 'done\n' );

	process.stdout.write( '\nRTC switched to HTTP polling.\n' );
}

/**
 * Read-only environment doctor (`npm run doctor`): verifies the build and
 * environment facts the other tools assume, printing one line per check
 * with the fix when one fails. Mutates nothing. Exits non-zero when any
 * FAIL was reported (info/warn lines do not fail the run).
 */
async function runDoctorMode() {
	let failures = 0;
	const ok = ( message ) => process.stdout.write( `  ok    ${ message }\n` );
	const info = ( message ) =>
		process.stdout.write( `  info  ${ message }\n` );
	const warn = ( message ) =>
		process.stdout.write( `  WARN  ${ message }\n` );
	const fail = ( message, fix ) => {
		failures++;
		process.stdout.write( `  FAIL  ${ message }\n` );
		if ( fix ) {
			process.stdout.write( `        fix: ${ fix }\n` );
		}
	};

	process.stdout.write( 'Builds:\n' );
	if ( existsSync( path.join( REPO_ROOT, 'build/sync-engines.js' ) ) ) {
		ok( 'plugin client bundle (build/sync-engines.js)' );
	} else {
		fail(
			'plugin client bundle missing — the editor has no engines or transports',
			'npm run build'
		);
	}
	if ( existsSync( path.join( REPO_ROOT, 'gutenberg/build' ) ) ) {
		ok( 'vendored Gutenberg subtree is built (gutenberg/build)' );
	} else {
		fail(
			'vendored Gutenberg subtree is not built — the collaboration framework cannot load, and every editor session silently times out',
			'cd gutenberg && npm install --ignore-scripts && npm run build'
		);
	}
	if ( existsSync( path.join( REPO_ROOT, 'gutenberg/node_modules' ) ) ) {
		ok( 'subtree node_modules present (Jest/typecheck resolve from it)' );
	} else {
		warn(
			'gutenberg/node_modules missing — test:js and typecheck will fail. fix: cd gutenberg && npm install --ignore-scripts'
		);
	}

	for ( const [ label, configFile ] of [
		[ 'dev env (.wp-env.json)', null ],
		[ 'tests env (.wp-env.tests.json)', '.wp-env.tests.json' ],
	] ) {
		process.stdout.write( `${ label }:\n` );
		let workDirectory = null;
		try {
			workDirectory = wpEnvWorkDirectory( configFile || '.wp-env.json' );
		} catch {
			info( 'never started here (npm run env start / env:tests start)' );
			continue;
		}
		const composeFile = path.join( workDirectory, 'docker-compose.yml' );
		if ( ! ( await isEnvRunning( composeFile ) ) ) {
			info( 'not running' );
			continue;
		}
		const sitePort = devSitePort( composeFile );
		const restRoot = `http://localhost:${ sitePort }/wp-json/`;
		if ( await waitForHealth( restRoot, 2500 ) ) {
			ok( `running, REST reachable at ${ restRoot }` );
		} else {
			fail(
				`running but REST unreachable at ${ restRoot }`,
				'check the wordpress container logs (docker compose -f <workdir>/docker-compose.yml logs wordpress)'
			);
			continue;
		}

		let plugins;
		try {
			plugins = JSON.parse(
				await runWpCli(
					[
						'plugin',
						'list',
						'--fields=name,status,file',
						'--format=json',
					],
					{ configFile }
				)
			);
		} catch ( error ) {
			fail( `wp-cli failed: ${ error.message }` );
			continue;
		}

		// The framework comes from the plugin's BUNDLED Gutenberg copy; no
		// standalone gutenberg plugin is mounted anymore. A standalone one
		// (the tests env's precedence-spec stub, or a real install) takes
		// precedence when active — expected for the spec, wrong as a
		// steady state (the stub provides no framework).
		const gutenberg = plugins.find( ( p ) => 'gutenberg' === p.name );
		if ( gutenberg && 'active' === gutenberg.status ) {
			warn(
				'a standalone gutenberg plugin is ACTIVE — the bundled framework defers to it. If this is the e2e stub left behind by an aborted run: wp plugin deactivate gutenberg'
			);
		} else {
			ok(
				'no standalone gutenberg active — the framework loads from the bundled copy'
			);
		}

		const copies = plugins.filter( ( plugin ) =>
			plugin.file.endsWith( '/gutenberg-sync-engines.php' )
		);
		const active = copies.filter( ( p ) => 'active' === p.status );
		const directoryCopy = copies.find(
			( p ) => p.name === path.basename( REPO_ROOT )
		);
		if ( 0 === copies.length ) {
			fail( 'gutenberg-sync-engines is not installed in this env' );
		} else if ( active.length > 1 ) {
			fail(
				`both plugin copies are active (${ active
					.map( ( p ) => p.name )
					.join( ', ' ) }) — fatal redeclare`,
				'deactivate the mapping copy: wp plugin deactivate gutenberg-sync-engines (npm run rtc:ws repairs the dev env automatically)'
			);
		} else if (
			1 === active.length &&
			directoryCopy &&
			active[ 0 ].name !== directoryCopy.name
		) {
			fail(
				`the mapping copy (${ active[ 0 ].name }) is active instead of the directory-name copy — the NEXT wp-env start re-activates ${ directoryCopy.name } and fatals`,
				`wp plugin deactivate ${ active[ 0 ].name } && wp plugin activate ${ directoryCopy.name }`
			);
		} else if ( 0 === active.length ) {
			warn(
				'plugin installed but inactive (the e2e/fuzzer setups activate it themselves)'
			);
		} else {
			ok( `plugin active as ${ active[ 0 ].name }` );
		}

		if (
			active.length >= 1 &&
			gutenberg &&
			'active' === gutenberg.status
		) {
			try {
				await runWpCli(
					[ 'cli', 'has-command', 'collaboration sync-server' ],
					{ configFile }
				);
				ok( 'plugin loaded (wp collaboration commands registered)' );
			} catch {
				fail(
					'plugins active but wp collaboration commands are missing — the framework or plugin bailed during load',
					'check PHP notices: wp plugin list, and whether gutenberg/build exists in the container'
				);
			}
		}

		const options = await runWpCli(
			[
				'eval',
				"echo gutenberg_is_experiment_enabled( 'gutenberg-real-time-collaboration' ) ? '1' : '';",
			],
			{ configFile, allowFailure: true }
		);
		const engine = await runWpCli( [ 'option', 'get', 'wp_sync_engine' ], {
			configFile,
			allowFailure: true,
		} );
		const transport = await runWpCli(
			[ 'option', 'get', TRANSPORT_OPTION ],
			{ configFile, allowFailure: true }
		);
		const advisory = await runWpCli( [ 'option', 'get', ADVISORY_OPTION ], {
			configFile,
			allowFailure: true,
		} );
		info(
			`collaboration ${
				'1' === ( options || '' ).trim() ? 'enabled' : 'disabled'
			}, engine ${ (
				engine || '(default: intent-log)'
			).trim() }, transport ${ (
				transport || '(default: http-polling)'
			).trim() }, advisory ${
				( advisory || '(default: webrtc-advisory)' ).trim() || 'off'
			}`
		);

		// The SSE transport wakes streams through Redis, which each env's
		// afterStart hook starts as a sibling container on the env's own
		// network (npm run redis:start). Without it SSE runs on polling.
		const redisContainer = `${ path.basename( workDirectory ) }-redis`;
		const redisState = spawnSync(
			'docker',
			[ 'inspect', '-f', '{{.State.Running}}', redisContainer ],
			{ encoding: 'utf8' }
		);
		const redisRunning =
			0 === redisState.status && 'true' === redisState.stdout.trim();
		if ( redisRunning ) {
			ok( `Redis running (${ redisContainer }) for the SSE transport` );
		} else if ( 'sse' === ( transport || '' ).trim() ) {
			fail(
				`the site selects the SSE transport but Redis container ${ redisContainer } is ${
					0 === redisState.status ? 'stopped' : 'absent'
				} — every tab falls back to polling`,
				`${
					configFile ? 'npm run env:tests start' : 'npm run env start'
				} (its afterStart hook runs npm run redis:start)`
			);
		} else {
			info(
				`Redis ${
					0 === redisState.status ? 'stopped' : 'absent'
				} (${ redisContainer }); only the SSE transport needs it`
			);
		}

		const persistentCache = await hasPersistentObjectCache( {
			configFile,
		} );
		if ( null !== persistentCache ) {
			info(
				persistentCache
					? `object cache: Redis drop-in ON (persistent cache on sync-redis; SSE wakes on Redis notices; npm run cache:${
							configFile ? 'tests:' : ''
					  }off removes it)`
					: `object cache: none (npm run cache:${
							configFile ? 'tests:' : ''
					  }on puts the Redis drop-in in)`
			);
		}

		if ( configFile && 8889 !== sitePort ) {
			// This checkout's tests env is NOT on the default port; if some
			// other project's env answers there, Playwright's webServer check
			// silently reuses that foreign site (identical credentials, auth
			// succeeds; first visible failure is deep in global-setup).
			if (
				await waitForHealth( 'http://localhost:8889/wp-json/', 2500 )
			) {
				warn(
					`a FOREIGN wp-env holds :8889 while this checkout's tests site is on :${ sitePort } — always pass WP_BASE_URL=http://localhost:${ sitePort } to test:e2e/fuzz runs`
				);
			}
		}
	}

	process.stdout.write( 'websocket daemon:\n' );
	const daemonState = spawnSync(
		'docker',
		[ 'inspect', '-f', '{{.State.Running}}', DAEMON_CONTAINER_NAME ],
		{ encoding: 'utf8' }
	);
	if ( 0 !== daemonState.status ) {
		info(
			`not running (container ${ DAEMON_CONTAINER_NAME } absent; npm run env start or rtc:ws starts it)`
		);
	} else if ( 'true' !== daemonState.stdout.trim() ) {
		warn( `container ${ DAEMON_CONTAINER_NAME } exists but is stopped` );
	} else if (
		await waitForHealth( `http://localhost:${ PORT }/health`, 2500 )
	) {
		ok(
			`running and healthy at ws://localhost:${ PORT } (serves the most recently started dev env's database)`
		);
	} else {
		fail(
			`container running but http://localhost:${ PORT }/health does not answer — browsers retry forever with no error`,
			`docker logs ${ DAEMON_CONTAINER_NAME }; the daemon must bind 0.0.0.0 with the port published (npm run rtc:ws does both)`
		);
	}

	process.stdout.write(
		failures > 0
			? `\n${ failures } problem(s) found.\n`
			: '\nNo problems found.\n'
	);
	if ( failures > 0 ) {
		process.exit( 1 );
	}
}

async function main() {
	const mode = parseMode();
	if ( 'doctor' === mode ) {
		await runDoctorMode();
		return;
	}
	if ( 'cache' === mode ) {
		await cacheMode();
		return;
	}
	if ( 'http' === mode ) {
		await runHttpMode();
		return;
	}
	await runWebSocketsMode( mode );
}

main().catch( ( error ) => {
	process.stderr.write( `${ error.message || error }\n` );
	process.exit( 1 );
} );
