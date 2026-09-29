/**
 * The framework manager's review wiring, driven through the REAL
 * `createSyncManager` (resolved from the subtree source): an engine that
 * supplies a `review` source gets its parked-conflict items presented
 * through the record handlers and the manager's resolution verbs, with
 * the notification discipline the review UI depends on (coalesced list
 * updates, one escalation per proposal id). This coverage replaces the
 * retired plugin-side review-manager decorator's test suite.
 */

/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

/**
 * WordPress dependencies
 */
import { addFilter, removeFilter } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import {
	createSyncManager,
	resetProviderCreatorsForTesting,
} from '../../src/framework';

// eslint-disable-next-line import/no-unresolved -- Resolved to the subtree.
import type {
	SyncEngine,
	SyncReviewItem,
	SyncReviewSource,
} from '@wordpress/sync';

const flushMicrotasks = () => Promise.resolve().then( () => {} );

function makeReviewSource( initialItems: SyncReviewItem[] = [] ) {
	let items = initialItems;
	const listeners = new Map< string, Set< () => void > >();
	const keyOf = ( objectType: string, objectId: unknown ) =>
		`${ objectType }:${ String( objectId ) }`;
	const source: SyncReviewSource = {
		getOpenItems: jest.fn( () => items ),
		subscribe: jest.fn(
			( objectType: string, objectId: unknown, listener: () => void ) => {
				const key = keyOf( objectType, objectId );
				if ( ! listeners.has( key ) ) {
					listeners.set( key, new Set() );
				}
				listeners.get( key )!.add( listener );
				return () => listeners.get( key )!.delete( listener );
			}
		),
		resolveProposal: jest.fn(),
		restoreProposal: jest.fn(),
	};

	return {
		source,
		setItems( next: SyncReviewItem[] ) {
			items = next;
		},
		emit( objectType: string, objectId: unknown ) {
			listeners
				.get( keyOf( objectType, objectId ) )
				?.forEach( ( listener ) => listener() );
		},
		listenerCount( objectType: string, objectId: unknown ) {
			return listeners.get( keyOf( objectType, objectId ) )?.size ?? 0;
		},
	};
}

/**
 * A minimal engine whose entity does nothing: the tests exercise the
 * manager's review wiring, not a document model.
 *
 * @param review The engine's review source; omit for a review-less engine.
 */
function makeEngine( review?: SyncReviewSource ) {
	const createEntity = jest.fn( () => ( {
		awareness: undefined,
		createSession: () => ( {} ) as never,
		hydrate: () => {},
		applyLocalChanges: () => {},
		getEditorChanges: () => ( {} ),
		encodeSnapshot: () => '',
		containsSnapshot: () => true,
		serialize: () => '',
		observe: () => {},
		addToUndoScope: () => {},
		destroy: jest.fn(),
	} ) );

	const engine = {
		slug: 'test-engine',
		protocolVersion: 1,
		createEntity,
		createCollection: jest.fn(),
		...( review ? { review } : {} ),
	} as unknown as SyncEngine;

	return { engine, createEntity };
}

const handlerStubs = () => ( {
	addUndoMeta: jest.fn(),
	editRecord: jest.fn(),
	getEditedRecord: jest.fn( async () => ( {} ) ),
	onStatusChange: jest.fn(),
	persistCRDTDoc: jest.fn(),
	refetchRecord: jest.fn( async () => {} ),
	restoreUndoMeta: jest.fn(),
} );

const item = ( id: string, extra: Partial< SyncReviewItem > = {} ) =>
	( {
		id,
		unitId: id,
		isLocal: true,
		actorId: 'u1c1',
		reason: 'frame-conflict',
		intentType: 'proposal',
		...extra,
	} ) as SyncReviewItem;

const load = (
	manager: ReturnType< typeof createSyncManager >,
	objectType: string,
	objectId: string,
	extraHandlers: object = {}
) =>
	manager.load(
		{} as never,
		objectType,
		objectId,
		{} as never,
		{ ...handlerStubs(), ...extraHandlers } as never
	);

describe( 'createSyncManager review wiring', () => {
	beforeEach( () => {
		// The real-time-collaboration experiment gate, stamped by the
		// framework's editor settings at runtime.
		(
			window as { __experimentalEnableRealTimeCollaboration?: boolean }
		 ).__experimentalEnableRealTimeCollaboration = true;
		resetProviderCreatorsForTesting();
		// One inert provider so loadEntity proceeds past its provider guard.
		addFilter( 'sync.providers', 'tests/framework-review', () => [
			async () => ( {
				on: jest.fn(),
				destroy: jest.fn(),
			} ),
		] );
	} );

	afterEach( () => {
		removeFilter( 'sync.providers', 'tests/framework-review' );
		resetProviderCreatorsForTesting();
	} );

	it( 'notifies the review handlers with items from the engine review source', async () => {
		const review = makeReviewSource( [ item( 'p1' ) ] );
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		const onProposalsChange = jest.fn();
		const onEscalation = jest.fn();
		await load( manager, 'postType/post', '42', {
			onProposalsChange,
			onEscalation,
		} );

		review.emit( 'postType/post', '42' );
		await flushMicrotasks();

		expect( onProposalsChange ).toHaveBeenCalledWith( [
			expect.objectContaining( { id: 'p1' } ),
		] );
		expect( onEscalation ).toHaveBeenCalledWith(
			expect.objectContaining( { proposalId: 'p1', isLocal: true } )
		);
	} );

	it( 'subscribes BEFORE the engine entity is created (engines rely on this ordering)', async () => {
		const review = makeReviewSource();
		const { engine, createEntity } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		const order: string[] = [];
		( review.source.subscribe as jest.Mock ).mockImplementation( () => {
			order.push( 'subscribe' );
			return () => {};
		} );
		createEntity.mockImplementation( () => {
			order.push( 'createEntity' );
			return makeEngine().createEntity();
		} );

		await load( manager, 'postType/post', '42' );

		expect( order ).toEqual( [ 'subscribe', 'createEntity' ] );
	} );

	it( 'coalesces bursts into one notification and escalates each id once', async () => {
		const review = makeReviewSource( [ item( 'p1' ) ] );
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		const onProposalsChange = jest.fn();
		const onEscalation = jest.fn();
		await load( manager, 'postType/post', '42', {
			onProposalsChange,
			onEscalation,
		} );

		review.emit( 'postType/post', '42' );
		review.emit( 'postType/post', '42' );
		review.emit( 'postType/post', '42' );
		await flushMicrotasks();

		expect( onProposalsChange ).toHaveBeenCalledTimes( 1 );
		expect( onEscalation ).toHaveBeenCalledTimes( 1 );

		// A later change re-notifies the list but not the seen escalation.
		review.setItems( [ item( 'p1' ), item( 'p2', { isLocal: false } ) ] );
		review.emit( 'postType/post', '42' );
		await flushMicrotasks();

		expect( onProposalsChange ).toHaveBeenCalledTimes( 2 );
		expect( onEscalation ).toHaveBeenCalledTimes( 2 );
		expect( onEscalation ).toHaveBeenLastCalledWith(
			expect.objectContaining( { proposalId: 'p2', isLocal: false } )
		);
	} );

	it( 'routes resolveProposal and restoreProposal to the review source', () => {
		const review = makeReviewSource();
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		manager.resolveProposal?.( 'postType/post', '42', 'p9', 'dismissed' );
		expect( review.source.resolveProposal ).toHaveBeenCalledWith(
			'postType/post',
			'42',
			'p9',
			'dismissed'
		);

		manager.restoreProposal?.( 'postType/post', '42', 'p9' );
		expect( review.source.restoreProposal ).toHaveBeenCalledWith(
			'postType/post',
			'42',
			'p9'
		);
	} );

	it( 'exposes no resolution verbs for an engine without a review source', async () => {
		const { engine } = makeEngine();
		const manager = createSyncManager( engine );

		expect( manager.resolveProposal ).toBeUndefined();
		expect( manager.restoreProposal ).toBeUndefined();

		// Loading still works; there is just nothing to subscribe to.
		await expect(
			load( manager, 'postType/post', '42' )
		).resolves.toBeUndefined();
	} );

	it( 'stops notifying after unload and cleans up subscriptions', async () => {
		const review = makeReviewSource( [ item( 'p1' ) ] );
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		const onProposalsChange = jest.fn();
		await load( manager, 'postType/post', '42', { onProposalsChange } );
		expect( review.listenerCount( 'postType/post', '42' ) ).toBe( 1 );

		manager.unload( 'postType/post', '42' );
		expect( review.listenerCount( 'postType/post', '42' ) ).toBe( 0 );

		review.emit( 'postType/post', '42' );
		await flushMicrotasks();
		expect( onProposalsChange ).not.toHaveBeenCalled();
	} );

	it( 'a pending notification scheduled before unload never fires', async () => {
		const review = makeReviewSource( [ item( 'p1' ) ] );
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		const onProposalsChange = jest.fn();
		await load( manager, 'postType/post', '42', { onProposalsChange } );

		review.emit( 'postType/post', '42' );
		manager.unload( 'postType/post', '42' );
		await flushMicrotasks();

		expect( onProposalsChange ).not.toHaveBeenCalled();
	} );

	it( 'unloadAll detaches every entity', async () => {
		const review = makeReviewSource();
		const { engine } = makeEngine( review.source );
		const manager = createSyncManager( engine );

		await load( manager, 'postType/post', '1' );
		await load( manager, 'postType/page', '2' );
		expect( review.listenerCount( 'postType/post', '1' ) ).toBe( 1 );
		expect( review.listenerCount( 'postType/page', '2' ) ).toBe( 1 );

		manager.unloadAll();
		expect( review.listenerCount( 'postType/post', '1' ) ).toBe( 0 );
		expect( review.listenerCount( 'postType/page', '2' ) ).toBe( 0 );
	} );
} );
