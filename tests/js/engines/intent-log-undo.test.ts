/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	createIntentLogSession,
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import { createIntentLogUndoManager } from '../../../src/engines/intent-log-undo';
import type { EngineUpdate } from '@wordpress/sync';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';

const GENESIS_BLOCKS = [
	{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello world' },
	{
		syncId: 'q1',
		blockType: 'core/quote',
		fields: {
			content: { text: 'To be or not to be' },
			citation: { text: 'Shakespeare' },
		},
	},
];

// Wire-level stand-in mirroring the session test harness (see
// intent-log-session.test.ts): planner-backed ingest, rows then acks.
function makeWireServer() {
	const initialDoc = createDocument( GENESIS_BLOCKS );
	const server = createServer( initialDoc );
	const rows: EngineUpdate[] = [
		{
			data: JSON.stringify( { doc: initialDoc } ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		},
	];

	// Ids the server has settled — the engine-class cancel lane's
	// too-late test (mirrors WP_Intent_Log_Engine, not the frozen core).
	const settledIds = new Set< string >();

	return {
		ingest( sent: EngineUpdate[] ) {
			const cancelDispositions: Array< {
				intentId: string;
				status: string;
				reason?: string;
			} > = [];
			const canceledIds = new Set< string >();
			for ( const update of sent ) {
				if ( INTENT_LOG_UPDATE_TYPES.CANCEL !== update.type ) {
					continue;
				}
				const cancel = JSON.parse( update.data );
				const tooLate = cancel.intentIds.some( ( id: string ) =>
					settledIds.has( id )
				);
				if ( tooLate ) {
					cancelDispositions.push( {
						intentId: cancel.cancelId,
						status: 'voided',
						reason: 'cancel-too-late',
					} );
					continue;
				}
				for ( const id of cancel.intentIds ) {
					canceledIds.add( id );
					settledIds.add( id );
					rows.push( {
						data: JSON.stringify( {
							intentId: id,
							reason: 'canceled',
						} ),
						type: INTENT_LOG_UPDATE_TYPES.VOIDED,
					} );
				}
				cancelDispositions.push( {
					intentId: cancel.cancelId,
					status: 'applied',
				} );
			}

			const parsed = sent
				.filter(
					( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
				)
				.map( ( update ) => JSON.parse( update.data ) );
			const dropped = parsed.filter( ( intent ) =>
				canceledIds.has( intent.intentId )
			);
			const intents = parsed.filter(
				( intent ) => ! canceledIds.has( intent.intentId )
			);
			const logBefore = server.log.length;
			const results = serverIngestBatch( server, intents );
			for ( const intent of intents ) {
				settledIds.add( intent.intentId );
			}
			for ( const entry of server.log.slice( logBefore ) ) {
				rows.push( {
					data: JSON.stringify( entry ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				} );
			}
			return [
				...intents.map(
					( intent: { intentId: string }, index: number ) => ( {
						intentId: intent.intentId,
						...results[ index ],
					} )
				),
				...dropped.map( ( intent: { intentId: string } ) => ( {
					intentId: intent.intentId,
					status: 'voided',
					reason: 'canceled',
				} ) ),
				...cancelDispositions,
			];
		},
		rowsAfter: ( cursor: number ) => rows.slice( cursor ),
		rowCount: () => rows.length,
		doc: () => serverDocAt( server, server.log.length ),
	};
}

function connect(
	wire: ReturnType< typeof makeWireServer >,
	session: IntentLogSession
) {
	const queue: EngineUpdate[] = [];
	session.onLocalUpdate( ( update ) => queue.push( update ) );

	return {
		poll() {
			const sent = queue.splice( 0 );
			const dispositions = sent.length ? wire.ingest( sent ) : null;
			const updates = wire.rowsAfter( this.cursor );
			this.cursor = wire.rowCount();
			for ( const update of updates ) {
				session.receiveUpdate( update );
			}
			if ( dispositions && session.receiveDispositions ) {
				session.receiveDispositions( dispositions );
			}
			return dispositions;
		},
		cursor: 0,
	};
}

function harness( userId = 1, clientId = 11, captureTimeout = 0 ) {
	const wire = makeWireServer();
	const session = createIntentLogSession( { userId, clientId } );
	const link = connect( wire, session );
	const onStackChange = jest.fn();
	// captureTimeout 0 keeps every edit() its own unit unless a test
	// exercises the coalescing chain explicitly.
	const undo = createIntentLogUndoManager( {
		onStackChange,
		captureTimeout,
	} );
	undo.attachSession( session );
	link.poll(); // Bootstrap from the genesis snapshot.

	/**
	 * Authors a "capture batch" the way the manager does.
	 * @param intents
	 */
	const edit = (
		intents: Array< { type: string; payload: Record< string, unknown > } >
	) => {
		const envelopes = session.authorBatch( intents, {
			baseSeq: session.getSeq(),
		} );
		undo.noteAuthored( session, envelopes );
		return envelopes;
	};

	const serverText = ( syncId: string, field = 'content' ) =>
		( getBlock( wire.doc(), syncId ) as any )?.fields?.[ field ]?.text;

	return { wire, session, link, undo, edit, onStackChange, serverText };
}

describe( 'intent-log collaborative undo', () => {
	it.each( [ 'format_text', 'delete_text' ] )(
		'undo and redo keep a split %s atomic',
		( type ) => {
			const { wire, session, link, undo, edit, serverText } = harness();
			const peer = createIntentLogSession( { userId: 2, clientId: 22 } );
			const peerLink = connect( wire, peer );
			peerLink.poll();
			// Both edits are authored against the unsplit text; the split arrives first.
			edit( [
				{
					type,
					payload: {
						syncId: 'p1',
						field: 'content',
						start: 3,
						end: 8,
						...( type === 'format_text'
							? { format: 'bold', on: true }
							: { removedText: 'lo wo' } ),
					},
				},
			] );
			peer.author( 'split_block', {
				syncId: 'p1',
				field: 'content',
				offset: 5,
				newSyncId: 'tail',
			} );
			peerLink.poll();
			link.poll();
			const expected = wire.doc();
			if ( type === 'delete_text' ) {
				expect( serverText( 'p1' ) ).toBe( 'Hel' );
				expect( serverText( 'tail' ) ).toBe( 'rld' );
			}
			undo.undo();
			link.poll();
			expect( serverText( 'p1' ) ).toBe( 'Hello' );
			expect( serverText( 'tail' ) ).toBe( ' world' );
			undo.redo();
			link.poll();
			expect( wire.doc() ).toEqual( expected );
			expect( session.getDocument() ).toEqual( expected );
		}
	);

	it( 'redo holds back every slice when a peer changed one selected range', () => {
		const { wire, link, undo, edit, serverText } = harness();
		const peer = createIntentLogSession( { userId: 2, clientId: 22 } );
		const peerLink = connect( wire, peer );
		peerLink.poll();
		edit( [
			{
				type: 'delete_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					start: 3,
					end: 8,
					removedText: 'lo wo',
				},
			},
		] );
		peer.author( 'split_block', {
			syncId: 'p1',
			field: 'content',
			offset: 5,
			newSyncId: 'tail',
		} );
		peerLink.poll();
		link.poll();
		undo.undo();
		link.poll();
		peerLink.poll();
		peer.author( 'insert_text', {
			syncId: 'tail',
			field: 'content',
			offset: 1,
			text: 'PEER',
		} );
		peerLink.poll();
		link.poll();
		undo.redo();
		const results = link.poll();
		expect(
			results?.filter( ( result ) => result.status === 'escalated' )
		).toHaveLength( 2 );
		expect( serverText( 'p1' ) ).toBe( 'Hello' );
		expect( serverText( 'tail' ) ).toBe( ' PEERworld' );
	} );

	it( 'a settled text edit undoes and redoes, converging on the server', () => {
		const { link, undo, edit, serverText } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		// Not yet settled — but undoable anyway: a fully-pending unit is
		// CANCELABLE, so hasUndo no longer waits for the settle
		// round trip.
		expect( undo.hasUndo() ).toBe( true );
		link.poll();
		expect( undo.hasUndo() ).toBe( true );
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
		expect( undo.hasUndo() ).toBe( false );
		expect( undo.hasRedo() ).toBe( true );

		undo.redo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );
		expect( undo.hasUndo() ).toBe( true );
		expect( undo.hasRedo() ).toBe( false );
	} );

	it( 'undo inside the settle window CANCELS the pending unit', () => {
		const { session, link, undo, edit, serverText } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		expect( undo.hasUndo() ).toBe( true );
		expect( session.getPendingCount() ).toBe( 1 );

		// Undo BEFORE any poll: the intent cancels instead of no-oping.
		expect( undo.undo() ).toEqual( [] );
		expect( session.getPendingCount() ).toBe( 0 );
		expect( undo.hasUndo() ).toBe( false );

		// The queued intent and its cancel travel in the SAME batch: the
		// server drops the pair and the edit never lands.
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
		expect( undo.hasUndo() ).toBe( false );
		expect( undo.hasRedo() ).toBe( false );
	} );

	it( 'a cancel that lost the race resurrects the unit as a settled undo candidate', () => {
		const { wire, session, link, undo, edit, serverText } = harness();

		const envelopes = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );

		// The intent reaches the server out-of-band (its POST was already
		// in flight when the user pressed undo).
		wire.ingest( [
			{
				data: JSON.stringify( envelopes[ 0 ] ),
				type: INTENT_LOG_UPDATE_TYPES.INTENT,
			},
		] );

		// Local cancel still succeeds (no ack processed yet)…
		expect( undo.undo() ).toEqual( [] );
		expect( session.getPendingCount() ).toBe( 0 );

		// …but the wire copy was ingested: the poll redelivers the intent
		// (idempotent), the cancel acks too-late, the accepted row
		// resurrects the effect, and the unit returns to the stack as a
		// normal settled candidate.
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );
		expect( undo.hasUndo() ).toBe( true );

		// The second undo inverts it the ordinary way.
		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
	} );

	it( 'cancellation is all-or-nothing: a settled unit does not cancel', () => {
		const { session, link, undo, edit } = harness();

		const envelopes = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		link.poll(); // Settles: outbox empty.

		expect(
			session.cancelPendingIntents(
				envelopes.map( ( envelope ) => envelope.intentId )
			)
		).toBe( false );
		expect( undo.hasUndo() ).toBe( true ); // Settled: inverse path.
	} );

	it( 'undo reverts only this client, transformed over a peer row that shifted the text', () => {
		const alice = harness( 1, 11 );
		const bobSession = createIntentLogSession( {
			userId: 2,
			clientId: 22,
		} );
		const bobLink = connect( alice.wire, bobSession );
		bobLink.poll();

		alice.edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' ALICE',
				},
			},
		] );
		alice.link.poll();

		// Bob prepends BEFORE Alice's range, shifting it by four.
		bobLink.poll();
		bobSession.authorBatch(
			[
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'BOB ',
					},
				},
			],
			{ baseSeq: bobSession.getSeq() }
		);
		bobLink.poll();
		alice.link.poll();
		expect( alice.serverText( 'p1' ) ).toBe( 'BOB Hello world ALICE' );

		alice.undo.undo();
		alice.link.poll();
		// Alice's words came out; Bob's survived the rebase.
		expect( alice.serverText( 'p1' ) ).toBe( 'BOB Hello world' );
	} );

	it( 'a multi-intent capture batch reverts as one unit', () => {
		const { link, undo, edit, serverText, wire } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: '!',
				},
			},
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'wide',
					observedVersion: 0,
				},
			},
			{
				type: 'insert_text',
				payload: {
					syncId: 'q1',
					field: 'citation',
					offset: 0,
					text: 'W. ',
				},
			},
		] );
		link.poll();
		expect( serverText( 'q1', 'citation' ) ).toBe( 'W. Shakespeare' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
		expect( serverText( 'q1', 'citation' ) ).toBe( 'Shakespeare' );
		// The attr write inverted to a removal (it had no prior value).
		expect(
			( getBlock( wire.doc(), 'p1' ) as any ).attrs.align
		).toBeUndefined();
	} );

	it( 'undoing a block removal reinserts the subtree with all its fields at its old position', () => {
		const { link, undo, edit, wire } = harness();

		edit( [ { type: 'remove_block', payload: { syncId: 'q1' } } ] );
		link.poll();
		expect( getBlock( wire.doc(), 'q1' ) ).toBeNull();

		undo.undo();
		link.poll();
		const restored = getBlock( wire.doc(), 'q1' ) as any;
		expect( restored ).not.toBeNull();
		expect( restored.fields.content.text ).toBe( 'To be or not to be' );
		expect( restored.fields.citation.text ).toBe( 'Shakespeare' );
		// Back at its old position: after p1 at the root.
		expect( wire.doc().root.map( ( block: any ) => block.syncId ) ).toEqual(
			[ 'p1', 'q1' ]
		);
	} );

	it( 'a set_attr with a prior value restores it; walks past no-inverse units', () => {
		const { link, undo, edit, wire } = harness();

		edit( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'wide',
					observedVersion: 0,
				},
			},
		] );
		link.poll();
		edit( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'full',
					observedVersion: 1,
				},
			},
		] );
		link.poll();
		expect( ( getBlock( wire.doc(), 'p1' ) as any ).attrs.align ).toBe(
			'full'
		);

		undo.undo();
		link.poll();
		expect( ( getBlock( wire.doc(), 'p1' ) as any ).attrs.align ).toBe(
			'wide'
		);
	} );

	it( 'per-keystroke batches within the capture window coalesce into one undo unit', () => {
		// A realistic capture cadence: the manager authors one batch per
		// editor update (a keystroke each). With the capture window on,
		// the burst reverts as ONE unit.
		const { link, undo, edit, serverText } = harness( 1, 11, 10_000 );

		for ( const [ index, char ] of [ ...' EDIT' ].entries() ) {
			edit( [
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 11 + index,
						text: char,
					},
				},
			] );
		}
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
		expect( undo.hasUndo() ).toBe( false );

		undo.redo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );
	} );

	it( 'stopCapturing forces the next batch into a fresh unit', () => {
		const { link, undo, edit, serverText } = harness( 1, 11, 10_000 );

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' one',
				},
			},
		] );
		undo.stopCapturing();
		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 15,
					text: ' two',
				},
			},
		] );
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world one two' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world one' );
		expect( undo.hasUndo() ).toBe( true );
	} );

	it( 'a new edit clears the redo stack', () => {
		const { link, undo, edit } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' one',
				},
			},
		] );
		link.poll();
		undo.undo();
		link.poll();
		expect( undo.hasRedo() ).toBe( true );

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' two',
				},
			},
		] );
		expect( undo.hasRedo() ).toBe( false );
	} );

	it( 'notifies stack-state transitions', () => {
		const { link, undo, edit, onStackChange } = harness();
		expect( onStackChange ).not.toHaveBeenCalled();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'X',
				},
			},
		] );
		link.poll();
		expect( onStackChange ).toHaveBeenLastCalledWith( {
			hasUndo: true,
			hasRedo: false,
		} );

		undo.undo();
		link.poll();
		expect( onStackChange ).toHaveBeenLastCalledWith( {
			hasUndo: false,
			hasRedo: true,
		} );
	} );

	it( 'a horizon reset clears both stacks', () => {
		const { link, undo, edit, session } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'X',
				},
			},
		] );
		link.poll();
		expect( undo.hasUndo() ).toBe( true );

		// A compaction checkpoint beyond our cursor re-bootstraps the
		// replica; documents below it are gone.
		session.receiveUpdate( {
			data: JSON.stringify( {
				doc: createDocument( GENESIS_BLOCKS ),
				seq: 500,
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );
		expect( undo.hasUndo() ).toBe( false );
		expect( undo.hasRedo() ).toBe( false );
	} );

	it( 'retention pins the replica log to the oldest tracked row', () => {
		const { link, edit, session } = harness();

		const first = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'A',
				},
			},
		] );
		link.poll();
		// Push the observed frame forward; without the undo pin the replica
		// would be free to trim the first row away.
		session.setObservedSeq( session.getSeq() );
		for ( let i = 0; i < 5; i++ ) {
			edit( [
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: String( i ),
					},
				},
			] );
			link.poll();
			session.setObservedSeq( session.getSeq() );
		}
		expect( session.getRetainedFloor() ).toBeLessThanOrEqual( 0 );
		// The first unit is still derivable and undoable…
		expect( session.getDocumentAt( 0 ) ).not.toBeNull();
		void first;
	} );
} );
