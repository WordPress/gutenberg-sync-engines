/**
 * Internal dependencies
 */
import { createEntitySyncAdapter } from '../../../src/entity-sync/adapter';

function setup() {
	const base = {
		shouldSync: jest.fn( () => true ),
		load: jest.fn(),
		loadCollection: jest.fn(),
		update: jest.fn(),
		beforeSave: jest.fn(),
		afterSave: jest.fn(),
		unload: jest.fn(),
		unloadAll: jest.fn(),
	};
	const flush = jest.fn( async () => {} );
	return { base, flush, adapter: createEntitySyncAdapter( base, flush ) };
}

it( 'preserves engine save fields and flushes after preparation', async () => {
	const { base, flush, adapter } = setup();
	const additions = { meta: { _crdt_document: 'snapshot' } };
	base.beforeSave.mockResolvedValue( additions );
	flush.mockImplementation( async () => {
		expect( base.beforeSave ).toHaveBeenCalledTimes( 1 );
	} );
	expect(
		await adapter.beforeSave(
			'postType',
			'post',
			1,
			{ title: 'Edit' },
			{ isAutosave: false }
		)
	).toBe( additions );
	expect( flush ).toHaveBeenCalledTimes( 1 );
} );

it( 'keeps autosave snapshots without flushing a regular save', async () => {
	const { base, flush, adapter } = setup();
	base.beforeSave.mockReturnValue( { crdt_snapshot: 'snapshot' } );
	expect(
		await adapter.beforeSave(
			'postType',
			'post',
			1,
			{},
			{ isAutosave: true }
		)
	).toEqual( { crdt_snapshot: 'snapshot' } );
	expect( flush ).not.toHaveBeenCalled();
} );

it( 'propagates a preparation failure before the request', async () => {
	const { base, flush, adapter } = setup();
	base.beforeSave.mockRejectedValue( new Error( 'Failed' ) );
	await expect(
		adapter.beforeSave( 'postType', 'post', 1, {}, { isAutosave: false } )
	).rejects.toThrow( 'Failed' );
	expect( flush ).not.toHaveBeenCalled();
} );

it( 'does not flush records the engine does not support', async () => {
	const { base, flush, adapter } = setup();
	base.shouldSync.mockReturnValue( false );
	await adapter.beforeSave( 'root', 'site', 1, {}, { isAutosave: false } );
	expect( base.beforeSave ).not.toHaveBeenCalled();
	expect( flush ).not.toHaveBeenCalled();
} );

it( 'passes record and collection handlers through to the engine bridge', () => {
	const { base, adapter } = setup();
	const handlers = { editRecord: jest.fn() };
	adapter.load( 'postType', 'wp_template', 'theme//single', {}, handlers );
	expect( base.load ).toHaveBeenCalledWith(
		'postType',
		'wp_template',
		'theme//single',
		{},
		handlers
	);
	adapter.loadCollection( 'taxonomy', 'category', handlers );
	expect( base.loadCollection ).toHaveBeenCalledWith(
		'taxonomy',
		'category',
		handlers
	);
	adapter.update(
		'postType',
		'post',
		1,
		{},
		{ isCached: true, undoIgnore: false }
	);
	expect( base.update ).toHaveBeenCalledWith(
		'postType',
		'post',
		1,
		{},
		{ isCached: true, undoIgnore: false }
	);
} );

it( 'preserves new-record notifications, live undo, and cleanup', () => {
	const { base, adapter } = setup();
	const saved = { savedRecord: { id: 2 }, edits: {} };
	adapter.afterSave( 'postType', 'post', undefined, saved );
	expect( base.afterSave ).toHaveBeenCalledWith(
		'postType',
		'post',
		undefined,
		saved
	);
	base.undoManager = { undo: jest.fn() };
	expect( adapter.undoManager ).toBe( base.undoManager );
	adapter.unload( 'postType', 'post', 1 );
	expect( base.unload ).toHaveBeenCalledWith( 'postType', 'post', 1 );
	adapter.unloadAll();
	expect( base.unloadAll ).toHaveBeenCalledTimes( 1 );
	expect( adapter.undoManager ).toBeUndefined();
	base.afterSave.mockClear();
	adapter.afterSave( 'postType', 'post', 1, saved );
	expect( base.afterSave ).not.toHaveBeenCalled();
} );
