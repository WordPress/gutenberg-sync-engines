/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	areBlocksEqual,
	BLOCK_FIELD,
	createSyncChannel,
	suppressRealtimeSelection,
} from '../../../src/awareness/channels/sync-channel';
import type {
	AwarenessHost,
	AwarenessPeerState,
} from '../../../src/awareness/channels/sync-channel';
import { registerAwareness } from '../../../src/awareness/registry';
import {
	onLocalAwarenessChange,
	resetAnnounceForTesting,
} from '../../../src/providers/advisory/announce';

/**
 * A fake typed awareness: a local state, per-field equality checks, and a
 * subscriber list.
 */
function fakeAwareness() {
	const local: Record< string, unknown > = {};
	const subscribers: Array< ( states: AwarenessPeerState[] ) => void > = [];
	const host: AwarenessHost & {
		emit: ( states: AwarenessPeerState[] ) => void;
	} = {
		clientID: 1,
		setUp: jest.fn(),
		equalityFieldChecks: {},
		getLocalState: () => local,
		setLocalStateField: ( field, value ) => {
			local[ field ] = value;
		},
		onStateChange: ( callback ) => {
			subscribers.push( callback );
			return () => {
				subscribers.splice( subscribers.indexOf( callback ), 1 );
			};
		},
		emit: ( states ) => subscribers.forEach( ( cb ) => cb( states ) ),
	};
	return { host, local, subscribers };
}

const peer = (
	clientId: number,
	block: string | null | undefined,
	extra: Partial< AwarenessPeerState > = {}
): AwarenessPeerState => ( {
	clientId,
	isMe: false,
	isConnected: true,
	collaboratorInfo: {
		id: 100 + clientId,
		name: `User ${ clientId }`,
		avatar_urls: { '48': `https://a/${ clientId }` },
	},
	gseBlock: block,
	...extra,
} );

describe( 'sync channel', () => {
	it( 'treats absent and null blocks alike', () => {
		expect( areBlocksEqual( undefined, null ) ).toBe( true );
		expect( areBlocksEqual( 's1', 's1' ) ).toBe( true );
		expect( areBlocksEqual( 's1', 's2' ) ).toBe( false );
		expect( areBlocksEqual( 's1', undefined ) ).toBe( false );
	} );

	it( 'publishes the block as one awareness field', () => {
		const { host, local } = fakeAwareness();
		const channel = createSyncChannel( {
			awareness: host,
			onPeers: jest.fn(),
		} );

		channel.start();
		expect( host.setUp ).toHaveBeenCalled();

		// Each publish also tells the transport to carry the state now.
		resetAnnounceForTesting();
		const onChange = jest.fn();
		onLocalAwarenessChange( onChange );
		channel.publish( 's1' );
		expect( local[ BLOCK_FIELD ] ).toBe( 's1' );
		expect( onChange ).toHaveBeenCalledTimes( 1 );
		channel.publish( null );
		expect( local[ BLOCK_FIELD ] ).toBeNull();
		expect( onChange ).toHaveBeenCalledTimes( 2 );
		resetAnnounceForTesting();

		channel.stop();
		expect( local[ BLOCK_FIELD ] ).toBeUndefined();
	} );

	it( 'reports every connected peer’s block as one roster', () => {
		const { host } = fakeAwareness();
		const onPeers = jest.fn();
		const channel = createSyncChannel( { awareness: host, onPeers } );
		channel.start();

		host.emit( [
			peer( 1, 'mine', { isMe: true } ),
			peer( 2, 's1' ),
			peer( 3, undefined ),
			peer( 4, 's4', { isConnected: false } ),
		] );
		expect( onPeers ).toHaveBeenLastCalledWith( [
			{
				key: '2',
				identity: {
					userId: 102,
					name: 'User 2',
					avatarUrl: 'https://a/2',
				},
				block: 's1',
			},
			{
				key: '3',
				identity: {
					userId: 103,
					name: 'User 3',
					avatarUrl: 'https://a/3',
				},
				block: null,
			},
		] );

		// Peer 3 leaves; peer 4 reconnects.
		host.emit( [ peer( 2, 's2' ), peer( 4, 's4' ) ] );
		expect( onPeers ).toHaveBeenLastCalledWith( [
			expect.objectContaining( { key: '2', block: 's2' } ),
			expect.objectContaining( { key: '4', block: 's4' } ),
		] );
		channel.stop();
	} );

	it( 'suppresses the live cursor and restores the original setter', () => {
		const { host, local } = fakeAwareness();
		local.editorState = { selection: { type: 'cursor' } };
		const restore = suppressRealtimeSelection( host );
		expect( local.editorState ).toBeUndefined();
		host.setLocalStateField( 'editorState', 'x' );
		expect( local.editorState ).toBeUndefined();
		restore();
		host.setLocalStateField( 'editorState', 'x' );
		expect( local.editorState ).toBe( 'x' );
	} );

	it( 'installs the equality check on every registered instance', () => {
		const { host } = fakeAwareness();
		registerAwareness( 'postType/post', '7', host );
		expect( host.equalityFieldChecks?.[ BLOCK_FIELD ] ).toBe(
			areBlocksEqual
		);
		// Missing or falsy instances are ignored.
		registerAwareness( 'postType/post', '8', undefined );
	} );
} );
