/**
 * Global setup for the sse-only suite: the default setup, then the SSE
 * transport selected on the tests site (bin/rtc-sse-transport.mjs, which
 * also refuses to run without the tests env's Redis container).
 *
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * Internal dependencies
 */
import baseGlobalSetup from './global-setup';

// Playwright transpiles this file as CommonJS (no import.meta).
const LAUNCHER = path.resolve( __dirname, '../bin/rtc-sse-transport.mjs' );

async function globalSetup( config: FullConfig ) {
	await baseGlobalSetup( config );
	const result = spawnSync( process.execPath, [ LAUNCHER, '--select' ], {
		stdio: 'inherit',
	} );
	if ( 0 !== result.status ) {
		throw new Error(
			'Could not select the SSE transport on the tests site (see the launcher output above).'
		);
	}
}

export default globalSetup;
