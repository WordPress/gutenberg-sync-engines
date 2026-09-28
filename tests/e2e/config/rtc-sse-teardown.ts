/**
 * Global teardown for the sse-only suite: restores the tests site's
 * pre-suite transport selection from the launcher's state file.
 *
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Playwright transpiles this file as CommonJS (no import.meta).
const LAUNCHER = path.resolve( __dirname, '../bin/rtc-sse-transport.mjs' );

export default function globalTeardown(): void {
	spawnSync( process.execPath, [ LAUNCHER, '--restore-only' ], {
		stdio: 'inherit',
	} );
}
