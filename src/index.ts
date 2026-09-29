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
 *   - the conflict review UI (src/review/), fed by the engines' conflict
 *     sources through the plugin-local registry
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
import {
	createYjsServerEngineAdapter,
	yjsServerConflictSource,
} from './engines/yjs-server-adapter';
import {
	createDeRtcEngineAdapter,
	deRtcConflictSource,
} from './engines/de-rtc-adapter';
import { intentLogConflictSource } from './engines/intent-log-manager';
import { registerConflictSource } from './review';
import { createHttpPollingProvider } from './providers/http-polling/http-polling-provider';
import { createWebSocketProvider } from './providers/websocket/websocket-provider';
import { createSseProvider } from './providers/sse/sse-provider';
import { bootstrapSlowAwareness } from './awareness';

const { registerSyncEngine, registerSyncTransport } = unlock( privateApis );

// Engines: how concurrent edits merge.
registerSyncEngine( createIntentLogEngineAdapter() );
registerSyncEngine( createYjsServerEngineAdapter() );
registerSyncEngine( createDeRtcEngineAdapter() );

// Conflict review: the in-canvas cards and dialogs (src/review/) render
// from the engines' conflict sources. yjs-server publishes security holds
// only (a CRDT merge detects no conflicts to set aside).
registerConflictSource( intentLogConflictSource );
registerConflictSource( deRtcConflictSource );
registerConflictSource( yjsServerConflictSource );

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
