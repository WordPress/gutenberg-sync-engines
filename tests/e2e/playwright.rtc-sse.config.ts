/**
 * Playwright config for the server-sent events transport collaboration
 * e2e.
 *
 * Extends the default plugin config (`./playwright.config.ts`) and runs
 * only the specs under `specs/sse-only/`, with the SSE transport selected
 * on the tests site for the run: the global setup runs the default one
 * and then `bin/rtc-sse-transport.mjs --select` (which refuses to run
 * without the tests env's Redis container), and the global teardown
 * restores the previous transport. No daemon: SSE runs on ordinary PHP
 * requests, woken by Redis. The default config ignores `sse-only/` so
 * these specs run only here.
 *
 * External dependencies
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * Internal dependencies
 */
import baseConfig from './playwright.config';

export default defineConfig( {
	...baseConfig,
	testMatch: '**/specs/sse-only/**/*.spec.ts',
	testIgnore: [],
	globalSetup: fileURLToPath(
		new URL( './config/rtc-sse-setup.ts', 'file:' + __filename ).href
	),
	globalTeardown: fileURLToPath(
		new URL( './config/rtc-sse-teardown.ts', 'file:' + __filename ).href
	),
} );
