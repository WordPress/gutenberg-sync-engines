/**
 * Edits made before the first sync response (issue #100). The editor shows
 * the SAVED post until the room answers, so a person's edit in that moment
 * was made on the saved post. When the room's first row is older than the
 * saved post (a save during the room's life), the first proposal must
 * declare the version that shows the saved post, not that first row: the
 * server would otherwise read the saved text as the person's own edit,
 * competing with the same text in the room, and set it aside.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

import { hashDeRtcContent } from '../../../../src/engines/de-rtc/descriptor';
import { createDeRtcEngine } from '../../../../src/engines/de-rtc/engine';
import {
	DE_RTC_ANNOUNCE_TYPE,
	DE_RTC_PROPOSAL_TYPE,
	DE_RTC_SNAPSHOT_TYPE,
	setDeRtcBurstQuietMsForTesting,
} from '../../../../src/engines/de-rtc/session';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

const BLOCK_A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const BLOCK_B = { name: 'core/paragraph', attributes: { content: 'Beta' } };
const BLOCK_C = { name: 'core/paragraph', attributes: { content: 'Gamma' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

const snapshotRow = (
	version: string,
	content: string,
	checkpoint = false
) => ( {
	type: DE_RTC_SNAPSHOT_TYPE,
	data: JSON.stringify( {
		version,
		content,
		...( checkpoint ? { checkpoint: true, checkpointId: 1 } : {} ),
	} ),
} );

const announceRow = ( version: string, contentHash: string ) => ( {
	type: DE_RTC_ANNOUNCE_TYPE,
	data: JSON.stringify( {
		version,
		baseVersion: 'v1',
		contentHash,
		authorClientId: 999,
		proposalId: `p-peer-${ version }`,
	} ),
} );

describe( 'de-rtc edits made before the first sync response', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		setDeRtcBurstQuietMsForTesting( 0 );
	} );

	afterEach( () => {
		setDeRtcBurstQuietMsForTesting( 500 );
		jest.useRealTimers();
	} );

	/**
	 * Opens a session on a saved post and edits it before the room answers.
	 *
	 * @param saved The saved post's content.
	 * @param held  The editor's blocks after the edit.
	 */
	function joinAndEdit( saved: string, held: unknown[] ) {
		const entity = createDeRtcEngine().createEntity( {
			syncConfig: {} as SyncConfig,
			// A type without a commit route: proposals ride the transport.
			objectType: 'postType/book',
			objectId: '1',
		} as any );
		entity.hydrate( { content: saved } as any, jest.fn() as any );
		const session = entity.createSession();
		const sent: Array< { type: string; data: string } > = [];
		session.onLocalUpdate( ( update: any ) => sent.push( update ) );
		entity.applyLocalChanges( { blocks: held } as any, 'editor', {} );
		const proposals = () =>
			sent
				.filter( ( update ) => DE_RTC_PROPOSAL_TYPE === update.type )
				.map( ( update ) => JSON.parse( update.data ) );
		return { entity, session, proposals };
	}

	it( 'declares the version that shows the saved post, once the first response has landed', () => {
		const saved = contentOf( BLOCK_B );
		const { session, proposals } = joinAndEdit( saved, [
			BLOCK_B,
			BLOCK_C,
		] );

		// The room began before the save: its first row is older than the
		// saved post, and the version the save made follows it.
		session.receiveUpdate( snapshotRow( 'v1', contentOf( BLOCK_A ) ) );
		session.receiveUpdate( announceRow( 'v2', hashDeRtcContent( saved ) ) );
		session.receiveUpdate( announceRow( 'v3', 'a-later-peer-edit' ) );
		expect( proposals() ).toHaveLength( 0 );

		jest.advanceTimersByTime( 1 );
		expect( proposals() ).toHaveLength( 1 );
		expect( proposals()[ 0 ].baseVersion ).toBe( 'v2' );
		expect( proposals()[ 0 ].proposedContent ).toBe(
			contentOf( BLOCK_B, BLOCK_C )
		);
	} );

	it( 'keeps the first row as the base when no later version shows the saved post', () => {
		const saved = contentOf( BLOCK_A );
		const { session, proposals } = joinAndEdit( saved, [
			BLOCK_A,
			BLOCK_C,
		] );

		session.receiveUpdate( snapshotRow( 'v1', saved ) );
		session.receiveUpdate( announceRow( 'v2', 'a-later-peer-edit' ) );
		jest.advanceTimersByTime( 1 );

		expect( proposals() ).toHaveLength( 1 );
		expect( proposals()[ 0 ].baseVersion ).toBe( 'v1' );
	} );

	it( 'drops the edits when the first row is a checkpoint and no version shows the saved post', () => {
		// Old history was compacted after the save: the checkpoint holds a
		// peer's unsaved text. Proposing the edits on it would read that
		// text as deleted.
		const saved = contentOf( BLOCK_A );
		const { entity, session, proposals } = joinAndEdit( saved, [
			BLOCK_A,
			BLOCK_C,
		] );

		session.receiveUpdate(
			snapshotRow( 'v7', contentOf( BLOCK_B ), true )
		);
		jest.advanceTimersByTime( 1 );

		expect( proposals() ).toHaveLength( 0 );
		// The editor shows the checkpoint, not the dropped edits.
		const blocks = ( entity.getEditorChanges( {} as any ) as any ).blocks;
		expect(
			blocks.map( ( block: any ) => block.attributes.content )
		).toEqual( [ 'Beta' ] );
	} );
} );
