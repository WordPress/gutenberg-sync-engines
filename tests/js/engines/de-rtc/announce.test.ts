/**
 * The announce model (Tier 3, stage 1). Accepted proposals
 * arrive as content-less ANNOUNCE rows; the session advances by hash for
 * its own unchanged round-trips, fetches canonical content only when it
 * will actually use it, and incorporates fetched snapshots for merged
 * own proposals (preserving locally-edited blocks).
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import * as Y from 'yjs';

import { hashDeRtcContent } from '../../../../src/engines/de-rtc/descriptor';
import { createDeRtcEngine } from '../../../../src/engines/de-rtc/engine';
import {
	DE_RTC_ANNOUNCE_TYPE,
	DE_RTC_FETCH_TYPE,
	DE_RTC_PROPOSAL_TYPE,
	DE_RTC_SNAPSHOT_TYPE,
	setDeRtcBurstQuietMsForTesting,
} from '../../../../src/engines/de-rtc/session';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

function makeSyncConfig(): jest.MockedObject< SyncConfig > {
	return {
		applyChangesToCRDTDoc: jest.fn( ( doc: Y.Doc, changes: any ) => {
			const map = doc.getMap( CRDT_RECORD_MAP_KEY );
			Object.entries( changes ).forEach( ( [ key, value ] ) => {
				map.set( key, value );
			} );
		} ),
		getChangesFromCRDTDoc: jest.fn( ( doc: Y.Doc ) =>
			doc.getMap( CRDT_RECORD_MAP_KEY ).toJSON()
		),
	} as unknown as jest.MockedObject< SyncConfig >;
}

const BLOCK_A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const BLOCK_B = { name: 'core/paragraph', attributes: { content: 'Beta' } };
const BLOCK_C = { name: 'core/paragraph', attributes: { content: 'Gamma' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

const snapshotRow = ( version: string, content: string ) => ( {
	type: DE_RTC_SNAPSHOT_TYPE,
	data: JSON.stringify( { version, content } ),
} );

const announceRow = (
	version: string,
	contentHash: string,
	authorClientId: number,
	proposalId: string
) => ( {
	type: DE_RTC_ANNOUNCE_TYPE,
	data: JSON.stringify( {
		version,
		baseVersion: 'v1',
		contentHash,
		authorClientId,
		proposalId,
	} ),
} );

describe( 'de-rtc announce model', () => {
	let syncConfig: jest.MockedObject< SyncConfig >;

	beforeEach( () => {
		syncConfig = makeSyncConfig();
		// These suites drive edits and snapshots in the same tick; the
		// typing-burst quiet gate would defer every snapshot otherwise.
		// The gate has its own dedicated test below.
		setDeRtcBurstQuietMsForTesting( 0 );
	} );

	afterEach( () => {
		setDeRtcBurstQuietMsForTesting( 500 );
	} );

	function makeSession() {
		const entity = createDeRtcEngine().createEntity( {
			syncConfig,
			// A type WITHOUT a commit route: these suites pin the transport
			// proposal lane (collections/unsupported types still use it).
			objectType: 'postType/book',
			objectId: '1',
		} as any );
		const session = entity.createSession();
		const sent: Array< { type: string; data: string } > = [];
		session.onLocalUpdate( ( update: any ) => sent.push( update ) );
		return { entity, session, sent };
	}

	it( 'advances by hash on its own unchanged round-trip — no fetch, no content', () => {
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);
		expect( sent ).toHaveLength( 1 );
		const proposal = JSON.parse( sent[ 0 ].data );
		const clientId = proposal.proposalId.split( '-' )[ 1 ];

		session.receiveUpdate(
			announceRow(
				'v2',
				hashDeRtcContent( proposal.proposedContent ),
				Number( clientId ),
				proposal.proposalId
			)
		);

		// No fetch went out; the next proposal bases on the announced v2.
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 0 );
		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B, BLOCK_C ] } as any,
			'editor',
			{}
		);
		const next = JSON.parse( sent[ sent.length - 1 ].data );
		expect( next.baseVersion ).toBe( 'v2' );
	} );

	it( 'fetches once for a foreign announcement and applies the snapshot', () => {
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		session.receiveUpdate(
			announceRow( 'v2', 'peer-hash', 999, 'p-peer' )
		);
		const fetches = sent.filter(
			( update ) => DE_RTC_FETCH_TYPE === update.type
		);
		expect( fetches ).toHaveLength( 1 );
		expect( JSON.parse( fetches[ 0 ].data ).haveVersion ).toBe( 'v1' );

		// A repeated announcement of the same version does not re-fetch.
		session.receiveUpdate(
			announceRow( 'v2', 'peer-hash', 999, 'p-peer' )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 1 );

		// The synthesized snapshot catches the session up.
		session.receiveUpdate(
			snapshotRow( 'v2', contentOf( BLOCK_A, BLOCK_C ) )
		);
		const changes = entity.getEditorChanges( { blocks: [] } as any ) as any;
		expect( changes.blocks ).toEqual( [ BLOCK_A, BLOCK_C ] );
	} );

	it( 'fetches eagerly (even mid-flight); repeats only on announced progress', () => {
		const { session, sent, entity } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);

		// A peer's announcement lands while ours is in flight: the fetch
		// goes out IMMEDIATELY — the snapshot defers if we're still busy,
		// so the content is ready at settle instead of a round trip away.
		session.receiveUpdate(
			announceRow( 'v2', 'peer-hash', 999, 'p-peer' )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 1 );

		// A REPEATED announcement of the same version does not re-fetch,
		// but a NEWER one does (the liveness backstop for a lost fetch —
		// the wire-inspected soak's starvation lesson).
		session.receiveUpdate(
			announceRow( 'v2', 'peer-hash', 999, 'p-peer' )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 1 );
		session.receiveUpdate(
			announceRow( 'v3', 'peer-hash-2', 999, 'p-peer-2' )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 2 );

		// The snapshot answers everything announced so far: quiet.
		session.receiveUpdate(
			snapshotRow( 'v3', contentOf( BLOCK_A, BLOCK_C ) )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 2 );

		// A newer announcement after fulfillment fetches again.
		session.receiveUpdate(
			announceRow( 'v4', 'peer-hash-3', 999, 'p-peer-3' )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 3 );
	} );

	it( 'a voided disposition forces a catch-up fetch (stale-base recovery)', () => {
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);
		const proposal = JSON.parse( sent[ 0 ].data );

		// The server voids the proposal (base aged out of the snapshot
		// window): the session must fetch canonical content immediately,
		// not wait for an announcement it may never correlate.
		session.receiveDispositions?.( [
			{
				intentId: proposal.proposalId,
				status: 'voided',
				reason: 'unknown-base-version',
			} as any,
		] );
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 1 );
	} );

	it( 'holds commits after a merged own announcement so the rest of a typing burst never declares the stale base', () => {
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		// Keystroke 1 commits immediately.
		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);
		const proposal = JSON.parse( sent[ 0 ].data );
		const clientId = Number( proposal.proposalId.split( '-' )[ 1 ] );

		// The server merged a peer's concurrent edit into it: hash differs,
		// so we are told v2 exists but do not hold its content yet.
		session.receiveUpdate(
			announceRow( 'v2', 'merged-differs', clientId, proposal.proposalId )
		);
		const proposalsBefore = sent.filter(
			( update ) => DE_RTC_PROPOSAL_TYPE === update.type
		).length;

		// The REST of the burst arrives during the catch-up round trip.
		// Proposing now would declare v1 — a base whose canonical content
		// already moved — and the server would read our OWN accepted
		// keystroke as a foreign concurrent change and park the rest.
		entity.applyLocalChanges(
			{ blocks: [ BLOCK_C ] } as any,
			'editor',
			{}
		);
		expect(
			sent.filter( ( update ) => DE_RTC_PROPOSAL_TYPE === update.type )
		).toHaveLength( proposalsBefore );

		// The catch-up snapshot releases the hold, and the queued burst
		// goes out against the version it was really written on top of.
		session.receiveUpdate(
			snapshotRow( 'v2', contentOf( BLOCK_B, BLOCK_A ) )
		);
		const proposals = sent.filter(
			( update ) => DE_RTC_PROPOSAL_TYPE === update.type
		);
		expect( proposals.length ).toBe( proposalsBefore + 1 );
		expect(
			JSON.parse( proposals[ proposals.length - 1 ].data ).baseVersion
		).toBe( 'v2' );
	} );

	it( 'incorporates the fetched snapshot for a merged own proposal, keeping newer local edits', () => {
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);
		const proposal = JSON.parse( sent[ 0 ].data );
		const clientId = Number( proposal.proposalId.split( '-' )[ 1 ] );

		// The server merged a peer's appended block into our proposal:
		// announce hash ≠ ours.
		session.receiveUpdate(
			announceRow( 'v2', 'merged-differs', clientId, proposal.proposalId )
		);
		expect(
			sent.filter( ( update ) => DE_RTC_FETCH_TYPE === update.type )
		).toHaveLength( 1 );

		// The fetched snapshot: our BLOCK_B plus the peer's BLOCK_C.
		session.receiveUpdate(
			snapshotRow( 'v2', contentOf( BLOCK_B, BLOCK_C ) )
		);
		const changes = entity.getEditorChanges( { blocks: [] } as any ) as any;
		expect( changes.blocks ).toEqual( [ BLOCK_B, BLOCK_C ] );

		// And the next proposal bases on v2.
		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B, BLOCK_C, BLOCK_A ] } as any,
			'editor',
			{}
		);
		const next = JSON.parse( sent[ sent.length - 1 ].data );
		expect( next.type ?? DE_RTC_PROPOSAL_TYPE ).toBe(
			DE_RTC_PROPOSAL_TYPE
		);
		expect( next.baseVersion ).toBe( 'v2' );
	} );

	it( 'the commit-cadence dial spaces commits and coalesces the interim edits', () => {
		jest.useFakeTimers();
		( window as any )._gutenbergSyncEnginesSettings = {
			deRtcCommitIntervalMs: 10_000,
		};
		try {
			const { entity, session, sent } = makeSession();
			session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

			// The first settle commits immediately (nothing to space from).
			entity.applyLocalChanges(
				{ blocks: [ BLOCK_B ] } as any,
				'editor',
				{}
			);
			const first = sent.filter(
				( update ) => DE_RTC_PROPOSAL_TYPE === update.type
			);
			expect( first ).toHaveLength( 1 );
			const proposal = JSON.parse( first[ 0 ].data );

			// It settles by hash; more edits land inside the window.
			session.receiveUpdate(
				announceRow(
					'v2',
					hashDeRtcContent( proposal.proposedContent ),
					Number( proposal.proposalId.split( '-' )[ 1 ] ),
					proposal.proposalId
				)
			);
			entity.applyLocalChanges(
				{ blocks: [ BLOCK_B, BLOCK_C ] } as any,
				'editor',
				{}
			);
			expect(
				sent.filter(
					( update ) => DE_RTC_PROPOSAL_TYPE === update.type
				)
			).toHaveLength( 1 ); // Held to the cadence.

			// The dial's boundary arrives: ONE coalesced commit goes out.
			jest.advanceTimersByTime( 10_050 );
			const after = sent.filter(
				( update ) => DE_RTC_PROPOSAL_TYPE === update.type
			);
			expect( after ).toHaveLength( 2 );
			expect( JSON.parse( after[ 1 ].data ).proposedContent ).toContain(
				'Gamma'
			);
		} finally {
			delete ( window as any )._gutenbergSyncEnginesSettings;
			jest.useRealTimers();
		}
	} );

	it( 'REGRESSION: a snapshot arriving mid-typing-burst is deferred until the burst quiets', async () => {
		// The e2e gap: our own proposal settles by hash MID-BURST, so for
		// one inter-keystroke window dirty and inFlight are both false —
		// the old code applied an arriving canonical snapshot instantly,
		// the framework pushed the rewritten blocks, the block under the
		// caret remounted, and the user's remaining keystrokes vanished
		// ("Second from two" -> "Second " on loaded hosts). The snapshot
		// must wait out the typing-quiet window instead.
		setDeRtcBurstQuietMsForTesting( 50 );
		const { entity, session, sent } = makeSession();
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );

		// Typing: the edit proposes, and the proposal settles by hash —
		// the commit slot is free while the fingers are still going.
		entity.applyLocalChanges(
			{ blocks: [ BLOCK_B ] } as any,
			'editor',
			{}
		);
		const proposal = JSON.parse(
			sent.filter(
				( update ) => DE_RTC_PROPOSAL_TYPE === update.type
			)[ 0 ].data
		);
		session.receiveUpdate(
			announceRow(
				'v2',
				hashDeRtcContent( proposal.proposedContent ),
				Number( proposal.proposalId.split( '-' )[ 1 ] ),
				proposal.proposalId
			)
		);

		// A peer's canonical snapshot lands in that window: it must NOT
		// apply yet (the burst is still hot).
		session.receiveUpdate( snapshotRow( 'v5', contentOf( BLOCK_C ) ) );
		expect(
			JSON.stringify(
				( entity.getEditorChanges( { blocks: [] } as any ) as any )
					.blocks ?? []
			)
		).not.toContain( 'Gamma' );

		// The burst quiets; the deferred snapshot applies on its own.
		await new Promise( ( resolve ) => setTimeout( resolve, 140 ) );
		expect(
			JSON.stringify(
				( entity.getEditorChanges( { blocks: [] } as any ) as any )
					.blocks ?? []
			)
		).toContain( 'Gamma' );
	} );

	describe( 'room restart', () => {
		it( 're-proposes the local content against the new genesis instead of being overwritten by it', () => {
			const { entity, session, sent } = makeSession();
			session.receiveUpdate( snapshotRow( 'v3', contentOf( BLOCK_A ) ) );
			entity.applyLocalChanges(
				{ blocks: [ BLOCK_A, BLOCK_B ] } as any,
				'editor',
				{}
			);
			expect( sent ).toHaveLength( 1 ); // in flight against v3

			expect( ( session as any ).onRoomRestart( [] ) ).toBe(
				'rebootstrap'
			);
			// The new room's genesis is v1 (the saved post, lower than the
			// version we held): it must not be ignored by the version gate,
			// and it must not clobber the local blocks.
			session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );
			const proposals = sent.filter(
				( update ) => DE_RTC_PROPOSAL_TYPE === update.type
			);
			expect( proposals ).toHaveLength( 2 );
			const reproposal = JSON.parse( proposals[ 1 ].data );
			expect( reproposal.baseVersion ).toBe( 'v1' );
			expect( JSON.parse( reproposal.proposedContent ) ).toEqual( [
				BLOCK_A,
				BLOCK_B,
			] );
			const changes = entity.getEditorChanges( {
				blocks: [],
			} as any ) as any;
			expect( changes.blocks ).toEqual( [ BLOCK_A, BLOCK_B ] );
		} );

		it( 'adopts the new genesis outright when the local content already matches it', () => {
			const { entity, session, sent } = makeSession();
			session.receiveUpdate( snapshotRow( 'v3', contentOf( BLOCK_A ) ) );
			( session as any ).onRoomRestart( [] );
			session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );
			expect(
				sent.filter(
					( update ) => DE_RTC_PROPOSAL_TYPE === update.type
				)
			).toHaveLength( 0 );
			// Later proposals base on the adopted lineage.
			entity.applyLocalChanges(
				{ blocks: [ BLOCK_A, BLOCK_C ] } as any,
				'editor',
				{}
			);
			const proposal = JSON.parse( sent[ sent.length - 1 ].data );
			expect( proposal.baseVersion ).toBe( 'v1' );
		} );
	} );
} );
