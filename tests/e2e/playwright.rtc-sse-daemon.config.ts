/**
 * Playwright config for the `sse-daemon` transport collaboration e2e.
 *
 * Extends the default plugin config (`./playwright.config.ts`) and runs
 * the specs under `specs/sse-framing/` — the receive-stream framing both
 * SSE transports speak — plus the daemon-only specs under
 * `specs/sse-daemon-only/`, against the plugin's `sse-daemon` transport:
 * a second webServer is the same daemon launcher the websocket lane uses,
 * told `--transport=sse-daemon`, so the tests site negotiates the
 * daemon-served stream rather than the socket. The default config ignores
 * both directories so these specs run only here.
 *
 * `config/rtc-daemon-teardown.ts` is shared with the websocket lane: it
 * replays the launcher's persisted transport restore in Playwright's main
 * process, and does not care which slug that launcher selected.
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
 * env's daemon, which serves the wrong database, or a stale lane daemon)
 * would abort the run instead of being replaced by the launcher. MAIN
 * PROCESS ONLY: Playwright workers reload this config, and an unguarded
 * cleanup here removed the live daemon mid-run.
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

export default defineConfig( {
	...baseConfig,
	testMatch: [
		'**/specs/sse-framing/**/*.spec.ts',
		'**/specs/sse-daemon-only/**/*.spec.ts',
	],
	testIgnore: [],
	globalTeardown: fileURLToPath(
		new URL( './config/rtc-daemon-teardown.ts', 'file:' + __filename ).href
	),
	webServer: [
		...baseWebServer,
		{
			command:
				'exec node ./bin/rtc-real-ws-daemon.mjs --transport=sse-daemon',
			reuseExistingServer: false,
			stderr: 'pipe',
			stdout: 'pipe',
			// The PHP daemon's own health endpoint.
			url: 'http://localhost:8787/health',
			// Compose pull/spin-up plus the option flip can be slow.
			timeout: 90_000,
		},
	],
} );
