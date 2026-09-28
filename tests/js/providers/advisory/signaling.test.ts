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
 * The signaling lane rides `wp.heartbeat`: `heartbeat.send` carries this
 * tab's token (and any queued handshake messages), `heartbeat.tick`
 * brings back company, the discovered peers, and this tab's mailbox.
 */

type Hook = ( data: Record< string, unknown > ) => void;
const hooks: Record< string, Hook > = {};

jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn( ( hook: string, _ns: string, callback: Hook ) => {
		hooks[ hook ] = callback;
	} ),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

type Signaling = typeof import('../../../../src/providers/advisory/signaling');

function setSettings( advisory: Record< string, unknown > | null ): void {
	(
		window as { _gutenbergSyncEnginesSettings?: unknown }
	 )._gutenbergSyncEnginesSettings = advisory ? { advisory } : {};
}

describe( 'advisory signaling', () => {
	let signaling: Signaling;
	let connectNow: jest.Mock;

	beforeEach( () => {
		jest.useFakeTimers();
		connectNow = jest.fn();
		( window as { wp?: unknown } ).wp = {
			heartbeat: { interval: jest.fn(), connectNow },
		};
		setSettings( {
			room: 'postType/post:7',
			token: 'tok-b',
			othersPresent: false,
			leaveUrl:
				'https://example.test/wp-json/gutenberg-sync-engines/v1/advisory/leave',
			nonce: 'nonce-1',
		} );
		for ( const key of Object.keys( hooks ) ) {
			delete hooks[ key ];
		}
		jest.isolateModules( () => {
			signaling = require( '../../../../src/providers/advisory/signaling' );
		} );
	} );

	afterEach( () => {
		signaling.resetSignalingForTesting();
		jest.useRealTimers();
		delete ( window as { wp?: unknown } ).wp;
		setSettings( null );
	} );

	it( 'is unavailable without settings or without the heartbeat API', () => {
		expect( signaling.isSignalingAvailable() ).toBe( true );
		delete ( window as { wp?: unknown } ).wp;
		expect( signaling.isSignalingAvailable() ).toBe( false );
		( window as { wp?: unknown } ).wp = {
			heartbeat: { interval: jest.fn() },
		};
		setSettings( null );
		expect( signaling.isSignalingAvailable() ).toBe( false );
	} );

	it( 'stamps the room, token, client id, and queued signals on each beat', () => {
		signaling.installSignaling();
		signaling.setSyncClientId( 42 );
		signaling.sendSignal( 'tok-a', 'offer', 'sdp-offer' );

		const data: Record< string, unknown > = {};
		hooks[ 'heartbeat.send' ]( data );
		expect( data[ signaling.HEARTBEAT_DATA_KEY ] ).toEqual( {
			seq: 1,
			room: 'postType/post:7',
			token: 'tok-b',
			client_id: 42,
			signals: [
				{
					id: 'tok-b-1',
					to: 'tok-a',
					kind: 'offer',
					data: 'sdp-offer',
				},
			],
		} );

		// The outbox drains: the next beat carries no signals.
		const next: Record< string, unknown > = {};
		hooks[ 'heartbeat.send' ]( next );
		expect( next[ signaling.HEARTBEAT_DATA_KEY ] ).toEqual( {
			seq: 2,
			room: 'postType/post:7',
			token: 'tok-b',
			client_id: 42,
		} );
	} );

	it( 'asks the heartbeat to beat now when a signal is queued, once per burst', () => {
		signaling.installSignaling();
		signaling.sendSignal( 'tok-a', 'offer', 'o' );
		signaling.sendSignal( 'tok-a', 'ice', 'c' );
		expect( connectNow ).not.toHaveBeenCalled();
		jest.advanceTimersByTime( 50 );
		expect( connectNow ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'reads company, peers, and the mailbox from a tick and notifies listeners', () => {
		const onOthers = jest.fn();
		const onPeers = jest.fn();
		const onSignal = jest.fn();
		signaling.onOthersChanged( onOthers );
		signaling.onPeersChanged( onPeers );
		signaling.onSignal( onSignal );

		expect( signaling.othersPresent() ).toBe( false );
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: {
				others: true,
				peers: [ { token: 'tok-c', client_id: 9, user_id: 2 } ],
				signals: [ { from: 'tok-c', kind: 'answer', data: 'sdp' } ],
			},
		} );

		expect( signaling.othersPresent() ).toBe( true );
		expect( onOthers ).toHaveBeenCalledWith( true );
		expect( signaling.getDiscoveredPeers() ).toEqual( [
			{ token: 'tok-c', clientId: 9, userId: 2 },
		] );
		expect( onPeers ).toHaveBeenCalledTimes( 1 );
		expect( onSignal ).toHaveBeenCalledWith( {
			from: 'tok-c',
			kind: 'answer',
			data: 'sdp',
		} );

		// An unchanged peer list does not re-notify; a flip back does.
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: {
				others: true,
				peers: [ { token: 'tok-c', client_id: 9, user_id: 2 } ],
			},
		} );
		expect( onPeers ).toHaveBeenCalledTimes( 1 );
		expect( onOthers ).toHaveBeenCalledTimes( 1 );
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: { others: false, peers: [] },
		} );
		expect( onOthers ).toHaveBeenLastCalledWith( false );
		expect( signaling.getDiscoveredPeers() ).toEqual( [] );
	} );

	it( 'reports the room head cursor from each fresh answer', () => {
		const onCursor = jest.fn();
		signaling.onRoomCursor( onCursor );
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: {
				others: true,
				peers: [],
				cursor: 42,
			},
		} );
		expect( onCursor ).toHaveBeenCalledWith( 42 );
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: { others: true, peers: [] },
		} );
		expect( onCursor ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'ignores ticks without our key and malformed answers', () => {
		const onOthers = jest.fn();
		signaling.onOthersChanged( onOthers );
		hooks[ 'heartbeat.tick' ]( { wp_autosave: {} } );
		hooks[ 'heartbeat.tick' ]( {
			[ signaling.HEARTBEAT_DATA_KEY ]: { others: 'yes' },
		} );
		expect( onOthers ).not.toHaveBeenCalled();
		expect( signaling.othersPresent() ).toBe( false );
	} );

	it( 'starts out believing the page-render company flag', () => {
		setSettings( {
			room: 'postType/post:7',
			token: 'tok-b',
			othersPresent: true,
		} );
		expect( signaling.othersPresent() ).toBe( true );
	} );

	it( 'builds the same probe for a poll as for a beat, and prefers an active poll loop as the carrier', () => {
		signaling.setSyncClientId( 7 );
		signaling.sendSignal( 'tok-a', 'offer', 'o' );
		// An active loop takes the signals on its next poll: the heartbeat
		// is not beaten.
		const carrier = jest.fn( () => true );
		signaling.setSignalCarrier( carrier );
		jest.advanceTimersByTime( 50 );
		expect( carrier ).toHaveBeenCalledTimes( 1 );
		expect( connectNow ).not.toHaveBeenCalled();

		const probe = signaling.buildProbe();
		expect( probe ).toEqual( {
			seq: 1,
			room: 'postType/post:7',
			token: 'tok-b',
			client_id: 7,
			signals: [
				{ id: 'tok-b-1', to: 'tok-a', kind: 'offer', data: 'o' },
			],
		} );
		// Drained: the next probe carries none.
		expect( signaling.buildProbe() ).toEqual( {
			seq: 2,
			room: 'postType/post:7',
			token: 'tok-b',
			client_id: 7,
		} );

		// A quiet loop declines: the heartbeat beats instead.
		carrier.mockReturnValue( false );
		signaling.sendSignal( 'tok-a', 'ice', 'c' );
		jest.advanceTimersByTime( 50 );
		expect( connectNow ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'applies a poll-borne answer exactly like a heartbeat tick', () => {
		const onPeers = jest.fn();
		const onSignal = jest.fn();
		signaling.onPeersChanged( onPeers );
		signaling.onSignal( onSignal );
		signaling.applyAnswer( {
			others: true,
			peers: [ { token: 'tok-c', client_id: 9, user_id: 2 } ],
			signals: [ { from: 'tok-c', kind: 'offer', data: 'sdp' } ],
		} );
		expect( signaling.othersPresent() ).toBe( true );
		expect( onPeers ).toHaveBeenCalledTimes( 1 );
		expect( onSignal ).toHaveBeenCalledWith( {
			from: 'tok-c',
			kind: 'offer',
			data: 'sdp',
		} );
		// Anything else is ignored.
		signaling.applyAnswer( undefined );
		signaling.applyAnswer( 'nope' );
		expect( signaling.othersPresent() ).toBe( true );
	} );

	it( "keeps a probe's signals until its request is answered, and re-queues them when it fails", () => {
		signaling.installSignaling();
		signaling.sendSignal( 'tok-a', 'offer', 'o' );
		const probe = signaling.buildProbe()!;
		expect( probe.signals ).toHaveLength( 1 );

		// The request failed: the offer goes back to the front of the
		// outbox and the next carrier is asked for.
		signaling.probeFailed( probe.seq );
		jest.advanceTimersByTime( 50 );
		expect( connectNow ).toHaveBeenCalledTimes( 1 );
		const retry = signaling.buildProbe()!;
		expect( retry.signals ).toEqual( probe.signals );

		// Answered: gone for good.
		signaling.applyAnswer( { others: false, peers: [] }, retry.seq );
		signaling.probeFailed( retry.seq );
		expect( signaling.buildProbe()!.signals ).toBeUndefined();

		// A failed heartbeat re-queues too.
		signaling.sendSignal( 'tok-a', 'ice', 'c' );
		hooks[ 'heartbeat.send' ]( {} );
		hooks[ 'heartbeat.error' ]( {} );
		expect( signaling.buildProbe()!.signals ).toEqual( [
			{ id: 'tok-b-2', to: 'tok-a', kind: 'ice', data: 'c' },
		] );
	} );

	it( 'an answer older than the last applied one delivers its signals but leaves the peer list alone', () => {
		const onPeers = jest.fn();
		const onSignal = jest.fn();
		signaling.onPeersChanged( onPeers );
		signaling.onSignal( onSignal );
		const older = signaling.buildProbe()!;
		const newer = signaling.buildProbe()!;
		signaling.applyAnswer(
			{
				others: true,
				peers: [ { token: 'tok-c', client_id: 9, user_id: 2 } ],
			},
			newer.seq
		);
		expect( onPeers ).toHaveBeenCalledTimes( 1 );
		// The slow one arrives late with an empty peer list and a signal.
		signaling.applyAnswer(
			{
				others: false,
				peers: [],
				signals: [ { from: 'tok-c', kind: 'answer', data: 'sdp' } ],
			},
			older.seq
		);
		expect( onPeers ).toHaveBeenCalledTimes( 1 );
		expect( signaling.getDiscoveredPeers() ).toHaveLength( 1 );
		expect( signaling.othersPresent() ).toBe( true );
		expect( onSignal ).toHaveBeenCalledWith( {
			from: 'tok-c',
			kind: 'answer',
			data: 'sdp',
		} );
	} );

	it( 'sends the leave beacon once with the room, token, and client id', async () => {
		signaling.setSyncClientId( 7 );
		const sendBeacon = jest.fn( () => true );
		Object.defineProperty( navigator, 'sendBeacon', {
			configurable: true,
			value: sendBeacon,
		} );
		try {
			expect( signaling.sendLeaveBeacon() ).toBe( true );
			expect( signaling.sendLeaveBeacon() ).toBe( false );
			expect( sendBeacon ).toHaveBeenCalledTimes( 1 );
			const [ url ] = sendBeacon.mock.calls[ 0 ] as unknown as [
				string,
				Blob,
			];
			expect( url ).toContain( '/advisory/leave?_wpnonce=nonce-1' );
			// The session's client id rides along so the server can drop
			// this tab's own awareness entry at once.
			const [ , blob ] = sendBeacon.mock.calls[ 0 ] as unknown as [
				string,
				Blob,
			];
			const text = await new Promise< string >( ( resolve ) => {
				const reader = new FileReader();
				reader.onload = () => resolve( String( reader.result ) );
				reader.readAsText( blob );
			} );
			expect( text ).toBe(
				JSON.stringify( {
					room: 'postType/post:7',
					token: 'tok-b',
					client_id: 7,
				} )
			);
		} finally {
			delete ( navigator as { sendBeacon?: unknown } ).sendBeacon;
		}
	} );
} );
