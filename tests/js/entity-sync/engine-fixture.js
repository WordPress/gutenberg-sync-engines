/**
 * Internal dependencies
 */
import { createEntitySyncAdapter } from '../../../src/entity-sync/adapter';
import { createPluginEntitySyncManager } from '../../../src/entity-sync/manager';

/**
 * Supply editor callbacks while running the real plugin entity manager.
 * @param {Object}                                                                             root0                 Dependencies.
 * @param {import("../../../src/sync").SyncManager}                                            root0.manager         Engine manager.
 * @param {(kind: string, name: string) => import("../../../src/sync").SyncConfig | undefined} root0.getSyncConfig   Config getter.
 * @param {() => Promise<void>}                                                                root0.flushBeforeSave Save flush.
 */
export function createEngineAdapter( {
	manager,
	getSyncConfig,
	flushBeforeSave,
} ) {
	return createEntitySyncAdapter(
		createPluginEntitySyncManager(
			{
				getSyncConfig,
				recordHandlers: ( _kind, _name, _id, handlers ) => ( {
					...handlers,
					onStatusChange: () => {},
					persistCRDTDoc: () => {},
					addUndoMeta: () => {},
					restoreUndoMeta: () => {},
				} ),
				collectionHandlers: ( _kind, _name, handlers ) => ( {
					...handlers,
					onStatusChange: () => {},
				} ),
			},
			() => manager
		),
		flushBeforeSave
	);
}
