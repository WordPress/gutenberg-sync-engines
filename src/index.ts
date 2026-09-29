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
 * Core-data receives record loads, edits, saves and cleanup through the
 * entity adapter registered below. The bundled bridge preserves each engine's
 * snapshots, undo metadata, connection status and conflict-review handlers.
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
import { registerPluginEntitySync } from './entity-sync';

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

// Core-data receives lifecycle events through the plugin adapter in every mode.
registerPluginEntitySync();

// Slow awareness (block presence on a slow cadence), when the site has
// turned it on; see src/awareness/.
bootstrapSlowAwareness();
