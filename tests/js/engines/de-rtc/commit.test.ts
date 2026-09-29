/**
 * Save/Sync inversion, stage 2: the commit lane. Proposals ride the autosave
 * endpoint instead of transport rows; the response's rows + dispositions
 * settle through the session's ordinary machinery; failures retry
 * without losing edits. The transport carries no proposals at all.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

import type { DeRtcCommitResponse } from '../../../../src/engines/de-rtc/commit';
import { hashDeRtcContent } from '../../../../src/engines/de-rtc/descriptor';
import { createDeRtcDocBridge } from '../../../../src/engines/de-rtc/doc-bridge';
import {
	createDeRtcSessionCodec,
	DE_RTC_ANNOUNCE_TYPE,
	DE_RTC_SNAPSHOT_TYPE,
} from '../../../../src/engines/de-rtc/session';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/shared/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

const BLOCK_A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const BLOCK_B = { name: 'core/paragraph', attributes: { content: 'Beta' } };
const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

const syncConfig = {
	applyChangesToCRDTDoc: ( doc: Y.Doc, changes: any ) => {
		const map = doc.getMap( CRDT_RECORD_MAP_KEY );
		Object.entries( changes ).forEach( ( [ key, value ] ) => {
			map.set( key, value );
		} );
	},
	getChangesFromCRDTDoc: ( doc: Y.Doc ) =>
		doc.getMap( CRDT_RECORD_MAP_KEY ).toJSON(),
} as unknown as SyncConfig;

function makeCommitSession(
	commit: ( update: any ) => Promise< DeRtcCommitResponse >
) {
	const doc = new Y.Doc();
	const bridge = createDeRtcDocBridge( doc, syncConfig );
	const session = createDeRtcSessionCodec( { bridge, commit } );
	const sent: Array< { type: string; data: string } > = [];
	session.onLocalUpdate( ( update: any ) => sent.push( update ) );
	session.receiveUpdate( {
		type: DE_RTC_SNAPSHOT_TYPE,
		data: JSON.stringify( {
			version: 'v1',
			content: contentOf( BLOCK_A ),
		} ),
	} );
	const edit = ( blocks: unknown[] ) => {
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );
	};
	return { doc, bridge, session, sent, edit };
}

/** Flushes pending microtasks. */
const flush = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

describe( 'de-rtc commit lane', () => {
	beforeEach( () => {
		jest.useRealTimers();
	} );

	it( 'proposals ride the commit adapter, never the transport', async () => {
		const commits: any[] = [];
		const { edit, sent } = makeCommitSession( async ( update ) => {
			commits.push( JSON.parse( update.data ) );
			return {};
		} );

		edit( [ BLOCK_B ] );
		await flush();

		expect( commits ).toHaveLength( 1 );
		expect( commits[ 0 ].baseVersion ).toBe( 'v1' );
		expect( JSON.parse( commits[ 0 ].proposedContent ) ).toEqual( [
			BLOCK_B,
		] );
		// The transport lane carried NO proposal rows.
		expect(
			sent.filter( ( update ) => 'proposal' === update.type )
		).toHaveLength( 0 );
	} );

	it( 'the response rows + dispositions settle the commit (hash advance)', async () => {
		let lastProposal: any = null;
		const { edit, bridge } = makeCommitSession( async ( update ) => {
			lastProposal = JSON.parse( update.data );
			return {
				updates: [
					{
						type: DE_RTC_ANNOUNCE_TYPE,
						data: JSON.stringify( {
							version: 'v2',
							baseVersion: 'v1',
							contentHash: hashDeRtcContent(
								lastProposal.proposedContent
							),
							authorClientId: Number(
								lastProposal.proposalId.split( '-' )[ 1 ]
							),
							proposalId: lastProposal.proposalId,
						} ),
					},
				],
				dispositions: [
					{
						intentId: lastProposal.proposalId,
						status: 'applied',
						version: 'v2',
					} as any,
				],
			};
		} );

		edit( [ BLOCK_B ] );
		await flush();

		// Settled: the bridge advanced to the committed version and the
		// next commit bases on it.
		expect( bridge.lastVersion() ).toBe( 'v2' );
	} );

	it( 'a poll-failure recovery while a commit is in flight must not orphan the commit', async () => {
		let resolveCommit: ( response: DeRtcCommitResponse ) => void = () => {};
		const commits: any[] = [];
		const { edit, bridge, session } = makeCommitSession( ( update ) => {
			commits.push( JSON.parse( update.data ) );
			return new Promise( ( resolve ) => {
				resolveCommit = resolve;
			} );
		} );

		edit( [ BLOCK_B ] );
		await flush();
		expect( commits ).toHaveLength( 1 );
		const proposal = commits[ 0 ];

		/*
		 * The polling transport lost a request that carried this session's
		 * advisory rows (a fetch) and asks for a recovery update. The
		 * in-flight commit rides the autosave endpoint, NOT the failed
		 * poll — recovery must not disturb it. (Refusing — throwing or
		 * not offering the hook — is fine: the transport then restores
		 * the exact lost rows, which are idempotent.)
		 */
		try {
			( session as any ).createRecoveryUpdate?.();
		} catch {
			// A refusal is a valid implementation.
		}

		// The commit's own response settles it as usual.
		resolveCommit( {
			updates: [
				{
					type: DE_RTC_ANNOUNCE_TYPE,
					data: JSON.stringify( {
						version: 'v2',
						baseVersion: 'v1',
						contentHash: hashDeRtcContent(
							proposal.proposedContent
						),
						authorClientId: Number(
							proposal.proposalId.split( '-' )[ 1 ]
						),
						proposalId: proposal.proposalId,
					} ),
				},
			],
			dispositions: [
				{
					intentId: proposal.proposalId,
					status: 'applied',
					version: 'v2',
				} as any,
			],
		} );
		await flush();
		expect( bridge.lastVersion() ).toBe( 'v2' );

		// The session is still live: the next edit commits.
		edit( [ BLOCK_A, BLOCK_B ] );
		await flush();
		expect( commits ).toHaveLength( 2 );
	} );

	it( 'a failed commit retries without losing edits', async () => {
		jest.useFakeTimers();
		let attempts = 0;
		const { edit, bridge } = makeCommitSession( async ( update ) => {
			attempts++;
			if ( 1 === attempts ) {
				throw new Error( 'network down' );
			}
			const proposal = JSON.parse( update.data );
			return {
				updates: [
					{
						type: DE_RTC_ANNOUNCE_TYPE,
						data: JSON.stringify( {
							version: 'v2',
							baseVersion: 'v1',
							contentHash: hashDeRtcContent(
								proposal.proposedContent
							),
							authorClientId: Number(
								proposal.proposalId.split( '-' )[ 1 ]
							),
							proposalId: proposal.proposalId,
						} ),
					},
				],
			};
		} );

		edit( [ BLOCK_B ] );
		await Promise.resolve();
		await Promise.resolve();
		expect( attempts ).toBe( 1 );

		// The retry timer re-proposes the same doc state.
		jest.advanceTimersByTime( 2500 );
		await Promise.resolve();
		await Promise.resolve();
		expect( attempts ).toBe( 2 );
		expect( bridge.lastVersion() ).toBe( 'v2' );
	} );
} );
