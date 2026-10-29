/**
 * Internal dependencies
 */
import { createPluginEntitySyncManager } from '../../../src/entity-sync/manager';
import { createEntitySyncAdapter } from '../../../src/entity-sync/adapter';

jest.mock( '@wordpress/blocks', () => ( {
	getBlockType: () => undefined,
} ) );

function setup() {
	const engine = {
		load: jest.fn(),
		update: jest.fn(),
		getEntitySnapshot: jest.fn( () => 'snapshot' ),
		entityContainsSnapshot: jest.fn( () => true ),
		createPersistedCRDTDoc: jest.fn( async () => 'document' ),
		unloadAll: jest.fn(),
		retry: jest.fn(),
	};
	const resolve = jest.fn( () => engine );
	const manager = createPluginEntitySyncManager(
		{
			getSyncConfig: () => ( {} ),
			recordHandlers: ( _kind, _name, _id, handlers ) => handlers,
		},
		resolve
	);
	return { manager, engine, resolve };
}

beforeEach( () => {
	window.__experimentalEnableRealTimeCollaboration = true;
} );
afterEach( () => {
	delete window.__experimentalEnableRealTimeCollaboration;
	delete window._gseSemanticPrototype;
} );

it( 'uses one engine for editor changes, snapshot reads, and connection retry', () => {
	const { manager, engine, resolve } = setup();
	expect( resolve ).not.toHaveBeenCalled();
	manager.load( 'postType', 'post', 7, {}, {} );
	manager.update(
		'postType',
		'post',
		7,
		{ title: 'Edit' },
		{
			isCached: true,
			undoIgnore: false,
		}
	);
	expect( manager.services.getEntitySnapshot( 'postType/post', '7' ) ).toBe(
		'snapshot'
	);
	manager.services.retry();
	expect( resolve ).toHaveBeenCalledTimes( 1 );
	expect( engine.update ).toHaveBeenCalledWith(
		'postType/post',
		7,
		{ title: 'Edit' },
		'gutenberg',
		{ isNewUndoLevel: false }
	);
	expect( engine.retry ).toHaveBeenCalledTimes( 1 );
} );

it( 'captures direct save edits before the autosave snapshot and preserves saved meta', async () => {
	const { manager, engine } = setup();
	const edits = { title: 'Direct save', meta: { colour: 'blue' } };
	engine.getEntitySnapshot.mockImplementation( () => {
		expect( engine.update ).toHaveBeenCalledWith(
			'postType/post',
			7,
			edits,
			'gutenberg-undo-ignored'
		);
		return 'snapshot';
	} );
	expect(
		await manager.beforeSave( 'postType', 'post', 7, edits, {
			persistedRecord: { id: 7 },
			isAutosave: true,
		} )
	).toEqual( { crdt_snapshot: 'snapshot' } );
	expect(
		await manager.beforeSave( 'postType', 'post', 7, edits, {
			persistedRecord: { id: 7 },
			isAutosave: false,
		} )
	).toEqual( { meta: { colour: 'blue', _crdt_document: 'document' } } );
	expect( engine.createPersistedCRDTDoc ).toHaveBeenCalledWith(
		'postType/post',
		7
	);
} );

it( 'does not resend unchanged sibling meta or a raw/rendered title from the save response', () => {
	const { manager, engine } = setup();
	manager.afterSave( 'postType', 'post', 7, {
		persistedRecord: {
			title: 'Old',
			meta: { colour: 'red', sibling: 'kept' },
		},
		edits: { title: 'New', meta: { colour: 'blue' } },
		savedRecord: {
			title: { raw: 'New', rendered: 'New' },
			meta: {
				colour: 'blue',
				sibling: 'kept',
				server: 'added',
				_crdt_document: 'saved copy',
			},
		},
	} );
	expect( engine.update ).toHaveBeenCalledWith(
		'postType/post',
		7,
		{ meta: { server: 'added' } },
		'gutenberg-undo-ignored',
		{ isSave: true }
	);
} );

it( 'stops captured actions with the entity adapter and resumes them on load', () => {
	const { manager } = setup();
	const capture = jest.fn();
	window._gseSemanticPrototype = { capture, apply: () => false };
	const adapter = createEntitySyncAdapter( manager, async () => {} );
	const action = {
		action: { type: 'UPDATE_BLOCK_ATTRIBUTES' },
		before: {},
		after: {},
		registry: {},
	};
	adapter.onEditorAction( action );
	adapter.unloadAll();
	adapter.onEditorAction( action );
	expect( capture ).toHaveBeenCalledTimes( 1 );
	adapter.load( 'postType', 'post', 7, {}, {} );
	adapter.onEditorAction( action );
	expect( capture ).toHaveBeenCalledTimes( 2 );
} );

it( 'reports an unavailable engine instead of selecting a different one', () => {
	const resolve = jest.fn( () => undefined );
	const manager = createPluginEntitySyncManager(
		{ getSyncConfig: () => ( {} ) },
		resolve
	);
	expect( manager.shouldSync( 'postType', 'post', 7 ) ).toBe( false );
	expect( manager.services.isAvailable() ).toBe( false );
	expect(
		manager.services.getEntitySnapshot( 'postType/post', '7' )
	).toBeUndefined();
} );
