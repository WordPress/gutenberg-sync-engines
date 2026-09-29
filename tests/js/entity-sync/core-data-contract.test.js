/**
 * External dependencies
 */
import path from 'node:path';

/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { createEngineAdapter as createEntitySyncAdapter } from './engine-fixture';

jest.mock( '@wordpress/api-fetch' );
jest.mock( '@wordpress/blocks', () => ( {} ) );

// This suite loads the actual API and save actions from Gutenberg.
describe( 'adapter against the actual Gutenberg entity sync API', () => {
	let register;
	let actions;
	let unregister;
	let manager;
	let dispatch;
	let select;
	let resolveSelect;
	let record;

	beforeAll( () => {
		const source = path.join(
			process.env.WP_ENTITY_SYNC_ROOT ||
				path.resolve( __dirname, '../../../gutenberg' ),
			'packages/core-data/src'
		);
		jest.doMock( path.join( source, 'entities.js' ), () => ( {
			DEFAULT_ENTITY_KEY: 'id',
			deprecatedEntities: {},
		} ) );
		// The fixture loads the real engine bridge separately. Keep this action
		// import from initializing the editor UI.
		jest.doMock( path.join( source, 'sync.ts' ), () => ( {} ) );
		( { registerEntitySyncManager: register } = require(
			path.join( source, 'entity-sync.ts' )
		) );
		actions = require( path.join( source, 'actions.js' ) );
	} );

	beforeEach( () => {
		apiFetch.mockReset();
		window.__experimentalEnableRealTimeCollaboration = true;
		record = { id: 1, title: 'Initial' };
		manager = {
			load: jest.fn(),
			loadCollection: jest.fn(),
			update: jest.fn(),
			unload: jest.fn(),
			unloadAll: jest.fn(),
			createPersistedCRDTDoc: jest.fn(),
			getEntitySnapshot: jest.fn(),
		};
		unregister = register(
			createEntitySyncAdapter( {
				manager,
				getSyncConfig: () => ( {} ),
				flushBeforeSave: async () => {},
			} )
		);
		dispatch = Object.assign(
			jest.fn( ( action ) => {
				if ( action.type === 'EDIT_ENTITY_RECORD' ) {
					record = { ...record, ...action.edits };
				}
			} ),
			{
				receiveEntityRecords: jest.fn(),
				receiveAutosaves: jest.fn(),
				__unstableAcquireStoreLock: jest.fn(),
				__unstableReleaseStoreLock: jest.fn(),
			}
		);
		select = {
			getEntityConfig: () => ( {} ),
			getRawEntityRecord: () => ( { id: 1, title: 'Initial' } ),
			getEditedEntityRecord: () => record,
			getUndoManager: () => ( { addRecord: () => {} } ),
		};
		resolveSelect = {
			getEntitiesConfig: () => [
				{ kind: 'postType', name: 'post', baseURL: '/wp/v2/posts' },
			],
		};
	} );

	afterEach( () => {
		unregister?.();
		delete window.__experimentalEnableRealTimeCollaboration;
	} );

	it.each( [ false, true ] )(
		'uses the real save action (autosave: %s)',
		async ( isAutosave ) => {
			apiFetch.mockResolvedValue( {
				id: 1,
				title: 'Edited',
				status: 'draft',
			} );
			await actions.saveEntityRecord(
				'postType',
				'post',
				{ id: 1, title: 'Edited' },
				{ isAutosave }
			)( { select, dispatch, resolveSelect } );
			expect( apiFetch ).toHaveBeenCalledTimes( 1 );
			expect( manager.update ).toHaveBeenCalledTimes(
				isAutosave ? 1 : 2
			);
			if ( ! isAutosave ) {
				expect( manager.update ).toHaveBeenLastCalledWith(
					'postType/post',
					1,
					{ status: 'draft' },
					'gutenberg-undo-ignored',
					{ isSave: true }
				);
			}
			expect( dispatch.__unstableReleaseStoreLock ).toHaveBeenCalledTimes(
				1
			);
		}
	);

	it( 'keeps a failed request out of the collection save feed', async () => {
		const error = { code: 'rest_error', message: 'Failed' };
		apiFetch.mockRejectedValue( error );
		await expect(
			actions.saveEntityRecord(
				'postType',
				'post',
				{ id: 1 },
				{ throwOnError: true }
			)( { select, dispatch, resolveSelect } )
		).rejects.toBe( error );
		expect( manager.update ).toHaveBeenCalledTimes( 1 );
		expect( dispatch.__unstableReleaseStoreLock ).toHaveBeenCalledTimes(
			1
		);
	} );
} );
