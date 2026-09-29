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
import {
	type SyncPayload,
	type SyncResponse,
	type SyncUpdate,
} from '../../../../src/providers/http-polling/types';
import { createIntentLogSession } from '../../../../src/engines/intent-log-session';

// Mock all external dependencies before imports.
jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn(),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

jest.mock( '../../../../src/providers/http-polling/config', () => ( {
	...( jest.requireActual(
		'../../../../src/providers/http-polling/config'
	) as object ),
	MAX_UPDATE_SIZE_IN_BYTES: 2048,
	// Shrink the per-request room cap so rotation tests don't need 50+
	// registered rooms. Existing tests register at most 2 rooms and
	// stay well under this cap.
	MAX_ROOMS_PER_REQUEST: 10,
	MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES: 1000,
	// Keep the dynamic-shrink floor below MAX so the halving logic in the
	// 413 retry path has room to actually halve.
	MIN_SYNC_REQUEST_BODY_SIZE_IN_BYTES: 100,
} ) );

const mockSseExchange = {
	available: true,
	close: jest.fn(),
	isOpen: jest.fn( () => false ),
	exchange:
		jest.fn<
			( payload: unknown, signal?: AbortSignal ) => Promise< unknown >
		>(),
};
jest.mock( '../../../../src/providers/sse/sse-exchange', () => ( {
	SseExchange: jest.fn( () => mockSseExchange ),
} ) );

jest.mock( '../../../../src/providers/http-polling/utils', () => ( {
	...( jest.requireActual(
		'../../../../src/providers/http-polling/utils'
	) as object ),
	postSyncUpdate: jest.fn(),
	postSyncUpdateNonBlocking: jest.fn(),
} ) );

interface PollingManager {
	registerRoom: ( options: {
		room: string;
		session: unknown;
		log: () => void;
		onStatusChange: () => void;
	} ) => void;
	unregisterRoom: (
		room: string,
		options?: { sendDisconnectSignal?: boolean }
	) => void;
}

function createDeferred< T >() {
	let resolve!: ( value: T ) => void;
	const promise = new Promise< T >( ( res ) => {
		resolve = res;
	} );
	return { promise, resolve };
}

/**
 * Base64-encode `sizeInBytes` zero bytes, mirroring the wire encoding of a
 * real update payload of that raw size.
 *
 * @param sizeInBytes Raw payload size to encode.
 */
function encodeMockData( sizeInBytes: number ): string {
	return globalThis.btoa( '\0'.repeat( sizeInBytes ) );
}

/**
 * A wire-shaped local update of the given raw payload size.
 *
 * @param sizeInBytes Raw payload size of the mock update.
 */
function createMockUpdate( sizeInBytes: number ): SyncUpdate {
	return { data: encodeMockData( sizeInBytes ), type: 'update' };
}

// Mock engine session codec handed to registerRoom. The initial update
// mirrors the Yjs codec's single sync_step1 announcement (1 payload byte,
// matching the previously mocked y-protocols encoder output).
function createMockSession( clientId = 1 ) {
	return {
		applyRemoteAwareness: jest.fn(),
		clientId,
		createCompactionUpdate: jest.fn( () => ( {
			data: '',
			type: 'compaction',
		} ) ),
		// Mirrors the Yjs codec: full-state recovery for unknown outcomes.
		createRecoveryUpdate: jest.fn( () => ( {
			data: '',
			type: 'compaction',
		} ) ),
		destroy: jest.fn(),
		getInitialUpdates: jest.fn( () => [
			{ data: encodeMockData( 1 ), type: 'sync_step1' },
		] ),
		getLocalAwareness: jest.fn( () => ( {} ) ),
		onLocalUpdate: jest.fn(),
		receiveUpdate: jest.fn(),
	};
}

// Helper to extract the local-update listener attached via session.onLocalUpdate.
function getOnLocalUpdate( session: ReturnType< typeof createMockSession > ) {
	const call = session.onLocalUpdate.mock.calls[ 0 ];
	if ( ! call ) {
		throw new Error( 'onLocalUpdate listener not registered' );
	}
	return call[ 0 ] as ( update: SyncUpdate, sizeInBytes: number ) => void;
}

function simulateVisibilityChange( state: string ) {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => state,
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );
}

const syncResponse = {
	rooms: [
		{
			room: 'test-room',
			end_cursor: 1,
			awareness: {},
			updates: [],
		},
	],
};

function countOutgoingUpdates( payload: {
	rooms: Array< { updates: unknown[] } >;
} ): number {
	return payload.rooms.reduce(
		( total, room ) => total + room.updates.length,
		0
	);
}

function getPayloadSize( payload: unknown ): number {
	return JSON.stringify( payload ).length;
}

function getServerAwareness(
	room: string
): SyncResponse[ 'rooms' ][ number ][ 'awareness' ] {
	return room === 'room-0' ? { 1: {}, 2: {} } : {};
}

describe( 'polling-manager', () => {
	let pollingManager: PollingManager;
	let mockPostSyncUpdate: jest.Mock<
		typeof import('../../../../src/providers/http-polling/utils').postSyncUpdate
	>;
	let mockPostSyncUpdateNonBlocking: jest.Mock<
		typeof import('../../../../src/providers/http-polling/utils').postSyncUpdateNonBlocking
	>;
	let mockApplyFilters: jest.Mock;
	let setSseMode: ( enabled: boolean ) => void;
	let flushHeldUpdates: () => Promise< void >;
	let inspector: typeof import('../../../../src/providers/http-polling/../../../src/debug/inspector').syncDebugApi;

	beforeEach( () => {
		jest.useFakeTimers();

		// Use isolateModules so each test gets fresh module-level state
		// (isPolling, pollingTimeoutId, roomStates, etc.).
		jest.isolateModules( () => {
			const managerModule = require( '../../../../src/providers/http-polling/polling-manager' );
			pollingManager = managerModule.pollingManager;
			setSseMode = managerModule.setSseMode;
			flushHeldUpdates = managerModule.flushHeldUpdates;
			mockPostSyncUpdate =
				require( '../../../../src/providers/http-polling/utils' ).postSyncUpdate;
			mockPostSyncUpdateNonBlocking =
				require( '../../../../src/providers/http-polling/utils' ).postSyncUpdateNonBlocking;
			mockApplyFilters = require( '@wordpress/hooks' ).applyFilters;
			// Same isolated registry as the polling manager: the inspector
			// buffer must be the instance the tap writes to.
			inspector =
				require( '../../../../src/debug/inspector' ).syncDebugApi;
		} );
	} );

	afterEach( () => {
		jest.clearAllTimers();
		jest.useRealTimers();
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
	} );

	describe( 'document size limit', () => {
		it( 'emits document-size-limit-exceeded error when an update exceeds the size limit', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );

			const onStatusChange = jest.fn();
			const session = createMockSession( 1 );

			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange,
			} );

			// Simulate a local update that exceeds the mocked MAX_UPDATE_SIZE_IN_BYTES (2048).
			const onLocalUpdate = getOnLocalUpdate( session );
			onLocalUpdate( createMockUpdate( 11 ), 2049 );

			expect( onStatusChange ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'document-size-limit-exceeded',
				} ),
			} );
		} );

		it( 'unregisters the room when the limit is exceeded', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );

			const session = createMockSession( 1 );

			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			const onLocalUpdate = getOnLocalUpdate( session );
			onLocalUpdate( createMockUpdate( 11 ), 2049 );

			// unregisterRoom sends a disconnect signal via postSyncUpdateNonBlocking.
			expect( mockPostSyncUpdateNonBlocking ).toHaveBeenCalledWith(
				expect.objectContaining( {
					rooms: expect.arrayContaining( [
						expect.objectContaining( {
							room: 'test-room',
							awareness: null,
						} ),
					] ),
				} )
			);

			// The session's transport subscriptions should be detached.
			expect( session.destroy ).toHaveBeenCalled();
		} );

		it( 'does not trigger for updates within the size limit', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );

			const onStatusChange = jest.fn();
			const session = createMockSession( 1 );

			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange,
			} );

			// Flush the initial poll so 'connected' status is emitted first.
			await jest.advanceTimersByTimeAsync( 0 );
			onStatusChange.mockClear();

			// Send an update within the limit (10 bytes).
			const onLocalUpdate = getOnLocalUpdate( session );
			onLocalUpdate( createMockUpdate( 10 ), 2048 );

			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					status: 'disconnected',
					error: expect.objectContaining( {
						code: 'document-size-limit-exceeded',
					} ),
				} )
			);
		} );
	} );

	describe( 'connection limits', () => {
		it( 'disconnects when clients exceed limit on first poll of first room', async () => {
			// DEFAULT_CLIENT_LIMIT_PER_ROOM is 3. 4 clients should exceed it.
			const awareness = {
				1: { collaboratorInfo: { id: 100 } },
				2: { collaboratorInfo: { id: 200 } },
				3: { collaboratorInfo: { id: 300 } },
				4: { collaboratorInfo: { id: 400 } },
			};

			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness,
						updates: [],
					},
				],
			} );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( onStatusChange ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'connection-limit-exceeded',
				} ),
			} );
		} );

		it( 'allows connection when clients are at or under the limit', async () => {
			// DEFAULT_CLIENT_LIMIT_PER_ROOM is 3. 3 clients should be fine.
			const awareness = {
				1: { collaboratorInfo: { id: 100 } },
				2: { collaboratorInfo: { id: 200 } },
				3: { collaboratorInfo: { id: 300 } },
			};

			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness,
						updates: [],
					},
				],
			} );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.objectContaining( {
						code: 'connection-limit-exceeded',
					} ),
				} )
			);
		} );

		it( 'does not enforce limits on the second registered room', async () => {
			// Register a first room (which consumes the enforceConnectionLimit flag).
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'first-room',
						end_cursor: 1,
						awareness: { 1: {} },
						updates: [],
					},
				],
			} );

			pollingManager.registerRoom( {
				room: 'first-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			// Now register a second room with many clients — should not disconnect.
			const awarenessMany = {
				1: {},
				2: {},
				3: {},
				4: {},
				5: {},
			};

			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'first-room',
						end_cursor: 2,
						awareness: { 1: {} },
						updates: [],
					},
					{
						room: 'second-room',
						end_cursor: 1,
						awareness: awarenessMany,
						updates: [],
					},
				],
			} );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'second-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 1000 );

			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.objectContaining( {
						code: 'connection-limit-exceeded',
					} ),
				} )
			);
		} );

		it( 'does not re-check limits after initial sync', async () => {
			// First poll: 3 clients (at limit, passes).
			const awareness3 = {
				1: {},
				2: {},
				3: {},
			};
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: awareness3,
						updates: [],
					},
				],
			} );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			// First poll passes.
			await jest.advanceTimersByTimeAsync( 0 );
			onStatusChange.mockClear();

			// Second poll: 5 clients (over limit).
			const awareness5 = {
				1: {},
				2: {},
				3: {},
				4: {},
				5: {},
			};
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 2,
						awareness: awareness5,
						updates: [],
					},
				],
			} );

			await jest.advanceTimersByTimeAsync( 1000 );

			// Should NOT disconnect — limit check only runs on initial sync.
			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.objectContaining( {
						code: 'connection-limit-exceeded',
					} ),
				} )
			);
		} );

		it( 'delivers dispositions to the session AFTER the same response’s updates', async () => {
			const update = { data: 'e30=', type: 'intent' };
			const dispositions = [
				{ intentId: 'i-1', status: 'applied' },
				{
					intentId: 'i-2',
					status: 'escalated',
					reason: 'attr-conflict',
				},
			];
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: {},
						updates: [ update ],
						dispositions,
					},
				],
			} );

			const session = {
				...createMockSession( 1 ),
				receiveDispositions: jest.fn(),
			};
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( session.receiveUpdate ).toHaveBeenCalledWith( update );
			expect( session.receiveDispositions ).toHaveBeenCalledWith(
				dispositions
			);
			// Rows settle the state they supersede before the ack arrives.
			expect(
				session.receiveUpdate.mock.invocationCallOrder[ 0 ]
			).toBeLessThan(
				session.receiveDispositions.mock.invocationCallOrder[ 0 ]
			);
		} );

		it( 'a session without receiveDispositions ignores them safely', async () => {
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
						dispositions: [
							{ intentId: 'i-1', status: 'applied' },
						],
					},
				],
			} );

			const onStatusChange = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( { status: 'disconnected' } )
			);
		} );

		it( 'passes room name to applyFilters for per-room customization', async () => {
			const awareness = {
				1: {},
				2: {},
				3: {},
				4: {},
			};

			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'my-custom-room',
						end_cursor: 1,
						awareness,
						updates: [],
					},
				],
			} );

			pollingManager.registerRoom( {
				room: 'my-custom-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( mockApplyFilters ).toHaveBeenCalledWith(
				'sync.pollingProvider.maxClientsPerRoom',
				3,
				'my-custom-room'
			);
		} );

		it( 'respects a custom limit from applyFilters', async () => {
			// Override the filter to allow up to 10 clients.
			mockApplyFilters.mockReturnValue( 10 );

			const awareness = {
				1: {},
				2: {},
				3: {},
				4: {},
				5: {},
			};

			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness,
						updates: [],
					},
				],
			} );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			// 5 clients under a limit of 10 — should not disconnect.
			expect( onStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.objectContaining( {
						code: 'connection-limit-exceeded',
					} ),
				} )
			);
		} );
	} );

	describe( 'queues are never held', () => {
		function twoRoomResponse( clients: number, cursor: number ) {
			const awareness: Record< number, object > = {};
			for ( let id = 1; id <= clients; id++ ) {
				awareness[ id ] = { collaboratorInfo: { id: id * 100 } };
			}
			return {
				rooms: [
					{
						room: 'primary-room',
						end_cursor: cursor,
						awareness,
						updates: [],
					},
					{
						room: 'collection-room',
						end_cursor: cursor,
						awareness: {},
						updates: [],
					},
				],
			};
		}

		it( "sends every room's initial and local updates without waiting for a collaborator", async () => {
			// Only 1 client (self) — no collaborators, no signaling lane on
			// this page: the always-on solo cadence.
			mockPostSyncUpdate.mockResolvedValue( twoRoomResponse( 1, 1 ) );

			const collectionSession = createMockSession( 2 );
			pollingManager.registerRoom( {
				room: 'primary-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'collection-room',
				session: collectionSession,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			// First poll (built when the primary room registered): its
			// initial sync_step1 goes out at once.
			await jest.advanceTimersByTimeAsync( 0 );
			const firstCallPayload = mockPostSyncUpdate.mock.calls[ 0 ][ 0 ];
			expect( firstCallPayload.rooms[ 0 ].updates ).toHaveLength( 1 );

			// A local update on the collection room goes out on the next
			// poll together with that room's initial update, still with
			// nobody else around.
			getOnLocalUpdate( collectionSession )( createMockUpdate( 3 ), 3 );
			mockPostSyncUpdate.mockResolvedValue( twoRoomResponse( 1, 2 ) );
			await jest.advanceTimersByTimeAsync( 4000 );

			const secondCallPayload = mockPostSyncUpdate.mock.calls[ 1 ][ 0 ];
			const collectionRoom = secondCallPayload.rooms.find(
				( r: { room: string } ) => r.room === 'collection-room'
			);
			expect( collectionRoom!.updates.map( ( u ) => u.type ) ).toEqual( [
				'sync_step1',
				'update',
			] );
		} );

		it( 'speeds up to the with-collaborators cadence when the primary room shows company', async () => {
			mockPostSyncUpdate.mockResolvedValue( twoRoomResponse( 2, 1 ) );

			pollingManager.registerRoom( {
				room: 'primary-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'collection-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Company: the next poll comes at the 1 s cadence, not 4 s.
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		} );
	} );

	describe( 'protocol mismatch', () => {
		it( 'emits protocol-mismatch error to all rooms when the server returns rest_sync_protocol_mismatch', async () => {
			// First poll succeeds to establish connection.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'room-a',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
					{
						room: 'room-b',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );

			const onStatusChangeA = jest.fn();
			const onStatusChangeB = jest.fn();

			pollingManager.registerRoom( {
				room: 'room-a',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: onStatusChangeA,
			} );

			pollingManager.registerRoom( {
				room: 'room-b',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: onStatusChangeB,
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			onStatusChangeA.mockClear();
			onStatusChangeB.mockClear();

			// Second poll: server returns protocol mismatch error.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_protocol_mismatch',
				message: 'Protocol version mismatch',
			} );

			await jest.advanceTimersByTimeAsync( 4000 );

			expect( onStatusChangeA ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'protocol-mismatch',
				} ),
			} );

			expect( onStatusChangeB ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'protocol-mismatch',
				} ),
			} );
		} );

		it( 'stops polling after a protocol mismatch error', async () => {
			// First poll succeeds.
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Second poll: protocol mismatch.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_protocol_mismatch',
			} );

			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Wait a long time — no further polls should occur (return stops scheduling).
			mockPostSyncUpdate.mockResolvedValue( syncResponse );
			await jest.advanceTimersByTimeAsync( 60000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		} );

		it( 'does not send a disconnect beacon for a protocol mismatch (server cannot speak our protocol)', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			mockPostSyncUpdateNonBlocking.mockClear();

			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_protocol_mismatch',
			} );

			await jest.advanceTimersByTimeAsync( 4000 );

			expect( mockPostSyncUpdateNonBlocking ).not.toHaveBeenCalled();
		} );

		it( 'fully tears down state so a later registerRoom starts a fresh poll cycle', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_protocol_mismatch',
			} );

			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Register a new room. If isPolling weren't reset, this would
			// not kick off a poll; if roomStates weren't cleared, the old
			// room would still be in the next payload.
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			pollingManager.registerRoom( {
				room: 'new-room',
				session: createMockSession( 3 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const lastPayload = mockPostSyncUpdate.mock.calls[ 2 ][ 0 ];
			expect( lastPayload.rooms ).toHaveLength( 1 );
			expect( lastPayload.rooms[ 0 ].room ).toBe( 'new-room' );
		} );

		it( 'does not apply exponential backoff for protocol mismatch errors', async () => {
			// First poll succeeds.
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			const onStatusChange = jest.fn();

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			// Protocol mismatch — should return early without touching backoff.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_protocol_mismatch',
			} );

			await jest.advanceTimersByTimeAsync( 4000 );

			// The error should be protocol-mismatch, not unknown-error
			// (which would indicate the generic catch handler ran).
			expect( onStatusChange ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'protocol-mismatch',
				} ),
			} );
		} );
	} );

	describe( 'error recovery', () => {
		it( 'splits outgoing updates so a poll stays within the request body budget', async () => {
			mockPostSyncUpdate.mockImplementation(
				async ( payload: SyncPayload ): Promise< SyncResponse > => ( {
					rooms: payload.rooms.map( ( room ) => ( {
						room: room.room,
						end_cursor: 1,
						awareness: getServerAwareness( room.room ),
						updates: [],
					} ) ),
				} )
			);

			const sessions: ReturnType< typeof createMockSession >[] = [];

			for ( let i = 0; i < 10; i++ ) {
				const session = createMockSession( i + 1 );
				sessions.push( session );
				pollingManager.registerRoom( {
					room: `room-${ i }`,
					session,
					log: jest.fn(),
					onStatusChange: jest.fn(),
				} );
			}

			// First poll includes the primary room and detects a collaborator,
			// which resumes all queues.
			await jest.advanceTimersByTimeAsync( 0 );

			sessions.forEach( ( session ) => {
				getOnLocalUpdate( session )( createMockUpdate( 8 ), 8 );
			} );

			await jest.advanceTimersByTimeAsync( 1000 );

			const secondCallPayload = mockPostSyncUpdate.mock
				.calls[ 1 ][ 0 ] as {
				rooms: Array< { updates: unknown[] } >;
			};

			expect( getPayloadSize( secondCallPayload ) ).toBeLessThanOrEqual(
				1000
			);
			expect( countOutgoingUpdates( secondCallPayload ) ).toBeGreaterThan(
				0
			);

			await jest.advanceTimersByTimeAsync( 1000 );

			const thirdCallPayload = mockPostSyncUpdate.mock
				.calls[ 2 ][ 0 ] as {
				rooms: Array< { updates: unknown[] } >;
			};

			expect( getPayloadSize( thirdCallPayload ) ).toBeLessThanOrEqual(
				1000
			);
			expect( countOutgoingUpdates( thirdCallPayload ) ).toBeGreaterThan(
				0
			);
		} );

		it( 'restores exact outgoing updates after a request-body-too-large response', async () => {
			const responseWithCollaborator = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);

			const session = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			getOnLocalUpdate( session )( createMockUpdate( 3 ), 3 );

			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_sync_body_too_large',
				message: 'Request body is too large.',
				data: { status: 413 },
			} );
			await jest.advanceTimersByTimeAsync( 1000 );

			const failedPayload = mockPostSyncUpdate.mock.calls[ 1 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};
			const failedUpdateTypes = failedPayload.rooms[ 0 ].updates.map(
				( update ) => update.type
			);

			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);
			await jest.advanceTimersByTimeAsync( 1000 );

			const retryPayload = mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};

			expect(
				retryPayload.rooms[ 0 ].updates.map( ( update ) => update.type )
			).toEqual( failedUpdateTypes );
			expect(
				retryPayload.rooms[ 0 ].updates.some(
					( update ) => update.type === 'compaction'
				)
			).toBe( false );
		} );

		it( 'replaces queued updates with a compaction after a poll error', async () => {
			// First poll: succeed with collaborators to resume the queue.
			const responseWithCollaborator = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);

			const session = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			// Flush the initial poll (queue is paused, so no updates sent).
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Add a document update (queue is now resumed due to collaborators).
			const onLocalUpdate = getOnLocalUpdate( session );
			onLocalUpdate( createMockUpdate( 3 ), 3 );

			// Second poll: fail with a network error.
			mockPostSyncUpdate.mockRejectedValueOnce( new Error( 'timeout' ) );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Verify the second poll included the queued updates (sync_step1 + doc update).
			const secondCallPayload = mockPostSyncUpdate.mock
				.calls[ 1 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};
			expect(
				secondCallPayload.rooms[ 0 ].updates.length
			).toBeGreaterThan( 0 );

			// Third poll: succeed — verify it sends a compaction instead of
			// restoring the same updates.
			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);

			// First failure with collaborators: retry in 1000ms (schedule[0]).
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const thirdCallPayload = mockPostSyncUpdate.mock
				.calls[ 2 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};
			const retryUpdates = thirdCallPayload.rooms[ 0 ].updates;
			expect( retryUpdates ).toHaveLength( 1 );
			expect( retryUpdates[ 0 ].type ).toBe( 'compaction' );
		} );

		it( 'restores exact updates after a poll error for a codec without createRecoveryUpdate', async () => {
			const responseWithCollaborator = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);

			// A codec with idempotent server-side ingest: no recovery method.
			const session = createMockSession( 1 );
			delete ( session as { createRecoveryUpdate?: unknown } )
				.createRecoveryUpdate;
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			const onLocalUpdate = getOnLocalUpdate( session );
			onLocalUpdate( createMockUpdate( 3 ), 3 );

			mockPostSyncUpdate.mockRejectedValueOnce( new Error( 'timeout' ) );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			const failedUpdates = (
				mockPostSyncUpdate.mock.calls[ 1 ][ 0 ] as {
					rooms: Array< { updates: Array< { type: string } > } >;
				}
			 ).rooms[ 0 ].updates;
			expect( failedUpdates.length ).toBeGreaterThan( 0 );

			mockPostSyncUpdate.mockResolvedValueOnce(
				responseWithCollaborator
			);
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			// The EXACT updates are re-sent — never a compaction, and never
			// a cleared queue.
			const retryUpdates = (
				mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
					rooms: Array< { updates: Array< { type: string } > } >;
				}
			 ).rooms[ 0 ].updates;
			expect( retryUpdates ).toEqual( failedUpdates );
			expect( session.createCompactionUpdate ).not.toHaveBeenCalled();
		} );

		it( 'REGRESSION: the real intent-log session survives a poll error without losing queued intents or killing polling', async () => {
			// The review found the recovery path called a compaction the
			// intent-log codec throws on, AFTER clearing the queue: one
			// transient network error while typing lost the queued intents
			// and permanently stopped polling (unhandled rejection).
			// The awareness map must include OUR clientId (7): the first-poll
			// connection-limit check counts us as an extra client otherwise.
			const responseWithSnapshot = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: { 7: {}, 2: {} },
						updates: [
							{
								data: JSON.stringify( { doc: { root: [] } } ),
								type: 'snapshot',
							},
						],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce( responseWithSnapshot );

			const session = createIntentLogSession( {
				userId: 1,
				clientId: 7,
			} );
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
			expect( session.isInitialized() ).toBe( true );

			// The user types: a real intent enters the queue.
			const intent = session.author( 'set_property', {
				name: 'title',
				value: 'typed offline',
				observedVersion: 0,
			} );

			// Network error on the poll carrying it (1000ms cadence with
			// collaborators).
			mockPostSyncUpdate.mockRejectedValueOnce( new Error( 'timeout' ) );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// The retry re-sends the SAME intent (idempotent server ingest),
			// and polling is alive.
			const emptyOk = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 2,
						awareness: { 7: {}, 2: {} },
						updates: [],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce( emptyOk );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const retryUpdates = (
				mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
					rooms: Array< {
						updates: Array< { data: string; type: string } >;
					} >;
				}
			 ).rooms[ 0 ].updates;
			expect( retryUpdates ).toHaveLength( 1 );
			expect( JSON.parse( retryUpdates[ 0 ].data ).intentId ).toBe(
				intent.intentId
			);

			// Polling continues on the normal cadence afterwards.
			mockPostSyncUpdate.mockResolvedValueOnce( emptyOk );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
		} );

		it( 'does not queue a compaction for rooms with no outgoing updates', async () => {
			// First poll succeeds (no collaborators, queue stays paused).
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Second poll: fail (no updates were sent because queue is paused).
			mockPostSyncUpdate.mockRejectedValueOnce( new Error( 'timeout' ) );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Verify no updates were sent on the failed poll.
			const secondCallPayload = mockPostSyncUpdate.mock
				.calls[ 1 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};
			expect( secondCallPayload.rooms[ 0 ].updates ).toHaveLength( 0 );

			// Third poll: succeed — should still have no updates (no compaction queued).
			// First failure solo: retry in 2000ms (schedule[0]).
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			await jest.advanceTimersByTimeAsync( 2000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const thirdCallPayload = mockPostSyncUpdate.mock
				.calls[ 2 ][ 0 ] as {
				rooms: Array< {
					updates: Array< { type: string } >;
				} >;
			};
			expect( thirdCallPayload.rooms[ 0 ].updates ).toHaveLength( 0 );
		} );

		it( 'REGRESSION: a should_compact response with a codec that cannot compact preserves queued updates', async () => {
			// The queue was cleared BEFORE createCompactionUpdate(), so a
			// codec that throws there (intent-log) lost every update queued
			// while the poll was in flight.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
				],
			} );

			const session = createMockSession( 1 );
			session.createCompactionUpdate.mockImplementation( () => {
				throw new Error( 'intent-log sessions do not compact' );
			} );
			const log = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log,
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Hold the next poll in flight; the server will answer it with
			// should_compact.
			const deferred = createDeferred< SyncResponse >();
			mockPostSyncUpdate.mockReturnValueOnce( deferred.promise );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Typed while that poll is in flight: queued, not yet sent.
			const onLocalUpdate = getOnLocalUpdate( session );
			const typed = createMockUpdate( 3 );
			onLocalUpdate( typed, 3 );

			deferred.resolve( {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 2,
						awareness: { 1: {}, 2: {} },
						updates: [],
						should_compact: true,
					},
				],
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( session.createCompactionUpdate ).toHaveBeenCalledTimes( 1 );

			// The typed update survives to the next poll; no compaction was
			// queued in its place.
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const finalUpdates = (
				mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
					rooms: Array< {
						updates: Array< { type: string; data: string } >;
					} >;
				}
			 ).rooms[ 0 ].updates;
			expect( finalUpdates ).toContainEqual( typed );
			expect(
				finalUpdates.some( ( u ) => 'compaction' === u.type )
			).toBe( false );
		} );
	} );

	describe( 'visibility change', () => {
		it( 'does not spawn a duplicate poll when a request is in-flight', () => {
			// Keep the first postSyncUpdate pending so we can simulate
			// a visibility change while the request is in-flight.
			const deferred = createDeferred< SyncResponse >();
			mockPostSyncUpdate.mockReturnValue( deferred.promise );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession(),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			// registerRoom → poll() → start() → postSyncUpdate (pending).
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Simulate tab hidden → visible while the request is in-flight.
			simulateVisibilityChange( 'hidden' );
			simulateVisibilityChange( 'visible' );

			// No second poll should have been spawned.
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'repolls immediately when tab becomes visible with a pending timeout', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession(),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			// Flush so the first poll completes and schedules a timeout.
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Tab hidden → visible while a timeout is pending.
			simulateVisibilityChange( 'hidden' );
			simulateVisibilityChange( 'visible' );

			// Should trigger an immediate repoll (not wait for timeout).
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		} );
	} );

	describe( 'unsent updates at unregister', () => {
		it( 'reports discarded updates through onUpdatesDiscarded and a forced log', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );
			const session = {
				...createMockSession( 1 ),
				onUpdatesDiscarded: jest.fn(),
			};
			const log = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log,
				onStatusChange: jest.fn(),
			} );
			await jest.advanceTimersByTimeAsync( 0 );

			// Solo: the queue is paused, so this update is never sent.
			const typed = createMockUpdate( 3 );
			getOnLocalUpdate( session )( typed, 3 );

			pollingManager.unregisterRoom( 'test-room' );

			expect( session.onUpdatesDiscarded ).toHaveBeenCalledTimes( 1 );
			const discarded = session.onUpdatesDiscarded.mock
				.calls[ 0 ][ 0 ] as Array< { type: string } >;
			expect( discarded ).toContainEqual( typed );
			expect( log ).toHaveBeenCalledWith(
				expect.stringContaining( 'Discarding' ),
				expect.objectContaining( {
					types: expect.arrayContaining( [ 'update' ] ),
				} ),
				'error',
				true
			);
			expect( session.destroy ).toHaveBeenCalled();
		} );

		it( 'stays silent when nothing was queued', async () => {
			mockPostSyncUpdate.mockResolvedValue( syncResponse );
			const session = {
				...createMockSession( 1 ),
				getInitialUpdates: jest.fn( () => [] ),
				onUpdatesDiscarded: jest.fn(),
			};
			const log = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log,
				onStatusChange: jest.fn(),
			} );
			await jest.advanceTimersByTimeAsync( 0 );

			pollingManager.unregisterRoom( 'test-room' );

			expect( session.onUpdatesDiscarded ).not.toHaveBeenCalled();
			expect( log ).not.toHaveBeenCalledWith(
				expect.stringContaining( 'Discarding' ),
				expect.anything(),
				'error',
				true
			);
		} );
	} );

	describe( 'forbidden error handling', () => {
		it( 'silently unregisters only the forbidden room on a 403', async () => {
			// Respond with two rooms on the first poll.
			const twoRoomResponse = {
				rooms: [
					{
						room: 'test-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
					{
						room: 'other-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			};
			mockPostSyncUpdate.mockResolvedValueOnce( twoRoomResponse );

			const onStatusChangeA = jest.fn();
			const onStatusChangeB = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: onStatusChangeA,
			} );
			pollingManager.registerRoom( {
				room: 'other-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: onStatusChangeB,
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Second poll: 403 listing only test-room.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_cannot_edit',
				message:
					'You do not have permission to sync one or more entities: test-room.',
				data: { status: 403, rooms: [ 'test-room' ] },
			} );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// No error should be emitted — the room is silently removed.
			expect( onStatusChangeA ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.anything(),
				} )
			);

			// The other room should be unaffected.
			expect( onStatusChangeB ).not.toHaveBeenCalledWith(
				expect.objectContaining( {
					error: expect.anything(),
				} )
			);

			// Polling should continue for the remaining room.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'other-room',
						end_cursor: 2,
						awareness: {},
						updates: [],
					},
				],
			} );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		} );

		it( 'unregisters all rooms listed in a forbidden error response', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'keep-room',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
					{
						room: 'forbidden-room-a',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
					{
						room: 'forbidden-room-b',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );

			const keepSession = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'keep-room',
				session: keepSession,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'forbidden-room-a',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'forbidden-room-b',
				session: createMockSession( 3 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			const onLocalUpdate = getOnLocalUpdate( keepSession );
			onLocalUpdate( createMockUpdate( 3 ), 3 );

			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_cannot_edit',
				message:
					'You do not have permission to sync one or more entities.',
				data: {
					status: 403,
					rooms: [ 'forbidden-room-a', 'forbidden-room-b' ],
				},
			} );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			const failedPayload = mockPostSyncUpdate.mock.calls[ 1 ][ 0 ];
			const failedKeepRoom = failedPayload.rooms.find(
				( room: { room: string } ) => room.room === 'keep-room'
			);
			expect( failedKeepRoom!.updates.length ).toBeGreaterThan( 0 );

			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'keep-room',
						end_cursor: 2,
						awareness: {},
						updates: [],
					},
				],
			} );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const retryPayload = mockPostSyncUpdate.mock.calls[ 2 ][ 0 ];
			expect( retryPayload.rooms.map( ( room ) => room.room ) ).toEqual( [
				'keep-room',
			] );
			expect( retryPayload.rooms[ 0 ].updates ).toEqual(
				failedKeepRoom!.updates
			);
		} );

		it( 'ignores forbidden rooms that were not in the failed request', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'primary',
						end_cursor: 1,
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
				],
			} );

			const primarySession = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'primary',
				session: primarySession,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			for ( let i = 1; i <= 10; i++ ) {
				pollingManager.registerRoom( {
					room: `overflow-${ i }`,
					session: createMockSession( i + 1 ),
					log: jest.fn(),
					onStatusChange: jest.fn(),
				} );
			}

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			const onPrimaryLocalUpdate = getOnLocalUpdate( primarySession );
			onPrimaryLocalUpdate( createMockUpdate( 3 ), 3 );

			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_cannot_edit',
				message:
					'You do not have permission to sync one or more entities: overflow-1, overflow-10.',
				data: {
					status: 403,
					rooms: [ 'overflow-1', 'overflow-10' ],
				},
			} );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			const failedPayload = mockPostSyncUpdate.mock.calls[ 1 ][ 0 ] as {
				rooms: Array< { room: string; updates: unknown[] } >;
			};
			expect( failedPayload.rooms.map( ( room ) => room.room ) ).toEqual(
				[
					'primary',
					'overflow-1',
					'overflow-2',
					'overflow-3',
					'overflow-4',
					'overflow-5',
					'overflow-6',
					'overflow-7',
					'overflow-8',
					'overflow-9',
				]
			);
			const failedPrimaryRoom = failedPayload.rooms.find(
				( room ) => room.room === 'primary'
			);
			expect( failedPrimaryRoom!.updates.length ).toBeGreaterThan( 0 );

			mockPostSyncUpdate.mockResolvedValueOnce( { rooms: [] } );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const retryPayload = mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
				rooms: Array< { room: string; updates: unknown[] } >;
			};
			const retryRooms = retryPayload.rooms.map( ( room ) => room.room );
			expect( retryRooms ).toContain( 'primary' );
			expect( retryRooms ).toContain( 'overflow-10' );
			expect( retryRooms ).not.toContain( 'overflow-1' );
			expect(
				retryPayload.rooms.find( ( room ) => room.room === 'primary' )!
					.updates
			).toEqual( failedPrimaryRoom!.updates );
		} );

		it( 'retries normally on a 401 (not treated as forbidden)', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			const onStatusChange = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			// Fail with a 401 — should go through normal retry path.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_not_logged_in',
				message: 'You are not currently logged in.',
				data: { status: 401 },
			} );
			await jest.advanceTimersByTimeAsync( 4000 );

			// Should emit a disconnected status (normal error handling).
			expect( onStatusChange ).toHaveBeenCalledWith(
				expect.objectContaining( {
					status: 'disconnected',
					canManuallyRetry: true,
				} )
			);

			// Should retry after backoff (2000ms for solo first failure).
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			await jest.advanceTimersByTimeAsync( 2000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		} );

		it( 'still retries on non-forbidden errors', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );

			// Fail with a generic network error (no data.status).
			mockPostSyncUpdate.mockRejectedValueOnce(
				new Error( 'Network error' )
			);
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Should retry after backoff (2000ms for solo first failure).
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			await jest.advanceTimersByTimeAsync( 2000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		} );

		it( 'does not send a disconnect signal when unregistering a forbidden room', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Next poll: 403 listing the only registered room.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_cannot_edit',
				message:
					'You do not have permission to sync one or more entities: test-room.',
				data: { status: 403, rooms: [ 'test-room' ] },
			} );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// The server already denied the sync request, so our awareness
			// was never stored. No disconnect signal should be sent.
			expect( mockPostSyncUpdateNonBlocking ).not.toHaveBeenCalled();
		} );

		it( 'resumes polling for a newly-registered room after a generic 403 unregistered all rooms', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Next poll: a generic 403 without room details.
			// All rooms get unregistered and the poll loop stops.
			mockPostSyncUpdate.mockRejectedValueOnce( {
				code: 'rest_cannot_edit',
				message: 'You do not have permission to perform this action.',
				data: { status: 403 },
			} );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// Register a brand-new room. This should kick off a fresh poll
			// cycle — but only if isPolling was reset when the previous
			// cycle stopped.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'new-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );
			pollingManager.registerRoom( {
				room: 'new-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		} );
	} );

	describe( 'engine mismatch handling', () => {
		const engineMismatchError = ( room?: string ) => ( {
			code: 'rest_sync_engine_mismatch',
			message: `Sync engine mismatch for room ${ room }: the room requires engine yjs-server v1.`,
			data: {
				status: 409,
				...( room ? { room } : {} ),
				engine: 'yjs-server',
				engine_protocol: 1,
			},
		} );

		it( 'drops only the mismatched room into the lock posture on a 409', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'healthy-room',
						end_cursor: 1,
						// Collaborators present, so queued updates are sent
						// (a solo room holds them back).
						awareness: { 1: {}, 2: {} },
						updates: [],
					},
					{
						room: 'stale-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );

			const onStaleStatusChange = jest.fn();
			const onHealthyStatusChange = jest.fn();
			const healthySession = createMockSession( 1 );
			// The surviving room is registered first so it is the primary
			// room — non-primary queues pause until collaborators appear,
			// which would hide the update-restoration behavior under test.
			pollingManager.registerRoom( {
				room: 'healthy-room',
				session: healthySession,
				log: jest.fn(),
				onStatusChange: onHealthyStatusChange,
			} );
			pollingManager.registerRoom( {
				room: 'stale-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: onStaleStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Queue an update on the surviving room so restoration is
			// observable.
			const onLocalUpdate = getOnLocalUpdate( healthySession );
			onLocalUpdate( createMockUpdate( 3 ), 3 );

			// Second poll (1000ms cadence with collaborators): the server
			// rejects the request on stale-room.
			mockPostSyncUpdate.mockRejectedValueOnce(
				engineMismatchError( 'stale-room' )
			);
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// The mismatched room enters the lock posture...
			expect( onStaleStatusChange ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'engine-mismatch',
				} ),
			} );
			// ...and is not signaled as a retryable disconnect.
			expect( onStaleStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( { canManuallyRetry: true } )
			);

			// The healthy room is untouched.
			expect( onHealthyStatusChange ).not.toHaveBeenCalledWith(
				expect.objectContaining( { error: expect.anything() } )
			);

			// Polling continues for the surviving room, with its pending
			// update restored from the failed request.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'healthy-room',
						end_cursor: 2,
						awareness: {},
						updates: [],
					},
				],
			} );
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const retryPayload = mockPostSyncUpdate.mock.calls[ 2 ][ 0 ] as {
				rooms: Array< { room: string; updates: unknown[] } >;
			};
			expect( retryPayload.rooms.map( ( room ) => room.room ) ).toEqual( [
				'healthy-room',
			] );
			expect( retryPayload.rooms[ 0 ].updates.length ).toBeGreaterThan(
				0
			);
		} );

		it( 'does not retry the mismatched room or send it a disconnect signal', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			mockPostSyncUpdate.mockRejectedValueOnce(
				engineMismatchError( 'test-room' )
			);
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// A mismatch is terminal for the room: no retry polls hammering
			// the server with further 409s...
			await jest.advanceTimersByTimeAsync( 60000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// ...and no disconnect beacon (the server would 409 that too).
			expect( mockPostSyncUpdateNonBlocking ).not.toHaveBeenCalled();
		} );

		it( 'stamps the session engine identity on room payloads, omitting it for unstamped sessions', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'stamped-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
					{
						room: 'unstamped-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );

			pollingManager.registerRoom( {
				room: 'stamped-room',
				session: {
					...createMockSession( 1 ),
					engineSlug: 'intent-log',
					engineProtocol: 1,
				},
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'unstamped-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// The first poll fires synchronously with only the first room;
			// the second poll carries both.
			mockPostSyncUpdate.mockResolvedValueOnce( { rooms: [] } );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			const payload = mockPostSyncUpdate.mock
				.calls[ 1 ][ 0 ] as unknown as {
				rooms: Array< Record< string, unknown > >;
			};
			const stamped = payload.rooms.find(
				( room ) => room.room === 'stamped-room'
			);
			const unstamped = payload.rooms.find(
				( room ) => room.room === 'unstamped-room'
			);
			expect( stamped ).toMatchObject( {
				engine: 'intent-log',
				engine_protocol: 1,
			} );
			expect( unstamped ).not.toHaveProperty( 'engine' );
			expect( unstamped ).not.toHaveProperty( 'engine_protocol' );
		} );

		it( 'treats a 409 without room details as affecting all requested rooms, and a later registerRoom restarts polling', async () => {
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );

			const onStatusChange = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			mockPostSyncUpdate.mockRejectedValueOnce( engineMismatchError() );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			expect( onStatusChange ).toHaveBeenCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					code: 'engine-mismatch',
				} ),
			} );

			// The poll loop stopped with the last room; registering a new
			// room must start a fresh cycle.
			mockPostSyncUpdate.mockResolvedValueOnce( {
				rooms: [
					{
						room: 'new-room',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );
			pollingManager.registerRoom( {
				room: 'new-room',
				session: createMockSession( 2 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		} );
	} );

	describe( 'room overflow rotation', () => {
		// The outer mock sets MAX_ROOMS_PER_REQUEST to 10. Tests in this
		// block register a primary room plus additional "overflow" rooms
		// to exercise the rotation behavior. With cap=10 and the primary
		// pinned, each request carries 9 overflow slots.
		//
		// Note: the first registerRoom call triggers poll() synchronously,
		// so the first poll's payload contains only the primary room.
		// Overflow rooms registered in the same tick are picked up starting
		// with the second poll, which is when rotation behavior kicks in.

		function registerRoom( pollingMgr: PollingManager, room: string ) {
			pollingMgr.registerRoom( {
				room,
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
		}

		function registerPrimaryAndOverflow(
			pollingMgr: PollingManager,
			overflowCount: number
		): string[] {
			registerRoom( pollingMgr, 'primary' );
			const overflowNames: string[] = [];
			for ( let i = 1; i <= overflowCount; i++ ) {
				const name = `o${ i }`;
				overflowNames.push( name );
				registerRoom( pollingMgr, name );
			}
			return overflowNames;
		}

		function getRoomNames( callIndex: number ): string[] {
			const payload = mockPostSyncUpdate.mock.calls[ callIndex ][ 0 ] as {
				rooms: { room: string }[];
			};
			return payload.rooms.map( ( r ) => r.room );
		}

		it( 'sends every room in a single request when the count is at or under the cap', async () => {
			mockPostSyncUpdate.mockResolvedValue( { rooms: [] } );

			// Primary + 9 overflow = 10 rooms, exactly at the cap.
			const overflow = registerPrimaryAndOverflow( pollingManager, 9 );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );

			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// First poll fires synchronously with only the primary room.
			expect( getRoomNames( 0 ) ).toEqual( [ 'primary' ] );

			// Second poll includes every registered room in a single
			// request (fast path since total rooms === cap).
			expect( getRoomNames( 1 ) ).toEqual( [ 'primary', ...overflow ] );
		} );

		it( 'caps each request at MAX_ROOMS_PER_REQUEST and always includes the primary room', async () => {
			mockPostSyncUpdate.mockResolvedValue( { rooms: [] } );

			// Primary + 11 overflow = 12 rooms, over the cap of 10.
			registerPrimaryAndOverflow( pollingManager, 11 );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );
			await jest.advanceTimersByTimeAsync( 4000 );

			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			// First poll: only the primary room was registered yet.
			expect( getRoomNames( 0 ) ).toEqual( [ 'primary' ] );

			// Subsequent polls cap at MAX_ROOMS_PER_REQUEST and pin primary.
			for ( let i = 1; i < 3; i++ ) {
				const names = getRoomNames( i );
				expect( names ).toHaveLength( 10 );
				expect( names[ 0 ] ).toBe( 'primary' );
			}
		} );

		it( 'rotates overflow rooms across successive polls until all are covered', async () => {
			mockPostSyncUpdate.mockResolvedValue( { rooms: [] } );

			// Primary + 15 overflow = 16 rooms. Skipping the primary-only
			// first poll, two subsequent rotation polls send 18 slots —
			// enough to cover every overflow room at least once.
			const overflow = registerPrimaryAndOverflow( pollingManager, 15 );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );
			await jest.advanceTimersByTimeAsync( 4000 );

			const overflowSeen = new Set< string >();
			// Skip poll 0 (primary only); inspect rotation polls.
			for ( let i = 1; i < 3; i++ ) {
				for ( const name of getRoomNames( i ) ) {
					if ( name !== 'primary' ) {
						overflowSeen.add( name );
					}
				}
			}

			expect( overflowSeen ).toEqual( new Set( overflow ) );
		} );

		it( 'advances the rotation window so successive polls send different overflow rooms', async () => {
			mockPostSyncUpdate.mockResolvedValue( { rooms: [] } );

			// Primary + 11 overflow rooms, 9 slots per request.
			registerPrimaryAndOverflow( pollingManager, 11 );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );
			await jest.advanceTimersByTimeAsync( 4000 );

			// Compare the two rotation polls (poll 0 is primary-only).
			const first = getRoomNames( 1 ).slice( 1 );
			const second = getRoomNames( 2 ).slice( 1 );

			expect( first ).not.toEqual( second );
			// Two rotation polls of 9 slots against 11 overflow rooms
			// cover the entire set.
			expect( new Set( [ ...first, ...second ] ).size ).toBe( 11 );
		} );

		it( 'advances the rotation window even when a poll fails', async () => {
			// Primary + 11 overflow rooms, 9 slots per request.
			registerPrimaryAndOverflow( pollingManager, 11 );

			// Poll 1: primary only (fires synchronously at registration).
			mockPostSyncUpdate.mockResolvedValueOnce( { rooms: [] } );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
			expect( getRoomNames( 0 ) ).toEqual( [ 'primary' ] );

			// Poll 2 fails while sending primary + 9 overflow. The
			// rotation offset should still advance past this window.
			mockPostSyncUpdate.mockRejectedValueOnce( new Error( 'network' ) );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			const failedSent = getRoomNames( 1 );
			expect( failedSent ).toHaveLength( 10 );
			expect( failedSent[ 0 ] ).toBe( 'primary' );

			// Poll 3 retries after the failure and should send a different
			// overflow slice, proving the offset advanced despite the error.
			mockPostSyncUpdate.mockResolvedValueOnce( { rooms: [] } );
			await jest.advanceTimersByTimeAsync( 2000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

			const retrySent = getRoomNames( 2 );
			expect( retrySent ).toHaveLength( 10 );
			expect( retrySent[ 0 ] ).toBe( 'primary' );
			expect( retrySent ).not.toEqual( failedSent );
		} );

		it( 'chunks the page-hide disconnect beacon so each request stays under the cap', async () => {
			mockPostSyncUpdate.mockResolvedValue( { rooms: [] } );

			// 21 rooms at cap=10 => three beacons (10 + 10 + 1).
			registerPrimaryAndOverflow( pollingManager, 20 );

			// Flush the initial poll so the pagehide test observes
			// postSyncUpdateNonBlocking calls from the page-hide handler only.
			await jest.advanceTimersByTimeAsync( 0 );
			mockPostSyncUpdateNonBlocking.mockClear();

			window.dispatchEvent( new Event( 'pagehide' ) );

			expect( mockPostSyncUpdateNonBlocking ).toHaveBeenCalledTimes( 3 );

			const beaconsSent = mockPostSyncUpdateNonBlocking.mock.calls.map(
				( call ) =>
					( call[ 0 ] as { rooms: { room: string }[] } ).rooms.length
			);
			expect( beaconsSent.every( ( n ) => n <= 10 ) ).toBe( true );
			expect( beaconsSent.reduce( ( a, b ) => a + b, 0 ) ).toBe( 21 );
		} );
	} );
	describe( 'presence token', () => {
		afterEach( () => {
			delete ( window as { _gutenbergSyncEnginesSettings?: unknown } )
				._gutenbergSyncEnginesSettings;
		} );

		it( "stamps this tab's token on its post's room only", async () => {
			(
				window as { _gutenbergSyncEnginesSettings?: unknown }
			 )._gutenbergSyncEnginesSettings = {
				advisory: { room: 'postType/post:7', token: 'tab-token' },
			};
			mockPostSyncUpdate.mockResolvedValue( {
				rooms: [
					{
						room: 'postType/post:7',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
					{
						room: 'taxonomy/category',
						end_cursor: 1,
						awareness: {},
						updates: [],
					},
				],
			} );
			pollingManager.registerRoom( {
				room: 'postType/post:7',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			pollingManager.registerRoom( {
				room: 'taxonomy/category',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );

			const payload = mockPostSyncUpdate.mock.calls[
				mockPostSyncUpdate.mock.calls.length - 1
			][ 0 ] as SyncPayload;
			expect( payload.rooms ).toHaveLength( 2 );
			const byRoom = Object.fromEntries(
				payload.rooms.map( ( room ) => [ room.room, room ] )
			);
			expect( byRoom[ 'postType/post:7' ].presence_token ).toBe(
				'tab-token'
			);
			expect( byRoom[ 'taxonomy/category' ] ).not.toHaveProperty(
				'presence_token'
			);
		} );
	} );

	describe( 'sync inspector tap', () => {
		it( 'records decoded polls and requests the server envelope when enabled', async () => {
			window.localStorage.setItem( 'wp_sync_debug', '1' );
			inspector.clear();
			inspector.untail();
			try {
				mockPostSyncUpdate.mockResolvedValueOnce( {
					rooms: [
						{
							room: 'test-room',
							end_cursor: 2,
							awareness: {},
							updates: [
								{
									data: JSON.stringify( {
										intentId: 'r-1',
										actorId: 'u9c9',
										baseSeq: 0,
										txnId: null,
										type: 'remove_block',
										payload: { syncId: 'p1' },
									} ),
									type: 'intent',
								},
							],
							_debug: { head_seq: 1 },
						},
					],
				} );
				pollingManager.registerRoom( {
					room: 'test-room',
					session: createMockSession( 1 ),
					log: jest.fn(),
					onStatusChange: jest.fn(),
				} );
				await jest.advanceTimersByTimeAsync( 0 );

				// The payload asked the server for the debug envelope…
				const payload = mockPostSyncUpdate.mock
					.calls[ 0 ][ 0 ] as unknown as {
					rooms: Array< { debug?: boolean } >;
				};
				expect( payload.rooms[ 0 ].debug ).toBe( true );

				// …and the inspector captured the decoded traffic.
				const records = inspector.log( { room: 'test-room' } );
				expect( records ).toHaveLength( 1 );
				// The first poll also carries the session's initial update;
				// the decoded intent is the row after it.
				expect(
					records[ 0 ].rows.map( ( row ) => row.summary ).join( ' ' )
				).toContain( 'remove_block -p1' );
				expect( records[ 0 ].serverDebug ).toEqual( { head_seq: 1 } );
			} finally {
				window.localStorage.removeItem( 'wp_sync_debug' );
				inspector.clear();
			}
		} );

		it( 'stays inert when disabled', async () => {
			inspector.clear();
			mockPostSyncUpdate.mockResolvedValueOnce( syncResponse );
			pollingManager.registerRoom( {
				room: 'test-room',
				session: createMockSession( 1 ),
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			const payload = mockPostSyncUpdate.mock
				.calls[ 0 ][ 0 ] as unknown as {
				rooms: Array< { debug?: boolean } >;
			};
			expect( payload.rooms[ 0 ].debug ).toBeUndefined();
			expect( inspector.log() ).toHaveLength( 0 );
		} );
	} );
	describe( 'send lane (SSE)', () => {
		/*
		 * Under SSE a tab's receive lane sits parked on the stream, waiting
		 * for the next event. Local work goes out BESIDE it on the updates
		 * request, marked `rows_received_separately: true`, and the stream is never
		 * closed or aborted for it: the server answers such a send with
		 * its verdicts and the room's head cursor but no stored rows, and
		 * the manager holds that answer until the stream has carried the
		 * cursor to that head (rows first, verdicts after).
		 */
		const ROOM = 'test-room';
		const collabResponse = ( endCursor = 1, extra: object = {} ) => ( {
			rooms: [
				{
					room: ROOM,
					end_cursor: endCursor,
					awareness: { 1: {}, 2: {} },
					updates: [],
					...extra,
				},
			],
		} );
		type Envelope = {
			rooms: Array< {
				room: string;
				after: number;
				awareness: unknown;
				updates: Array< { data: string; type: string } >;
				rows_received_separately?: boolean;
			} >;
		};
		interface Parked {
			payload: Envelope;
			signal?: AbortSignal;
			resolve: ( response: unknown ) => void;
		}

		// The stream: every exchange parks until the test delivers an
		// event to it (or the manager aborts it on purpose).
		function streamHarness() {
			const parked: Parked[] = [];
			mockSseExchange.exchange.mockImplementation(
				( payload: unknown, signal?: AbortSignal ) =>
					new Promise( ( resolve, reject ) => {
						parked.push( {
							payload: payload as Envelope,
							signal,
							resolve,
						} );
						signal?.addEventListener( 'abort', () =>
							reject(
								new DOMException( 'Aborted', 'AbortError' )
							)
						);
					} )
			);
			mockSseExchange.isOpen.mockReturnValue( true );
			return {
				parked,
				async deliver( response: unknown ) {
					const entry = parked.shift();
					if ( ! entry ) {
						throw new Error( 'no parked exchange' );
					}
					entry.resolve( response );
					// Apply, then the 50 ms reissue parks again.
					await jest.advanceTimersByTimeAsync( 50 );
				},
			};
		}

		function sentPayloads(): Envelope[] {
			return mockPostSyncUpdate.mock.calls.map(
				( call ) => call[ 0 ] as unknown as Envelope
			);
		}

		beforeEach( () => {
			setSseMode( true );
			mockSseExchange.close.mockClear();
			mockSseExchange.isOpen.mockReset();
			mockSseExchange.isOpen.mockReturnValue( false );
		} );

		afterEach( () => {
			pollingManager.unregisterRoom( ROOM, {
				sendDisconnectSignal: false,
			} );
			mockSseExchange.exchange.mockReset();
			setSseMode( false );
		} );

		// Registers the room and lets it settle onto a parked stream: the
		// bootstrap rides an ordinary request during the settling window,
		// then the stream opens.
		async function streamingSession(
			session: object,
			onStatusChange = jest.fn()
		) {
			pollingManager.registerRoom( {
				room: ROOM,
				session,
				log: jest.fn(),
				onStatusChange,
			} );
			await jest.advanceTimersByTimeAsync( 1100 );
			// Registering closed any stream (the settling window); from
			// here on nothing may.
			mockSseExchange.close.mockClear();
		}

		it( 'a local update goes out beside the parked stream, marked rows_received_separately:true, without aborting it', async () => {
			/*
			 * REGRESSION (issue #106): sends used to close the stream and
			 * reopen it afterwards, so a typing tab never held one for
			 * long and each reopen cost the server a worker, a
			 * subscription, and a full read.
			 */
			const stream = streamHarness();
			mockPostSyncUpdate.mockResolvedValue( collabResponse() );
			const session = createMockSession( 1 );
			await streamingSession( session );
			expect( stream.parked ).toHaveLength( 1 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			const update = createMockUpdate( 4 );
			getOnLocalUpdate( session )( update, 4 );
			await jest.advanceTimersByTimeAsync( 0 );

			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			const sent = sentPayloads()[ 1 ].rooms[ 0 ];
			expect( sent.updates.map( ( entry ) => entry.data ) ).toEqual( [
				update.data,
			] );
			expect( sent.rows_received_separately ).toBe( true );
			// The stream is untouched: still parked, never aborted.
			expect( stream.parked ).toHaveLength( 1 );
			expect( stream.parked[ 0 ].signal?.aborted ).toBe( false );
			expect( mockSseExchange.close ).not.toHaveBeenCalled();
		} );

		it( "holds a send's verdicts until the stream reaches the head the write saw, rows first", async () => {
			const stream = streamHarness();
			const dispositions = [ { intentId: 'i-1', status: 'applied' } ];
			mockPostSyncUpdate.mockImplementation( ( payload ) =>
				Promise.resolve(
					true ===
						( payload as unknown as Envelope ).rooms[ 0 ]
							.rows_received_separately
						? // The write landed as row 5; the tab is at 1.
						  collabResponse( 5, { dispositions } )
						: collabResponse()
				)
			);
			const session = {
				...createMockSession( 1 ),
				receiveDispositions: jest.fn(),
			};
			await streamingSession( session );

			getOnLocalUpdate( session )( createMockUpdate( 4 ), 4 );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			// Answered, but the stream has not delivered up to row 5 yet.
			expect( session.receiveDispositions ).not.toHaveBeenCalled();

			const rowA = { data: 'a', type: 'intent' };
			const rowB = { data: 'b', type: 'intent' };
			await stream.deliver( collabResponse( 3, { updates: [ rowA ] } ) );
			expect( session.receiveUpdate ).toHaveBeenCalledWith( rowA );
			expect( session.receiveDispositions ).not.toHaveBeenCalled();

			await stream.deliver( collabResponse( 5, { updates: [ rowB ] } ) );
			expect( session.receiveUpdate ).toHaveBeenCalledWith( rowB );
			expect( session.receiveDispositions ).toHaveBeenCalledWith(
				dispositions
			);
			// Rows settle the state they supersede before the ack arrives.
			expect(
				session.receiveUpdate.mock.invocationCallOrder[ 1 ]
			).toBeLessThan(
				session.receiveDispositions.mock.invocationCallOrder[ 0 ]
			);
			// The next request resumes from the stream's cursor, not the
			// send's answer (which moved nothing).
			expect( stream.parked[ 0 ].payload.rooms[ 0 ].after ).toBe( 5 );
		} );

		it( "applies a send's answer at once when the stream is already at that head", async () => {
			// A never-stored row (de-rtc's fetch answer) and the verdicts
			// ride the answer; the head is where the tab already is.
			streamHarness();
			const snapshot = { data: 'snap', type: 'snapshot' };
			const dispositions = [ { intentId: 'i-1', status: 'voided' } ];
			mockPostSyncUpdate.mockImplementation( ( payload ) =>
				Promise.resolve(
					true ===
						( payload as unknown as Envelope ).rooms[ 0 ]
							.rows_received_separately
						? collabResponse( 1, {
								updates: [ snapshot ],
								dispositions,
						  } )
						: collabResponse()
				)
			);
			const session = {
				...createMockSession( 1 ),
				receiveDispositions: jest.fn(),
			};
			await streamingSession( session );

			getOnLocalUpdate( session )( createMockUpdate( 4 ), 4 );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( session.receiveUpdate ).toHaveBeenCalledWith( snapshot );
			expect( session.receiveDispositions ).toHaveBeenCalledWith(
				dispositions
			);
			expect(
				session.receiveUpdate.mock.invocationCallOrder[ 0 ]
			).toBeLessThan(
				session.receiveDispositions.mock.invocationCallOrder[ 0 ]
			);
		} );

		it( 'a room that went back (reset, no genesis yet) drops the tails waiting for its old head', async () => {
			const stream = streamHarness();
			const dispositions = [ { intentId: 'i-1', status: 'applied' } ];
			mockPostSyncUpdate.mockImplementation( ( payload ) =>
				Promise.resolve(
					true ===
						( payload as unknown as Envelope ).rooms[ 0 ]
							.rows_received_separately
						? collabResponse( 5, { dispositions } )
						: collabResponse()
				)
			);
			const session = {
				...createMockSession( 1 ),
				receiveDispositions: jest.fn(),
			};
			await streamingSession( session );
			getOnLocalUpdate( session )( createMockUpdate( 4 ), 4 );
			await jest.advanceTimersByTimeAsync( 0 );

			await stream.deliver( collabResponse( 0 ) );
			await stream.deliver( collabResponse( 5 ) );
			expect( session.receiveDispositions ).not.toHaveBeenCalled();
		} );

		it( 'a failed send restores the updates, backs off, and leaves the stream alone', async () => {
			const stream = streamHarness();
			let sends = 0;
			mockPostSyncUpdate.mockImplementation( ( payload ) => {
				if (
					true ===
						( payload as unknown as Envelope ).rooms[ 0 ]
							.rows_received_separately &&
					1 === ++sends
				) {
					return Promise.reject( new Error( 'network' ) );
				}
				return Promise.resolve( collabResponse() );
			} );
			// No recovery update: the exact updates are re-sent.
			const session = Object.assign( createMockSession( 1 ), {
				createRecoveryUpdate: undefined,
			} );
			const onStatusChange = jest.fn();
			await streamingSession( session, onStatusChange );

			const update = createMockUpdate( 4 );
			getOnLocalUpdate( session )( update, 4 );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			expect( onStatusChange ).toHaveBeenLastCalledWith(
				expect.objectContaining( {
					status: 'disconnected',
					willAutoRetryInMs: 1000,
				} )
			);
			expect( stream.parked[ 0 ].signal?.aborted ).toBe( false );
			expect( mockSseExchange.close ).not.toHaveBeenCalled();

			// The retry, after the with-collaborators backoff.
			await jest.advanceTimersByTimeAsync( 999 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			await jest.advanceTimersByTimeAsync( 1 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const resent = sentPayloads()[ 2 ].rooms[ 0 ];
			expect( resent.updates.map( ( entry ) => entry.data ) ).toEqual( [
				update.data,
			] );
			expect( resent.rows_received_separately ).toBe( true );
			expect( onStatusChange ).toHaveBeenLastCalledWith( {
				status: 'connected',
			} );
		} );

		it( 'never has two requests carrying updates in flight', async () => {
			streamHarness();
			const first = createDeferred< unknown >();
			let sends = 0;
			mockPostSyncUpdate.mockImplementation( ( payload ) => {
				if (
					true ===
					( payload as unknown as Envelope ).rooms[ 0 ]
						.rows_received_separately
				) {
					sends++;
					return (
						1 === sends
							? first.promise
							: Promise.resolve( collabResponse() )
					) as ReturnType< typeof mockPostSyncUpdate >;
				}
				return Promise.resolve( collabResponse() );
			} );
			const session = createMockSession( 1 );
			await streamingSession( session );

			const one = createMockUpdate( 4 );
			const two = createMockUpdate( 5 );
			getOnLocalUpdate( session )( one, 4 );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( sends ).toBe( 1 );
			// A second update while the first send is in flight waits.
			getOnLocalUpdate( session )( two, 5 );
			await jest.advanceTimersByTimeAsync( 100 );
			expect( sends ).toBe( 1 );
			first.resolve( collabResponse() );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( sends ).toBe( 2 );
			expect(
				sentPayloads()[ 2 ].rooms[ 0 ].updates.map(
					( entry ) => entry.data
				)
			).toEqual( [ two.data ] );
		} );

		it( 'the save flush resolves once the send that carried the work returns', async () => {
			streamHarness();
			const send = createDeferred< unknown >();
			mockPostSyncUpdate.mockImplementation(
				( payload ) =>
					( true ===
					( payload as unknown as Envelope ).rooms[ 0 ]
						.rows_received_separately
						? send.promise
						: Promise.resolve( collabResponse() ) ) as ReturnType<
						typeof mockPostSyncUpdate
					>
			);
			const session = createMockSession( 1 );
			await streamingSession( session );

			getOnLocalUpdate( session )( createMockUpdate( 4 ), 4 );
			let flushed = false;
			const flush = flushHeldUpdates().then( () => {
				flushed = true;
			} );
			await jest.advanceTimersByTimeAsync( 100 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			expect( flushed ).toBe( false );
			send.resolve( collabResponse() );
			await jest.advanceTimersByTimeAsync( 0 );
			await flush;
			expect( flushed ).toBe( true );
		} );

		it( 'an awareness change rides the send lane instead of reopening the stream', async () => {
			const stream = streamHarness();
			mockPostSyncUpdate.mockResolvedValue( collabResponse() );
			const awareness: Record< string, unknown > = { user: 1 };
			const session = {
				...createMockSession( 1 ),
				getLocalAwareness: jest.fn( () => awareness ),
			};
			await streamingSession( session );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			// Unchanged: nothing to send.
			await jest.advanceTimersByTimeAsync( 2000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

			awareness.cursor = 7;
			await jest.advanceTimersByTimeAsync( 1000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
			const sent = sentPayloads()[ 1 ].rooms[ 0 ];
			expect( sent.awareness ).toEqual( { user: 1, cursor: 7 } );
			expect( sent.updates ).toEqual( [] );
			expect( sent.rows_received_separately ).toBe( true );
			expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
			expect( stream.parked[ 0 ].signal?.aborted ).toBe( false );
			// Sent once, not on every check.
			await jest.advanceTimersByTimeAsync( 3000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		} );
	} );

	describe( 'room generation', () => {
		const roomResponse = (
			generation: string,
			updates: SyncUpdate[] = [],
			endCursor = 1
		) => ( {
			rooms: [
				{
					room: 'test-room',
					end_cursor: endCursor,
					awareness: {},
					updates,
					generation,
				},
			],
		} );

		it( 'adopts the first generation it sees and keeps processing rows under it', async () => {
			const row = createMockUpdate( 2 );
			mockPostSyncUpdate
				.mockResolvedValueOnce( roomResponse( 'g10' ) )
				.mockResolvedValueOnce( roomResponse( 'g10', [ row ], 2 ) );
			const session = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );

			expect( session.receiveUpdate ).toHaveBeenCalledWith( row );
			const second = mockPostSyncUpdate.mock
				.calls[ 1 ][ 0 ] as SyncPayload;
			expect( second.rooms[ 0 ].after ).toBe( 1 );
		} );

		it( 'on a changed generation: asks the session, drops the response rows, and re-fetches from cursor 0 at once', async () => {
			const newGenesis = createMockUpdate( 4 );
			mockPostSyncUpdate
				.mockResolvedValueOnce( roomResponse( 'g10', [], 5 ) )
				.mockResolvedValueOnce(
					roomResponse( 'g20', [ newGenesis ], 9 )
				)
				.mockResolvedValue( roomResponse( 'g20', [ newGenesis ], 9 ) );
			const initial = { data: encodeMockData( 1 ), type: 'sync_step1' };
			const session = {
				...createMockSession( 1 ),
				getInitialUpdates: jest.fn( () => [ initial ] ),
				onRoomRestart: jest.fn( () => 'rebootstrap' as const ),
				syncWhileSolo: true as const,
			};
			const log = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log,
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			// Queue some local work written against the old room.
			getOnLocalUpdate( session )( createMockUpdate( 3 ), 3 );
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

			// The session was told, with the new room's rows, and the
			// restart response's rows were NOT applied as ordinary updates.
			expect( session.onRoomRestart ).toHaveBeenCalledWith( [
				newGenesis,
			] );
			expect( session.receiveUpdate ).not.toHaveBeenCalledWith(
				newGenesis
			);
			expect( session.destroy ).not.toHaveBeenCalled();

			// The re-poll follows immediately (no interval wait), from
			// cursor 0, carrying only the session's initial updates: the
			// stale local work was dropped for the session to re-derive.
			await jest.advanceTimersByTimeAsync( 1 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const repoll = mockPostSyncUpdate.mock
				.calls[ 2 ][ 0 ] as SyncPayload;
			expect( repoll.rooms[ 0 ].after ).toBe( 0 );
			expect( repoll.rooms[ 0 ].updates ).toEqual( [ initial ] );

			// The new generation is adopted: its rows now apply normally.
			await jest.advanceTimersByTimeAsync( 4000 );
			expect( session.receiveUpdate ).toHaveBeenCalledWith( newGenesis );
			expect( session.onRoomRestart ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'a session that cannot rejoin is disconnected and unregistered', async () => {
			mockPostSyncUpdate
				.mockResolvedValueOnce( roomResponse( 'g10' ) )
				.mockResolvedValue(
					roomResponse( 'g20', [ createMockUpdate( 4 ) ] )
				);
			const session = {
				...createMockSession( 1 ),
				onRoomRestart: jest.fn( () => 'disconnect' as const ),
			};
			const onStatusChange = jest.fn();
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange,
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );

			expect( onStatusChange ).toHaveBeenLastCalledWith( {
				status: 'disconnected',
				error: expect.objectContaining( {
					message: expect.stringContaining( 'restarted' ),
				} ),
			} );
			expect( session.destroy ).toHaveBeenCalled();
			// Nothing polls for the dropped room anymore.
			const calls = mockPostSyncUpdate.mock.calls.length;
			await jest.advanceTimersByTimeAsync( 10000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( calls );
		} );

		it( 'a session without an opinion is re-bootstrapped', async () => {
			mockPostSyncUpdate
				.mockResolvedValueOnce( roomResponse( 'g10' ) )
				.mockResolvedValue( roomResponse( 'g20' ) );
			const session = createMockSession( 1 );
			pollingManager.registerRoom( {
				room: 'test-room',
				session,
				log: jest.fn(),
				onStatusChange: jest.fn(),
			} );

			await jest.advanceTimersByTimeAsync( 0 );
			await jest.advanceTimersByTimeAsync( 4000 );
			await jest.advanceTimersByTimeAsync( 1 );

			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
			const repoll = mockPostSyncUpdate.mock
				.calls[ 2 ][ 0 ] as SyncPayload;
			expect( repoll.rooms[ 0 ].after ).toBe( 0 );
			expect( session.destroy ).not.toHaveBeenCalled();
		} );
	} );
} );
