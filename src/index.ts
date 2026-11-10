/**
 * Register plugin engines and transports, then connect the selected engine
 * to Gutenberg through its entity provider interface.
 */
/**
 * Internal dependencies
 */
import { registerSyncEngine, registerSyncTransport } from './framework';
import { createIntentLogEngineAdapter } from './engines/intent-log-adapter';
import { createYjsServerEngineAdapter } from './engines/yjs-server-adapter';
import { createHttpPollingProvider } from './providers/http-polling/http-polling-provider';
import { createWebSocketProvider } from './providers/websocket/websocket-provider';
import { createSseProvider } from './providers/sse/sse-provider';
import { createSseDaemonProvider } from './providers/sse-daemon/sse-daemon-provider';
import { bootstrapSlowAwareness } from './awareness';
import { registerPluginEntitySync } from './entity-sync';
import { registerReviewUi } from './review';

// Engines: how concurrent edits merge.
registerSyncEngine( createIntentLogEngineAdapter() );
registerSyncEngine( createYjsServerEngineAdapter() );

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

// The same receive stream, served by the sync daemon instead of a web worker.
registerSyncTransport( {
	slug: 'sse-daemon',
	protocolVersion: 1,
	create: createSseDaemonProvider,
} );

// The conflict review surface (store, notices, panel, in-canvas cards) the
// engines' record handlers feed; registered before the provider so the
// store exists when the first list arrives.
registerReviewUi();

// Core-data receives lifecycle events through the plugin adapter in every mode.
registerPluginEntitySync();

// Slow awareness (block presence on a slow cadence), when the site has
// turned it on; see src/awareness/.
bootstrapSlowAwareness();
