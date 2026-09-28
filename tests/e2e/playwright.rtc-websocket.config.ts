/**
 * Playwright config for the WebSocket-transport collaboration e2e.
 *
 * Extends the default plugin config (`./playwright.config.ts`) and runs
 * only the specs under `specs/websocket-only/`, against the plugin's REAL
 * websocket transport: a second webServer selects the websocket transport
 * on the tests site and runs the `wp collaboration sync-server` PHP daemon
 * (engine seam and all) with host port 8787 published; Playwright waits on
 * the daemon's own /health endpoint and the launcher restores the previous
 * transport at teardown. The default config ignores `websocket-only/` so
 * these specs run only here.
 *
 * (The old y-websocket PEER-relay fixture lane — the test WS provider
 * plugin plus `rtc-test-ws-sync-server.mjs` — only demonstrated
 * client-merging engines and none remains; both live engines are
 * server-authoritative, which is exactly what the real daemon exercises.)
 *
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

/**
 * Internal dependencies
 */
import baseConfig from './playwright.config';

/*
 * Free host port 8787 BEFORE Playwright's webServer probe: with
 * reuseExistingServer false, an already-responding health URL (the DEV
 * env's auto-started daemon, which serves the WRONG database for this
 * suite, or a stale fuzz daemon) would abort the run instead of being
 * replaced by the launcher. MAIN PROCESS ONLY: Playwright workers reload
 * this config, and an unguarded cleanup here removed the live daemon
 * mid-run.
 */
if ( ! process.env.TEST_WORKER_INDEX ) {
	for ( const holder of [
		'wp-sync-ws-daemon',
		'rtc-fuzz-ws-daemon',
		'rtc-e2e-ws-daemon',
	] ) {
		spawnSync( 'docker', [ 'rm', '-f', holder ], { stdio: 'ignore' } );
	}
}

type ArrayElement< T > = T extends Array< infer Item > ? Item : T;
type WebServerConfig = ArrayElement<
	Exclude< PlaywrightTestConfig[ 'webServer' ], undefined >
>;

const baseWebServer: WebServerConfig[] = [];
if ( Array.isArray( baseConfig.webServer ) ) {
	baseWebServer.push( ...baseConfig.webServer );
} else if ( baseConfig.webServer ) {
	baseWebServer.push( baseConfig.webServer );
}

// The plugin-local fixtures switch their sync waits to the websocket
// manager's observability global under this flag.
process.env.GUTENBERG_RTC_REAL_WS = '1';

/*
 * The example bring-your-own relay (examples/advisory-relay/relay.mjs),
 * for the advisory-relay spec: it runs on port 8790 beside the daemon
 * with a fixed test secret, and the spec activates the
 * tests/e2e/plugins/advisory-relay-access-token.php fixture, which
 * configures the same secret on the site, and sets the WebSocket URL
 * option to the relay's address.
 */
const RELAY_PORT = 8790;
const RELAY_ACCESS_TOKEN_SECRET =
	'e2e-advisory-relay-access-token-secret-not-for-production-0123456789';

const config = defineConfig( {
	...baseConfig,
	testMatch: '**/specs/websocket-only/**/*.spec.ts',
	testIgnore: [],
	// Restores the site's transport in the MAIN process: the daemon
	// launcher's own restore dies with the webServer process group when
	// Playwright SIGKILLs it (a killed run once left the site pinned to
	// a daemon-less websocket transport; every later polling suite then
	// timed out at session discovery).
	globalTeardown: fileURLToPath(
		new URL( './config/rtc-websocket-teardown.ts', 'file:' + __filename )
			.href
	),
	webServer: [
		...baseWebServer,
		{
			command: 'exec node ./bin/rtc-real-ws-daemon.mjs',
			reuseExistingServer: false,
			stderr: 'pipe',
			stdout: 'pipe',
			// The PHP daemon's own health endpoint.
			url: 'http://localhost:8787/health',
			// Compose pull/spin-up plus the option flip can be slow.
			timeout: 90_000,
		},
		{
			command: `exec node ../../examples/advisory-relay/relay.mjs`,
			cwd: __dirname,
			env: {
				WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET:
					RELAY_ACCESS_TOKEN_SECRET,
				PORT: String( RELAY_PORT ),
			},
			reuseExistingServer: false,
			stderr: 'pipe',
			stdout: 'pipe',
			url: `http://localhost:${ RELAY_PORT }/health`,
			timeout: 30_000,
		},
	],
} );

export default config;
