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
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import * as channel from '../../../../src/providers/advisory/channel';
import * as signaling from '../../../../src/providers/advisory/signaling';
import * as announce from '../../../../src/providers/advisory/announce';

/**
 * The advisory channel over its WebSocket link: one socket to the sync
 * daemon, which relays presence and notices between the tabs in a room.
 * The daemon is a fake socket here; the frames it sends are the ones
 * `includes/transports/websocket/class-wp-websocket-sync-server.php`
 * sends (see tests/phpunit/wpWebSocketAdvisory.php).
 */

jest.mock( '@wordpress/api-fetch' );

jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn(),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static OPEN = 1;
	public readyState = 0;
	public sent: string[] = [];
	private listeners: Record< string, ( ( e: unknown ) => void )[] > = {};

	public constructor(
		public url: string,
		public protocols?: string[]
	) {
		FakeWebSocket.instances.push( this );
	}
	public addEventListener( type: string, cb: ( e: unknown ) => void ): void {
		( this.listeners[ type ] ??= [] ).push( cb );
	}
	public removeEventListener(
		type: string,
		cb: ( e: unknown ) => void
	): void {
		this.listeners[ type ] = ( this.listeners[ type ] ?? [] ).filter(
			( listener ) => listener !== cb
		);
	}
	public send( data: string ): void {
		if ( FakeWebSocket.OPEN !== this.readyState ) {
			throw new Error( 'not open' );
		}
		this.sent.push( data );
	}
	public close(): void {
		if ( 3 === this.readyState ) {
			return;
		}
		this.readyState = 3;
		this.emit( 'close', {} );
	}
	public open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit( 'open', {} );
	}
	public receive( data: unknown ): void {
		this.emit( 'message', { data: JSON.stringify( data ) } );
	}
	public frames(): Array< Record< string, unknown > > {
		return this.sent.splice( 0 ).map( ( raw ) => JSON.parse( raw ) );
	}
	private emit( type: string, e: unknown ): void {
		( this.listeners[ type ] ?? [] ).forEach( ( cb ) => cb( e ) );
	}
}

const ROOM = 'postType/post:7';
const URL = 'ws://localhost:8787';

function settings( extra: Record< string, unknown > = {} ) {
	signaling.setAdvisorySettingsForTesting( {
		room: ROOM,
		token: 'tok-a',
		channel: 'websocket-advisory',
		socketUrl: URL,
		...extra,
	} as signaling.AdvisorySettings );
	signaling.setSyncClientId( 1 );
}

/**
 * Starts the channel and lets the token fetch resolve; returns the socket.
 */
async function start(): Promise< FakeWebSocket > {
	channel.startAdvisoryChannel();
	await jest.advanceTimersByTimeAsync( 0 );
	const ws = FakeWebSocket.instances.at( -1 );
	expect( ws ).toBeDefined();
	return ws!;
}

function roster(
	ws: FakeWebSocket,
	peers: Array< { client_id: number; token?: string; presence?: unknown } >
): void {
	ws.receive( { type: 'advisory', event: 'roster', room: ROOM, peers } );
}

describe( 'advisory channel over the websocket link', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		( window as { wp?: unknown } ).wp = {
			heartbeat: { interval: jest.fn(), connectNow: jest.fn() },
		};
		( window as unknown as { WebSocket: unknown } ).WebSocket =
			FakeWebSocket;
		( apiFetch as unknown as jest.Mock ).mockResolvedValue( {
			token: 't0ken',
		} as never );
		FakeWebSocket.instances = [];
	} );

	afterEach( () => {
		channel.resetAdvisoryChannelForTesting();
		signaling.resetSignalingForTesting();
		announce.resetAnnounceForTesting();
		jest.useRealTimers();
		( apiFetch as unknown as jest.Mock ).mockReset();
		delete ( window as { wp?: unknown } ).wp;
	} );

	it( 'opens a socket with the one-time token and follows its post room', async () => {
		settings();
		const ws = await start();

		// The credential is requested for this tab's post room (in access token
		// mode the access token allows exactly that room), and rides the
		// subprotocol offer, never the URL.
		expect( apiFetch ).toHaveBeenCalledWith( {
			method: 'POST',
			path: '/wp-sync/v1/ws-token',
			data: { room: ROOM },
		} );
		expect( ws.url ).toBe( URL );
		expect( ws.protocols ).toEqual( [ 'wp-sync', 'wp-sync-token.t0ken' ] );
		expect( channel.getAdvisoryDebugState() ).toMatchObject( {
			channel: 'websocket-advisory',
			socket: 'connecting',
		} );

		ws.open();
		expect( ws.frames() ).toEqual( [
			{
				type: 'advisory',
				room: ROOM,
				client_id: 1,
				presence_token: 'tok-a',
			},
		] );
		expect( channel.isAdvisoryActive() ).toBe( true );
		// Nobody known yet: "alone" is the transports' call.
		expect( channel.advisoryCoversClients( [ 1 ] ) ).toBe( false );
	} );

	it( 'overlays the roster as presence, covers exactly the tabs the daemon lists, and polls on a notice', async () => {
		settings();
		const presenceAt = jest.fn();
		const announced = jest.fn();
		const coverage = jest.fn();
		channel.onAdvisoryPresence( presenceAt );
		channel.onAdvisoryAnnounce( announced );
		channel.onAdvisoryCoverageChanged( coverage );
		const ws = await start();
		ws.open();

		roster( ws, [
			{ client_id: 1, token: 'tok-a', presence: null },
			{ client_id: 2, token: 'tok-b', presence: { name: 'B' } },
		] );
		expect( channel.getChannelPresence( ROOM ) ).toEqual( {
			2: { name: 'B' },
		} );
		expect( presenceAt ).toHaveBeenCalledWith( ROOM );
		expect( coverage ).toHaveBeenCalled();
		expect( channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
		// A client id nobody on the roster claims is not covered.
		expect( channel.advisoryCoversClients( [ 1, 2, 3 ] ) ).toBe( false );

		// Discovered tabs are covered by token.
		signaling.applyAnswer( {
			others: true,
			peers: [ { token: 'tok-b', client_id: 2, user_id: 1 } ],
			signals: [],
		} );
		expect( channel.advisoryCoversClients( [ 2 ] ) ).toBe( true );
		signaling.applyAnswer( {
			others: true,
			peers: [
				{ token: 'tok-b', client_id: 2, user_id: 1 },
				{ token: 'tok-c', client_id: 0, user_id: 1 },
			],
			signals: [],
		} );
		expect( channel.advisoryCoversClients( [ 2 ] ) ).toBe( false );

		// A notice names the room to poll.
		ws.receive( { type: 'advisory', event: 'announce', room: ROOM } );
		expect( announced ).toHaveBeenCalledWith( ROOM );

		// A peer that left the roster loses its presence and coverage.
		signaling.applyAnswer( { others: true, peers: [], signals: [] } );
		roster( ws, [ { client_id: 1, token: 'tok-a', presence: null } ] );
		expect( channel.getChannelPresence( ROOM ) ).toEqual( {} );
		expect( channel.advisoryCoversClients( [ 2 ] ) ).toBe( false );
	} );

	it( 'sends presence when it changes and announces local writes on the post room', async () => {
		settings();
		const ws = await start();
		ws.open();
		ws.frames();
		channel.setPresenceSource( () => [
			{ room: ROOM, clientId: 1, state: { name: 'A' } },
			{ room: 'root/site', clientId: 5, state: { name: 'A' } },
		] );

		await jest.advanceTimersByTimeAsync( 250 );
		expect( ws.frames() ).toEqual( [
			{
				type: 'advisory',
				room: ROOM,
				client_id: 1,
				presence_token: 'tok-a',
				presence: { name: 'A' },
			},
			{
				type: 'advisory',
				room: 'root/site',
				client_id: 5,
				presence: { name: 'A' },
			},
		] );
		// Unchanged presence is not re-sent.
		await jest.advanceTimersByTimeAsync( 500 );
		expect( ws.frames() ).toEqual( [] );

		// A write to a followed room is announced on that room; a write
		// whose room is unknown (`*`) rides the post room.
		announce.announceLocalWrite( 'root/site' );
		announce.announceLocalWrite();
		expect( ws.frames() ).toEqual( [
			{
				type: 'advisory',
				room: 'root/site',
				client_id: 5,
				announce: 'root/site',
			},
			{
				type: 'advisory',
				room: ROOM,
				client_id: 1,
				presence_token: 'tok-a',
				announce: '*',
			},
		] );
	} );

	it( 'reconnects with backoff after a drop and replays its presence; stays closed while the transport disables it', async () => {
		settings();
		const coverage = jest.fn();
		channel.onAdvisoryCoverageChanged( coverage );
		const first = await start();
		first.open();
		channel.setPresenceSource( () => [
			{ room: ROOM, clientId: 1, state: { name: 'A' } },
		] );
		await jest.advanceTimersByTimeAsync( 250 );
		roster( first, [
			{ client_id: 1, token: 'tok-a' },
			{ client_id: 2, token: 'tok-b', presence: { name: 'B' } },
		] );
		expect( channel.advisoryCoversClients( [ 2 ] ) ).toBe( true );

		// The socket drops: no coverage, no presence, a retry after 1 s.
		coverage.mockClear();
		first.close();
		expect( coverage ).toHaveBeenCalled();
		expect( channel.advisoryCoversClients( [ 2 ] ) ).toBe( false );
		expect( channel.getChannelPresence( ROOM ) ).toEqual( {} );
		expect( FakeWebSocket.instances ).toHaveLength( 1 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( FakeWebSocket.instances ).toHaveLength( 2 );
		const second = FakeWebSocket.instances[ 1 ];
		second.open();
		// The follow, then the presence the channel last sent.
		expect( second.frames() ).toEqual( [
			{
				type: 'advisory',
				room: ROOM,
				client_id: 1,
				presence_token: 'tok-a',
			},
			{
				type: 'advisory',
				room: ROOM,
				client_id: 1,
				presence_token: 'tok-a',
				presence: { name: 'A' },
			},
		] );

		// A stream transport switches the channel off: the socket closes and
		// nothing reconnects; switching it back on reconnects at once.
		channel.setAdvisoryDisabledByTransport( true );
		expect( second.readyState ).toBe( 3 );
		expect( channel.isAdvisoryActive() ).toBe( false );
		await jest.advanceTimersByTimeAsync( 60000 );
		expect( FakeWebSocket.instances ).toHaveLength( 2 );
		channel.setAdvisoryDisabledByTransport( false );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( FakeWebSocket.instances ).toHaveLength( 3 );

		// The tab going away closes the socket at once (the daemon drops
		// it from the rosters); a tab restored from the back-forward cache
		// comes back on the pending retry.
		FakeWebSocket.instances[ 2 ].open();
		window.dispatchEvent( new Event( 'pagehide' ) );
		expect( FakeWebSocket.instances[ 2 ].readyState ).toBe( 3 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( FakeWebSocket.instances ).toHaveLength( 4 );

		// Stopping says goodbye by closing the socket, for good.
		FakeWebSocket.instances[ 3 ].open();
		channel.stopAdvisoryChannel();
		expect( FakeWebSocket.instances[ 3 ].readyState ).toBe( 3 );
		await jest.advanceTimersByTimeAsync( 60000 );
		expect( FakeWebSocket.instances ).toHaveLength( 4 );
	} );

	it( 'retries when the token cannot be fetched', async () => {
		settings();
		( apiFetch as unknown as jest.Mock ).mockRejectedValueOnce(
			new Error( 'offline' ) as never
		);
		channel.startAdvisoryChannel();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( FakeWebSocket.instances ).toHaveLength( 0 );
		expect( channel.isAdvisoryActive() ).toBe( true );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( FakeWebSocket.instances ).toHaveLength( 1 );
	} );

	it( 'stays inert without a socket URL', () => {
		settings( { socketUrl: undefined } );
		channel.startAdvisoryChannel();
		expect( channel.isAdvisoryActive() ).toBe( false );
		expect( FakeWebSocket.instances ).toHaveLength( 0 );
		expect( channel.getAdvisoryDebugState().channel ).toBe(
			'websocket-advisory'
		);
	} );
} );
