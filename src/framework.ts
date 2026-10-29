/**
 * Plugin-owned engine and transport services. Gutenberg supplies the editor
 * interface and the shared Yjs instance; it does not select these engines.
 */
export {
	registerSyncEngine,
	resolveEngineAdapter,
	getEngineAdapters,
	resetEngineAdaptersForTesting,
} from './sync/engines';
export {
	registerSyncTransport,
	getProviderCreators,
	resetProviderCreatorsForTesting,
} from './sync/providers';
export { createSyncManager } from './sync/manager';
export { ConnectionError, ConnectionErrorCode } from './sync/errors';
export { LOCAL_EDITOR_ORIGIN, LOCAL_UNDO_IGNORED_ORIGIN } from './sync/config';
