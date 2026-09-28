/**
 * External dependencies
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import {
	websocketManager,
	resetWebSocketManagerForTesting,
} from '../../../../src/providers/websocket/websocket-manager';
import type { EngineSessionCodec } from '@wordpress/sync';

jest.mock( '@wordpress/api-fetch' );

jest.mock( '../../../../src/providers/http-polling/polling-manager', () => ( {
	pollingManager: {
		registerRoom: jest.fn(),
		releaseRoom: jest.fn( async () => ( { cursor: 0, unsent: [] } ) ),
		unregisterRoom: jest.fn(),
	},
} ) );
// The mocked module (jest.mock is hoisted above the imports).
const mockPolling = (
	require( '../../../../src/providers/http-polling/polling-manager' ) as {
		pollingManager: {
			registerRoom: jest.Mock;
			releaseRoom: jest.Mock;
			unregisterRoom: jest.Mock;
		};
	}
 ).pollingManager;

// A minimal fake WebSocket capturing sends and exposing lifecycle triggers.
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
	public send( data: string ): void {
		this.sent.push( data );
	}
	public close(): void {
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
	private emit( type: string, e: unknown ): void {
		( this.listeners[ type ] ?? [] ).forEach( ( cb ) => cb( e ) );
	}
}

function fakeSession(
	overrides: Partial< EngineSessionCodec > = {}
): EngineSessionCodec {
	let localListener: ( ( u: unknown ) => void ) | null = null;
	return {
		clientId: 101,
		engineSlug: 'intent-log',
		engineProtocol: 1,
		getInitialUpdates: () => [],
		onLocalUpdate: ( cb: ( u: unknown ) => void ) => {
			localListener = cb;
		},
		emitLocal: ( u: unknown ) => localListener?.( u ),
		receiveUpdate: jest.fn< ( update: unknown ) => undefined >(),
		receiveDispositions: jest.fn(),
		getLocalAwareness: () => ( {} ),
		applyRemoteAwareness: jest.fn(),
		destroy: jest.fn(),
		...overrides,
	} as unknown as EngineSessionCodec;
}

describe( 'websocket manager', () => {
	afterEach( () => {
		resetWebSocketManagerForTesting();
		FakeWebSocket.instances = [];
		delete (
			window as Window & {
				_wpCollaborationTransportConfig?: unknown;
			}
		 )._wpCollaborationTransportConfig;
		( apiFetch as unknown as jest.Mock ).mockReset();
		mockPolling.registerRoom.mockClear();
		mockPolling.releaseRoom.mockClear();
		mockPolling.releaseRoom.mockImplementation( async () => ( {
			cursor: 0,
			unsent: [],
		} ) );
		mockPolling.unregisterRoom.mockClear();
	} );

	const setup = () => {
		(
			window as Window & {
				_wpCollaborationTransportConfig?: unknown;
			}
		 )._wpCollaborationTransportConfig = {
			websocket: { url: 'ws://localhost:8787' },
		};
		( window as unknown as { WebSocket: unknown } ).WebSocket =
			FakeWebSocket as unknown;
		( apiFetch as unknown as jest.Mock ).mockResolvedValue( {
			token: 't0ken',
		} as never );
	};

	it( 'fetches a token, connects to the announced URL, and sends the initial sync', async () => {
		setup();
		const session = fakeSession();
		const onStatusChange = jest.fn();

		websocketManager.registerRoom( {
			room: 'postType/post:1',
			session,
			onStatusChange,
		} );
		// Let the token promise resolve.
		await Promise.resolve();
		await Promise.resolve();

		const ws = FakeWebSocket.instances[ 0 ];
		expect( ws ).toBeDefined();
		// The token rides the subprotocol offer, never the URL
		// (query strings land in server/proxy access logs).
		expect( ws.url ).not.toContain( 't0ken' );
		expect( ws.protocols ).toEqual( [ 'wp-sync', 'wp-sync-token.t0ken' ] );

		ws.open();
		expect( onStatusChange ).toHaveBeenCalledWith( {
			status: 'connected',
		} );
		// The initial sync frame carries the room, cursor, and engine stamp.
		const frame = JSON.parse( ws.sent[ 0 ] );
		expect( frame.type ).toBe( 'sync' );
		expect( frame.rooms[ 0 ] ).toMatchObject( {
			room: 'postType/post:1',
			after: 0,
			client_id: 101,
			engine: 'intent-log',
		} );
	} );

	it( 'feeds pushed updates to the codec and advances the cursor', async () => {
		setup();
		const receiveUpdate = jest.fn< ( update: unknown ) => undefined >();
		const session = fakeSession( {
			receiveUpdate,
		} as Partial< EngineSessionCodec > );

		websocketManager.registerRoom( {
			room: 'postType/post:1',
			session,
			onStatusChange: jest.fn(),
		} );
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.instances[ 0 ];
		ws.open();
		ws.sent = [];

		// The server pushes a peer's update.
		ws.receive( {
			type: 'sync',
			rooms: [
				{
					room: 'postType/post:1',
					awareness: { 2: {} },
					updates: [ { type: 'intent', data: 'AAAA' } ],
					end_cursor: 7,
				},
			],
		} );

		expect( receiveUpdate ).toHaveBeenCalledWith( {
			type: 'intent',
			data: 'AAAA',
		} );
		expect( session.applyRemoteAwareness ).toHaveBeenCalledWith( {
			2: {},
		} );

		// The next outgoing frame carries the advanced cursor.
		(
			session as unknown as { emitLocal: ( u: unknown ) => void }
		 ).emitLocal( { type: 'intent', data: 'BBBB' } );
		const frame = JSON.parse( ws.sent.at( -1 ) as string );
		expect( frame.rooms[ 0 ].after ).toBe( 7 );
		expect( frame.rooms[ 0 ].updates ).toEqual( [
			{ type: 'intent', data: 'BBBB' },
		] );
	} );

	it( "stamps this tab's presence token on its post's room frames", async () => {
		setup();
		(
			window as { _gutenbergSyncEnginesSettings?: unknown }
		 )._gutenbergSyncEnginesSettings = {
			advisory: { room: 'postType/post:1', token: 'tab-token' },
		};
		try {
			websocketManager.registerRoom( {
				room: 'postType/post:1',
				session: fakeSession(),
				onStatusChange: jest.fn(),
			} );
			await Promise.resolve();
			await Promise.resolve();
			const ws = FakeWebSocket.instances[ 0 ];
			ws.open();
			const frame = JSON.parse( ws.sent[ 0 ] );
			expect( frame.rooms[ 0 ].presence_token ).toBe( 'tab-token' );
		} finally {
			delete ( window as { _gutenbergSyncEnginesSettings?: unknown } )
				._gutenbergSyncEnginesSettings;
		}
	} );

	it( 'closes the socket when the last room unregisters', async () => {
		setup();
		websocketManager.registerRoom( {
			room: 'postType/post:1',
			session: fakeSession(),
			onStatusChange: jest.fn(),
		} );
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.instances[ 0 ];
		ws.open();

		websocketManager.unregisterRoom( 'postType/post:1' );
		expect( ws.readyState ).toBe( 3 );
	} );

	describe( 'preferred transport: short polling is the fallback', () => {
		it( 'parks the room with short polling when the token cannot be minted', async () => {
			setup();
			( apiFetch as unknown as jest.Mock ).mockRejectedValue(
				new Error( 'no token' ) as never
			);
			const session = fakeSession();
			const onStatusChange = jest.fn();
			websocketManager.registerRoom( {
				room: 'postType/post:1',
				session,
				onStatusChange,
			} );
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect( mockPolling.registerRoom ).toHaveBeenCalledTimes( 1 );
			expect(
				mockPolling.registerRoom.mock.calls[ 0 ][ 0 ]
			).toMatchObject( {
				room: 'postType/post:1',
				session,
				onStatusChange,
				initialCursor: 0,
			} );
			// Polling reports the status from here; the socket says nothing.
			expect( onStatusChange ).not.toHaveBeenCalledWith( {
				status: 'disconnected',
			} );
			expect( FakeWebSocket.instances ).toHaveLength( 0 );
		} );

		it( 'parks at the socket cursor on close, reclaims at the polling cursor on reopen, carrying unsent work', async () => {
			jest.useFakeTimers();
			try {
				setup();
				const session = fakeSession();
				const emitLocal = (
					session as unknown as {
						emitLocal: ( u: unknown ) => void;
					}
				 ).emitLocal;
				websocketManager.registerRoom( {
					room: 'postType/post:1',
					session,
					onStatusChange: jest.fn(),
				} );
				await Promise.resolve();
				await Promise.resolve();
				const ws = FakeWebSocket.instances[ 0 ];
				ws.open();
				ws.receive( {
					type: 'sync',
					rooms: [
						{
							room: 'postType/post:1',
							awareness: {},
							updates: [],
							end_cursor: 7,
						},
					],
				} );

				// The daemon drops: polling takes over at cursor 7.
				ws.close();
				expect( mockPolling.registerRoom ).toHaveBeenCalledTimes( 1 );
				expect(
					mockPolling.registerRoom.mock.calls[ 0 ][ 0 ]
				).toMatchObject( { initialCursor: 7 } );
				// The polling manager binds the session's local updates to
				// itself (the fake keeps the last listener): the socket no
				// longer sees them.
				const pollingBinding = jest.fn();
				session.onLocalUpdate( pollingBinding );
				emitLocal( { type: 'update', data: 'AA==' } );
				expect( pollingBinding ).toHaveBeenCalledTimes( 1 );

				// Reconnect succeeds: polling reached cursor 12 and never
				// sent one update, which rides the initial sync.
				mockPolling.releaseRoom.mockResolvedValueOnce( {
					cursor: 12,
					unsent: [ { type: 'update', data: 'QQ==' } ],
				} as never );
				await jest.advanceTimersByTimeAsync( 1000 );
				await Promise.resolve();
				await Promise.resolve();
				const ws2 = FakeWebSocket.instances[ 1 ];
				expect( ws2 ).toBeDefined();
				ws2.open();
				// The reclaim awaits the polling manager's release.
				await jest.advanceTimersByTimeAsync( 0 );
				expect( mockPolling.releaseRoom ).toHaveBeenCalledWith(
					'postType/post:1'
				);
				const frame = JSON.parse( ws2.sent[ 0 ] );
				expect( frame.rooms[ 0 ] ).toMatchObject( {
					room: 'postType/post:1',
					after: 12,
					updates: [ { type: 'update', data: 'QQ==' } ],
				} );

				// Local updates go to the socket again.
				emitLocal( { type: 'update', data: 'Yg==' } );
				expect( pollingBinding ).toHaveBeenCalledTimes( 1 );
				expect(
					JSON.parse( ws2.sent[ 1 ] ).rooms[ 0 ].updates
				).toEqual( [ { type: 'update', data: 'Yg==' } ] );
			} finally {
				jest.useRealTimers();
			}
		} );

		it( 'hands a room back to polling when the socket dies while the reclaim is waiting', async () => {
			jest.useFakeTimers();
			try {
				setup();
				const session = fakeSession();
				websocketManager.registerRoom( {
					room: 'postType/post:1',
					session,
					onStatusChange: jest.fn(),
				} );
				await Promise.resolve();
				await Promise.resolve();
				const ws = FakeWebSocket.instances[ 0 ];
				ws.open();
				ws.close(); // Parked at cursor 0.
				expect( mockPolling.registerRoom ).toHaveBeenCalledTimes( 1 );

				// Reconnect opens, but the release is slow and the socket
				// drops again before it resolves.
				let release!: ( v: unknown ) => void;
				mockPolling.releaseRoom.mockImplementationOnce(
					() =>
						new Promise( ( resolve ) => {
							release = resolve;
						} )
				);
				await jest.advanceTimersByTimeAsync( 1000 );
				const ws2 = FakeWebSocket.instances[ 1 ];
				ws2.open();
				await jest.advanceTimersByTimeAsync( 0 );
				ws2.close();
				release( {
					cursor: 6,
					unsent: [ { type: 'update', data: 'QQ==' } ],
				} );
				await jest.advanceTimersByTimeAsync( 0 );

				// Not bound to the dead socket: back with polling, at the
				// cursor polling reached, with the unsent work.
				expect( mockPolling.registerRoom ).toHaveBeenCalledTimes( 2 );
				expect(
					mockPolling.registerRoom.mock.calls[ 1 ][ 0 ]
				).toMatchObject( {
					initialCursor: 6,
					initialUpdates: [ { type: 'update', data: 'QQ==' } ],
				} );
				expect( ws2.sent ).toHaveLength( 0 );
			} finally {
				jest.useRealTimers();
			}
		} );

		it( 'parks the rooms after 5 s when a connection attempt hangs, and reclaims them if it opens later', async () => {
			jest.useFakeTimers();
			try {
				setup();
				const session = fakeSession();
				websocketManager.registerRoom( {
					room: 'postType/post:1',
					session,
					onStatusChange: jest.fn(),
				} );
				await Promise.resolve();
				await Promise.resolve();
				const ws = FakeWebSocket.instances[ 0 ];
				expect( ws ).toBeDefined();
				// The socket neither opens nor closes.
				await jest.advanceTimersByTimeAsync( 4999 );
				expect( mockPolling.registerRoom ).not.toHaveBeenCalled();
				await jest.advanceTimersByTimeAsync( 1 );
				expect( mockPolling.registerRoom ).toHaveBeenCalledTimes( 1 );
				expect(
					mockPolling.registerRoom.mock.calls[ 0 ][ 0 ]
				).toMatchObject( {
					room: 'postType/post:1',
					initialCursor: 0,
				} );

				// The attempt finally succeeds: the room comes back.
				mockPolling.releaseRoom.mockResolvedValueOnce( {
					cursor: 4,
					unsent: [],
				} as never );
				ws.open();
				await jest.advanceTimersByTimeAsync( 0 );
				expect( mockPolling.releaseRoom ).toHaveBeenCalledWith(
					'postType/post:1'
				);
				expect( JSON.parse( ws.sent[ 0 ] ).rooms[ 0 ] ).toMatchObject( {
					after: 4,
				} );
			} finally {
				jest.useRealTimers();
			}
		} );

		it( "hands a parked room's teardown to the polling manager", async () => {
			setup();
			( apiFetch as unknown as jest.Mock ).mockRejectedValue(
				new Error( 'no token' ) as never
			);
			const session = fakeSession();
			websocketManager.registerRoom( {
				room: 'postType/post:1',
				session,
				onStatusChange: jest.fn(),
			} );
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			websocketManager.unregisterRoom( 'postType/post:1' );
			expect( mockPolling.unregisterRoom ).toHaveBeenCalledWith(
				'postType/post:1'
			);
			expect( session.destroy ).not.toHaveBeenCalled();
		} );
	} );

	it( 'a changed room generation re-sends the initial sync from cursor 0 and skips the frame rows', async () => {
		setup();
		const initial = { type: 'sync_step1', data: 'AA==' };
		const session = fakeSession( {
			getInitialUpdates: () => [ initial ],
		} as Partial< EngineSessionCodec > ) as EngineSessionCodec & {
			onRoomRestart: jest.Mock;
		};
		session.onRoomRestart = jest.fn( () => 'rebootstrap' );
		websocketManager.registerRoom( {
			room: 'postType/post:1',
			session,
			onStatusChange: jest.fn(),
		} );
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.instances[ 0 ];
		ws.open();

		const row = { type: 'update', data: 'AQ==' };
		ws.receive( {
			type: 'sync',
			rooms: [
				{
					room: 'postType/post:1',
					awareness: {},
					updates: [ row ],
					end_cursor: 7,
					generation: 'g1',
				},
			],
		} );
		expect( session.receiveUpdate ).toHaveBeenCalledWith( row );

		const sentBefore = ws.sent.length;
		const genesis = { type: 'snapshot', data: 'Ag==' };
		ws.receive( {
			type: 'sync',
			rooms: [
				{
					room: 'postType/post:1',
					awareness: {},
					updates: [ genesis ],
					end_cursor: 12,
					generation: 'g2',
				},
			],
		} );
		expect( session.onRoomRestart ).toHaveBeenCalledWith( [ genesis ] );
		expect( session.receiveUpdate ).not.toHaveBeenCalledWith( genesis );
		expect( ws.sent.length ).toBe( sentBefore + 1 );
		const frame = JSON.parse( ws.sent[ ws.sent.length - 1 ] );
		expect( frame.rooms[ 0 ].after ).toBe( 0 );
		expect( frame.rooms[ 0 ].updates ).toEqual( [ initial ] );
	} );

	it( 'a session that declines to rejoin after a room restart is disconnected', async () => {
		setup();
		const session = fakeSession() as EngineSessionCodec & {
			onRoomRestart: jest.Mock;
		};
		session.onRoomRestart = jest.fn( () => 'disconnect' );
		const onStatusChange = jest.fn();
		websocketManager.registerRoom( {
			room: 'postType/post:1',
			session,
			onStatusChange,
		} );
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.instances[ 0 ];
		ws.open();
		const frame = ( generation: string ) => ( {
			type: 'sync',
			rooms: [
				{
					room: 'postType/post:1',
					awareness: {},
					updates: [],
					end_cursor: 1,
					generation,
				},
			],
		} );
		ws.receive( frame( 'g1' ) );
		ws.receive( frame( 'g2' ) );
		expect( onStatusChange ).toHaveBeenLastCalledWith( {
			status: 'disconnected',
			error: expect.objectContaining( {
				message: expect.stringContaining( 'restarted' ),
			} ),
		} );
		expect( session.destroy ).toHaveBeenCalled();
	} );
} );
