// @ts-nocheck
/**
 * Internal dependencies
 */
import { createEntitySyncAdapter } from '../../../src/entity-sync/adapter';

// Use the real vendored bridge with a supplied engine and a small store.
export function createEngineAdapter( {
	manager,
	getSyncConfig,
	flushBeforeSave,
} ) {
	const root = '../../../gutenberg/packages/core-data/src/';
	let createDefaultEntitySyncManager;
	jest.isolateModules( () => {
		jest.doMock( '@wordpress/sync', () => ( {
			privateApis: {
				resolveEngineAdapter: () => ( {
					createManager: () => manager,
				} ),
				LOCAL_EDITOR_ORIGIN: 'gutenberg',
				LOCAL_UNDO_IGNORED_ORIGIN: 'gutenberg-undo-ignored',
			},
		} ) );
		jest.doMock( root + 'lock-unlock', () => ( {
			unlock: ( value ) => value,
		} ) );
		jest.doMock( root + 'entities', () => ( {
			DEFAULT_ENTITY_KEY: 'id',
		} ) );
		jest.doMock( root + 'utils/crdt', () => ( {
			POST_META_KEY_FOR_CRDT_DOC_PERSISTENCE: '_crdt_document',
			getRawValue: ( value ) =>
				typeof value === 'string' ? value : value?.raw,
		} ) );
		jest.doMock( root + 'utils/crdt-selection', () => ( {} ) );
		jest.doMock( root + 'utils/save-crdt-doc', () => ( {
			saveCRDTDoc: jest.fn(),
		} ) );
		jest.doMock( root + 'sync-review', () => ( {
			createSyncReviewHandlers: () => ( {} ),
		} ) );
		( { createDefaultEntitySyncManager } = jest.requireActual(
			root + 'sync'
		) );
	} );
	const data = {
		select: () => ( {
			getEntityConfig: ( kind, name ) => ( {
				syncConfig: getSyncConfig( kind, name ),
			} ),
		} ),
		dispatch: () => ( { setSyncConnectionStatus: () => {} } ),
		resolveSelect: () => ( {} ),
	};
	return createEntitySyncAdapter(
		createDefaultEntitySyncManager( data ),
		flushBeforeSave
	);
}
