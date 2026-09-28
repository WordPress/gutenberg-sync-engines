/**
 * External dependencies
 */
import { beforeEach, describe, expect, it } from '@jest/globals';

/**
 * WordPress dependencies
 */
import { createRegistry } from '@wordpress/data';

/**
 * Internal dependencies
 */
import { getPeerColor } from '../../../src/awareness/colors';
import { store } from '../../../src/awareness/store';
import type { PeerReport } from '../../../src/awareness/types';

const riley = { userId: 2, name: 'Riley', avatarUrl: 'https://a/riley' };
const sam = { userId: 3, name: 'Sam' };
const kim = { userId: 4, name: 'Kim' };

const report = (
	key: string,
	identity: PeerReport[ 'identity' ],
	block: string | null
): PeerReport => ( { key, identity, block } );

describe( 'awareness store', () => {
	let registry: ReturnType< typeof createRegistry >;

	beforeEach( () => {
		registry = createRegistry();
		registry.register( store );
	} );

	it( 'finds a block’s peer by syncId or by clientId, colored by user', () => {
		const { setPeers } = registry.dispatch( store );
		const { getPeersForBlock, getPeers } = registry.select( store );

		setPeers( [
			report( '10', riley, 's1' ),
			report( '11', sam, 'c-plain' ),
		] );

		expect( getPeersForBlock( 's1', 'c1' )[ 0 ]?.identity.name ).toBe(
			'Riley'
		);
		expect( getPeersForBlock( 's1', 'c1' )[ 0 ]?.color ).toBe(
			getPeerColor( 2, 10 )
		);
		expect(
			getPeersForBlock( undefined, 'c-plain' )[ 0 ]?.identity.name
		).toBe( 'Sam' );
		expect( getPeersForBlock( 's9', 'c9' ) ).toEqual( [] );
		expect( getPeers().map( ( peer ) => peer.key ) ).toEqual( [
			'10',
			'11',
		] );
	} );

	it( 'moves a peer between blocks and drops peers missing from the roster', () => {
		const { setPeers } = registry.dispatch( store );
		const { getPeersForBlock, getPeers } = registry.select( store );

		setPeers( [ report( '10', riley, 's1' ), report( '11', sam, 's3' ) ] );
		setPeers( [ report( '10', riley, 's2' ) ] );
		expect( getPeersForBlock( 's1', 'c1' ) ).toEqual( [] );
		expect( getPeersForBlock( 's2', 'c2' )[ 0 ]?.key ).toBe( '10' );
		expect( getPeersForBlock( 's3', 'c3' ) ).toEqual( [] );
		expect( getPeers() ).toHaveLength( 1 );

		// In no block at all: present, but drawn nowhere.
		setPeers( [ report( '10', riley, null ) ] );
		expect( getPeersForBlock( 's2', 'c2' ) ).toEqual( [] );
		expect( getPeers() ).toHaveLength( 1 );
	} );

	it( 'keeps object identity when nothing changed', () => {
		const { setPeers } = registry.dispatch( store );
		const { getPeersForBlock, getPeers } = registry.select( store );

		setPeers( [ report( '10', riley, 's1' ) ] );
		const before = getPeersForBlock( 's1', 'c1' );
		const peersBefore = getPeers();
		setPeers( [ report( '10', { ...riley }, 's1' ) ] );
		expect( getPeersForBlock( 's1', 'c1' ) ).toBe( before );
		expect( getPeers() ).toBe( peersBefore );

		setPeers( [ report( '10', { ...riley, name: 'Riley R.' }, 's1' ) ] );
		expect( getPeersForBlock( 's1', 'c1' ) ).not.toBe( before );
		// An empty block always answers with the same array.
		expect( getPeersForBlock( 's9', 'c9' ) ).toBe(
			getPeersForBlock( 's8', 'c8' )
		);
	} );

	it( 'orders the peers in one block by who entered it first', () => {
		const { setPeers, reset } = registry.dispatch( store );
		const { getPeersForBlock, getPeers } = registry.select( store );
		const keys = () =>
			getPeersForBlock( 's1', 'c1' ).map( ( peer ) => peer.key );

		// Sam is known first, but Riley enters s1 first.
		setPeers( [ report( '11', sam, 's2' ) ] );
		setPeers( [ report( '11', sam, 's2' ), report( '10', riley, 's1' ) ] );
		setPeers( [ report( '11', sam, 's1' ), report( '10', riley, 's1' ) ] );
		setPeers( [
			report( '11', sam, 's1' ),
			report( '10', riley, 's1' ),
			report( '12', kim, 's1' ),
		] );
		expect( keys() ).toEqual( [ '10', '11', '12' ] );

		// A repeated roster, or a renamed peer, keeps everyone's place.
		setPeers( [
			report( '11', sam, 's1' ),
			report( '10', { ...riley, name: 'Riley R.' }, 's1' ),
			report( '12', kim, 's1' ),
		] );
		expect( keys() ).toEqual( [ '10', '11', '12' ] );

		// Leaving and coming back puts the peer at the end.
		setPeers( [
			report( '11', sam, 's1' ),
			report( '10', riley, 's2' ),
			report( '12', kim, 's1' ),
		] );
		expect( keys() ).toEqual( [ '11', '12' ] );
		setPeers( [
			report( '11', sam, 's1' ),
			report( '10', riley, 's1' ),
			report( '12', kim, 's1' ),
		] );
		expect( keys() ).toEqual( [ '11', '12', '10' ] );

		// A peer who drops off the channel entirely leaves the stack.
		setPeers( [ report( '10', riley, 's1' ), report( '12', kim, 's1' ) ] );
		expect( keys() ).toEqual( [ '12', '10' ] );

		reset();
		expect( getPeers() ).toEqual( [] );
	} );
} );
