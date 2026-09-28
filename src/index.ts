/**
 * Client entry: registers this plugin's sync ENGINES and TRANSPORTS into the
 * collaborative-editing framework shipped by Gutenberg (`@wordpress/sync`).
 *
 * The framework exposes its registration surface through UNLOCKABLE PRIVATE
 * APIs. This plugin unlocks them with the shared consent string and adds:
 *   - engine adapters (intent-log, yjs-server) via
 *     `registerSyncEngine`
 *   - transport providers (http-polling, sse, websocket) via
 *     `registerSyncTransport`
 *
 * With this plugin inactive the framework registers nothing, so a session
 * finds no engine/transport to negotiate and the editor falls back to the
 * classic post lock — real-time collaboration effectively disabled.
 *
 * NOTE: the moved engine adapters and providers under `engines/` and
 * `providers/` still import framework internals by relative path (their
 * origin inside `@wordpress/sync`). Those imports, and the exact shape of
 * the unlocked surface below, are the coordinated Gutenberg change tracked
 * in PORTING.md. `@wordpress/sync` is externalized to the `wp.sync` runtime
 * global at build time (dependency extraction), so this plugin ships no copy
 * of the framework.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import { privateApis } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { unlock } from './lock-unlock';
import { createIntentLogEngineAdapter } from './engines/intent-log-adapter';
import { createYjsServerEngineAdapter } from './engines/yjs-server-adapter';
import { createDeRtcEngineAdapter } from './engines/de-rtc-adapter';
import { createHttpPollingProvider } from './providers/http-polling/http-polling-provider';
import { createWebSocketProvider } from './providers/websocket/websocket-provider';
import { createSseProvider } from './providers/sse/sse-provider';
import { bootstrapSlowAwareness } from './awareness';
// Disabled for now; uncomment together with the call below to bring back the
// manual Sync button (demo tooling for the http-polling transport).
// import { registerManualSyncButton } from './manual-sync/manual-sync-button';
// TEMPORARY: see src/temporary/suppress-editor-notices.ts.
import { suppressEditorNotices } from './temporary/suppress-editor-notices';
// TEMPORARY: see src/temporary/clock-aligned-sync.ts. Disabled in favor of
// the demo sync shortcut below; uncomment together with the call below.
// import { alignSyncToClock } from './temporary/clock-aligned-sync';
// TEMPORARY: see src/temporary/demo-sync-shortcut.ts.
import { installDemoSyncShortcut } from './temporary/demo-sync-shortcut';

const { registerSyncEngine, registerSyncTransport } = unlock( privateApis );

// Engines: how concurrent edits merge.
registerSyncEngine( createIntentLogEngineAdapter() );
registerSyncEngine( createYjsServerEngineAdapter() );
registerSyncEngine( createDeRtcEngineAdapter() );

// Transports: how updates move. Each carries the slug + protocol the server
// announces and negotiates against.
registerSyncTransport( {
	slug: 'http-polling',
	protocolVersion: 1,
	create: createHttpPollingProvider,
} );
registerSyncTransport( {
	slug: 'websocket',
	protocolVersion: 1,
	create: createWebSocketProvider,
} );

registerSyncTransport( {
	slug: 'sse',
	protocolVersion: 1,
	create: createSseProvider,
} );

// Slow awareness (block presence on a slow cadence), when the site has
// turned it on; see src/awareness/.
bootstrapSlowAwareness();

// Demo tooling: on the http-polling transport, hold automatic polling and
// sync on demand from a header button instead. Disabled for now; uncomment
// together with the import above to bring the button back.
// registerManualSyncButton();

// TEMPORARY: hide the browser-backup notice and the join/leave toasts (see
// the module for details).
suppressEditorNotices();

// TEMPORARY: fire automatic short-polling syncs on a 10-second wall-clock
// grid: user 1 at :00 and :02, user 2 at :01 (see the module for details).
// Disabled in favor of the demo sync shortcut; uncomment with its import.
// alignSyncToClock();

// TEMPORARY: hold automatic polling; Cmd+Shift+S in either window syncs
// user 1's window, then user 2's (see the module for details).
installDemoSyncShortcut();
