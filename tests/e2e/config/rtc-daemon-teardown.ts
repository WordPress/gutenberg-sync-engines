/**
 * Global teardown for the websocket-only suite: restores the tests
 * site's pre-suite transport selection.
 *
 * The daemon launcher (`bin/rtc-real-ws-daemon.mjs`) selects the
 * websocket transport when it starts and restores it when it exits —
 * but Playwright may SIGKILL webServer process groups at shutdown, so
 * that in-process restore is not guaranteed to run (a killed run left
 * the site pinned to a daemon-less websocket transport, and every
 * later polling suite timed out at session discovery). This teardown
 * runs in Playwright's MAIN process, before webServer shutdown, and
 * replays the restore from the launcher's persisted state file.
 * Idempotent with the launcher's own restore.
 *
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Playwright transpiles this file as CommonJS (no import.meta).
const LAUNCHER = path.resolve( __dirname, '../bin/rtc-real-ws-daemon.mjs' );

export default function globalTeardown(): void {
	spawnSync( process.execPath, [ LAUNCHER, '--restore-only' ], {
		stdio: 'inherit',
	} );
}
