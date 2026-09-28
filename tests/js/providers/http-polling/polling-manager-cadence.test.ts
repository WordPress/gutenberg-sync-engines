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
import type { EngineSessionCodec } from '@wordpress/sync';

/**
 * The cadence rules of docs/plan/advisory-channel.md, with the signaling
 * lane and the advisory channel replaced by controllable fakes.
 */

let mockSignalingAvailable = true;
let mockOthers = false;
let mockCoverage = false;
let mockChannelPresence: Record< string, unknown > = {};
const mockCallbacks: {
	others: Array< ( others: boolean ) => void >;
	coverage: Array< () => void >;
	announce: Array< ( room: string ) => void >;
	presence: Array< ( room: string ) => void >;
	cursor: Array< ( cursor: number ) => void >;
	engine: Array< ( engine: string ) => void >;
	awareness: Array< () => void >;
} = {
	others: [],
	coverage: [],
	announce: [],
	presence: [],
	cursor: [],
	engine: [],
	awareness: [],
};
const mockSetDisabled = jest.fn();
const mockSetSignalCarrier = jest.fn();
const mockAnnounceLocalWrite = jest.fn();
const mockSseExchange = {
	available: true,
	close: jest.fn(),
	isOpen: jest.fn( () => false ),
	exchange:
		jest.fn<
			(
				payload: { rooms: Array< { room: string } > },
				signal?: AbortSignal
			) => Promise< ReturnType< typeof response > >
		>(),
};

jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn(),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

jest.mock( '../../../../src/providers/advisory/signaling', () => ( {
	applyAnswer: jest.fn(),
	buildProbe: () => ( { seq: 1, room: 'postType/post:1', token: 'tok' } ),
	getPresenceRoom: () => 'postType/post:1',
	getPresenceToken: () => 'tok',
	probeFailed: jest.fn(),
	installSignaling: jest.fn(),
	installSignalingLifecycle: jest.fn(),
	isSignalingAvailable: () => mockSignalingAvailable,
	othersPresent: () => mockOthers,
	onOthersChanged: ( cb: ( others: boolean ) => void ) =>
		mockCallbacks.others.push( cb ),
	onRoomCursor: ( cb: ( cursor: number ) => void ) =>
		mockCallbacks.cursor.push( cb ),
	onRoomEngine: ( cb: ( engine: string ) => void ) =>
		mockCallbacks.engine.push( cb ),
	setSignalCarrier: mockSetSignalCarrier,
	setSyncClientId: jest.fn(),
} ) );

jest.mock( '../../../../src/providers/sse/sse-exchange', () => ( {
	SseExchange: jest.fn( () => mockSseExchange ),
} ) );

jest.mock( '../../../../src/providers/http-polling/save-flush', () => ( {
	registerSaveFlush: jest.fn(),
} ) );

jest.mock( '../../../../src/providers/advisory/channel', () => ( {
	advisoryCoversClients: () => mockCoverage,
	getChannelPresence: () => mockChannelPresence,
	onAdvisoryAnnounce: ( cb: ( room: string ) => void ) =>
		mockCallbacks.announce.push( cb ),
	onAdvisoryCoverageChanged: ( cb: () => void ) =>
		mockCallbacks.coverage.push( cb ),
	onAdvisoryPresence: ( cb: ( room: string ) => void ) =>
		mockCallbacks.presence.push( cb ),
	setAdvisoryDisabledByTransport: mockSetDisabled,
	setPresenceSource: jest.fn(),
	startAdvisoryChannel: jest.fn(),
	stopAdvisoryChannel: jest.fn(),
} ) );

jest.mock( '../../../../src/providers/advisory/announce', () => ( {
	announceLocalWrite: mockAnnounceLocalWrite,
	onLocalAwarenessChange: ( cb: () => void ) =>
		mockCallbacks.awareness.push( cb ),
} ) );

jest.mock( '../../../../src/providers/http-polling/utils', () => ( {
	...( jest.requireActual(
		'../../../../src/providers/http-polling/utils'
	) as object ),
	postSyncUpdate: jest.fn(),
	postSyncUpdateNonBlocking: jest.fn(),
} ) );

type Manager =
	typeof import('../../../../src/providers/http-polling/polling-manager');

function response( clients: number[], cursor = 1 ) {
	const awareness: Record< number, object > = {};
	for ( const id of clients ) {
		awareness[ id ] = { user: id };
	}
	return {
		rooms: [
			{ room: 'test-room', end_cursor: cursor, awareness, updates: [] },
		],
	};
}

function createMockSession( clientId = 1, sendsWhileAlone = false ) {
	return {
		applyRemoteAwareness: jest.fn(),
		clientId,
		engineSlug: 'intent-log',
		...( sendsWhileAlone ? { sendsWhileAlone: true } : {} ),
		destroy: jest.fn(),
		getInitialUpdates: jest.fn( () => [] ),
		getLocalAwareness: jest.fn( () => ( { user: clientId } ) ),
		onLocalUpdate: jest.fn(),
		receiveUpdate: jest.fn(),
	};
}

describe( 'polling-manager cadence', () => {
	let pollingManager: Manager[ 'pollingManager' ];
	let setSseMode: Manager[ 'setSseMode' ];
	let flushHeldUpdates: Manager[ 'flushHeldUpdates' ];
	let mockPostSyncUpdate: jest.Mock<
		typeof import('../../../../src/providers/http-polling/utils').postSyncUpdate
	>;

	beforeEach( () => {
		jest.useFakeTimers();
		mockSignalingAvailable = true;
		mockOthers = false;
		mockCoverage = false;
		mockChannelPresence = {};
		mockCallbacks.others.length = 0;
		mockCallbacks.coverage.length = 0;
		mockCallbacks.announce.length = 0;
		mockCallbacks.presence.length = 0;
		mockCallbacks.cursor.length = 0;
		mockCallbacks.engine.length = 0;
		mockCallbacks.awareness.length = 0;
		mockSetDisabled.mockClear();
		mockSetSignalCarrier.mockClear();
		mockAnnounceLocalWrite.mockClear();
		mockSseExchange.available = true;
		mockSseExchange.close.mockClear();
		mockSseExchange.exchange.mockReset();
		jest.isolateModules( () => {
			const managerModule: Manager = require( '../../../../src/providers/http-polling/polling-manager' );
			pollingManager = managerModule.pollingManager;
			setSseMode = managerModule.setSseMode;
			flushHeldUpdates = managerModule.flushHeldUpdates;
			mockPostSyncUpdate =
				require( '../../../../src/providers/http-polling/utils' ).postSyncUpdate;
		} );
	} );

	afterEach( () => {
		// Each test gets a fresh module, but the document is shared: drop
		// the rooms so the module's visibilitychange listener goes with
		// them, or a later test's dispatch would poll through every earlier
		// module too.
		for ( const room of [ 'test-room', 'test-room-2' ] ) {
			pollingManager.unregisterRoom( room, {
				sendDisconnectSignal: false,
			} );
		}
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	function register( session = createMockSession() ) {
		pollingManager.registerRoom( {
			room: 'test-room',
			session: session as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		return session;
	}

	it( 'a lone tab keeps the solo cadence for a discovery window after load, then stops scheduling', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		// 30 s of 4 s polls: the moments a second person most often turns
		// up, found within seconds instead of a heartbeat.
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		// Past the window (plus the last 4 s poll scheduled inside it):
		// no timer at all.
		await jest.advanceTimersByTimeAsync( 30000 );
		const afterWindow = mockPostSyncUpdate.mock.calls.length;
		expect( afterWindow ).toBeGreaterThanOrEqual( 8 );
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterWindow );

		// Regaining focus reopens the window.
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		await jest.advanceTimersByTimeAsync( 0 );
		const afterFocus = mockPostSyncUpdate.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterFocus + 1 );
	} );

	it( 'a lone tab holds its updates; a flush (before a save) sends them and holds again', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		// Held: no on-demand poll, and the discovery-window polls carry
		// nothing.
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 0 );

		// The save middleware's flush releases the queue and waits for the
		// poll to return.
		const flushed = flushHeldUpdates();
		await jest.advanceTimersByTimeAsync( 0 );
		await flushed;
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		expect(
			mockPostSyncUpdate.mock.calls[ 2 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 2 );
		expect( mockAnnounceLocalWrite ).toHaveBeenCalledWith( 'test-room' );

		// Still alone: the next update is held again (no on-demand poll
		// within the send delay).
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 500 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'a flush that lands while a poll is in flight waits for the successor that carries the work', async () => {
		let release!: ( value: ReturnType< typeof response > ) => void;
		mockPostSyncUpdate.mockResolvedValueOnce( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );

		// A poll is in flight (built before the flush): hold it open.
		mockPostSyncUpdate.mockImplementationOnce(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);
		await jest.advanceTimersByTimeAsync( 25000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		let flushed = false;
		void flushHeldUpdates().then( () => {
			flushed = true;
		} );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ], 2 ) );
		release( response( [ 1 ] ) );
		await jest.advanceTimersByTimeAsync( 0 );
		// Not resolved by the in-flight poll's end...
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 0 );
		// ...but by the successor, which carried the held update.
		expect( flushed ).toBe( true );
		expect(
			mockPostSyncUpdate.mock.calls[ 2 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'a lone tab going hidden flushes its held work once, unless a pagehide follows', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );

		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		// A reload hides first, then unloads: pagehide cancels the flush.
		window.dispatchEvent( new Event( 'pagehide' ) );
		await jest.advanceTimersByTimeAsync( 2000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// A real tab switch: the flush lands after the grace period.
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		await jest.advanceTimersByTimeAsync( 1500 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
	} );

	it( 'a codec that sends while alone (de-rtc) is exempt from the hold and polls on demand', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register( createMockSession( 1, true ) );
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'fetch', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( "updates queued while a lone (exempt) tab's poll is in flight go out right after it returns", async () => {
		let release!: ( value: ReturnType< typeof response > ) => void;
		mockPostSyncUpdate.mockResolvedValueOnce( response( [ 1 ] ) );
		const session = register( createMockSession( 1, true ) );
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;

		// The on-demand poll is held open; more updates arrive meanwhile.
		mockPostSyncUpdate.mockImplementationOnce(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

		mockPostSyncUpdate.mockResolvedValueOnce( response( [ 1 ], 2 ) );
		release( response( [ 1 ], 2 ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		expect(
			mockPostSyncUpdate.mock.calls[ 2 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'company from the heartbeat wakes a lone tab onto the timer cadence and releases its queue', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 3000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		mockOthers = true;
		mockCallbacks.others.forEach( ( cb ) => cb( true ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
		// Nobody on the channel yet: the with-collaborators cadence.
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

		// The heartbeat says they left: back to the solo cadence (the
		// discovery window is still open this soon after load).
		mockOthers = false;
		mockCallbacks.others.forEach( ( cb ) => cb( false ) );
		await jest.advanceTimersByTimeAsync( 3000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'an awareness map with company keeps the timer cadence even when the heartbeat is silent', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'full channel coverage stops the timer and polls on announcements', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		// (Two rounds follow: count from here.)
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 300 );

		// A burst of announcements collapses into one poll after the
		// coalescing delay.
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		// Another right away waits out the floor.
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 100 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'a changed awareness state under coverage rides the presence lane, not a poll', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// Slow awareness names a new block: the advisory channel's
		// presence lane carries the field, so no poll and no rumor.
		mockCallbacks.awareness.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 10000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		expect( mockAnnounceLocalWrite ).not.toHaveBeenCalled();
	} );

	it( 'a local update under coverage polls on demand', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'a coverage flip never parks queued updates behind a stopped timer', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		// On the 1 s timer; an undo queues inverse intents, which the
		// pending timer would send.
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'intent', data: 'AA==' }, 1 );
		// The channel connects right then: coverage flips and the timer
		// is re-evaluated. The queued work must still go out promptly.
		mockCoverage = true;
		mockCallbacks.coverage.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'updates queued during a poll under coverage go out right after it', async () => {
		let release!: ( value: ReturnType< typeof response > ) => void;
		mockOthers = true;
		mockCoverage = true;
		mockPostSyncUpdate.mockImplementationOnce(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 2 ) );
		release( response( [ 1, 2 ] ) );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'a room registered mid-session polls soon even with the timer stopped', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		pollingManager.registerRoom( {
			room: 'taxonomy/category',
			session: createMockSession( 3 ) as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms.map( ( r ) => r.room )
		).toEqual( [ 'test-room', 'taxonomy/category' ] );
	} );

	it( 'a heartbeat answer reporting the room ahead of this tab polls, one that does not stays quiet', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 7 ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// Same head as our cursor: nothing to fetch.
		mockCallbacks.cursor.forEach( ( cb ) => cb( 7 ) );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// A script wrote rows nobody announced: the beat says the room
		// is ahead, so the tab polls.
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 9 ) );
		mockCallbacks.cursor.forEach( ( cb ) => cb( 9 ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect( mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].after ).toBe(
			7
		);
	} );

	it( 'a heartbeat answer naming a different engine polls into the fence; the same engine stays quiet', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		mockCallbacks.engine.forEach( ( cb ) => cb( 'intent-log' ) );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		mockCallbacks.engine.forEach( ( cb ) => cb( 'yjs-server' ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'losing coverage restarts the stopped loop at the with-collaborators cadence', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 5000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		mockCoverage = false;
		mockCallbacks.coverage.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'without the signaling lane the always-on cadence is unchanged', async () => {
		mockSignalingAvailable = false;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'SSE: rooms registering at load ride ordinary requests; one stream opens once they settle', async () => {
		setSseMode( true );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		mockSseExchange.exchange.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		// A second room registers 300 ms later, as the editor's collection
		// rooms do: its bootstrap is the usual prompt request for a late
		// room (300 ms), and the settling window restarts from its
		// registration.
		await jest.advanceTimersByTimeAsync( 300 );
		pollingManager.registerRoom( {
			room: 'test-room-2',
			session: createMockSession( 1 ) as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 699 );
		expect( mockSseExchange.exchange ).not.toHaveBeenCalled();
		// The window closes: one stream, covering both rooms.
		await jest.advanceTimersByTimeAsync( 1 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		expect(
			mockSseExchange.exchange.mock.calls[ 0 ][ 0 ].rooms.map(
				( room: { room: string } ) => room.room
			)
		).toEqual( [ 'test-room', 'test-room-2' ] );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'SSE: a lone tab streams through the discovery window, then closes its stream and stops; company reopens it', async () => {
		setSseMode( true );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		mockSseExchange.exchange.mockResolvedValue( response( [ 1 ] ) );
		register();
		// The first second is the settling window: ordinary requests.
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		// Inside the window the loop re-issues right behind each event.
		await jest.advanceTimersByTimeAsync( 50 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 2 );
		mockSseExchange.close.mockClear();
		// Past the window: the stream is closed (no held PHP worker) and
		// nothing is scheduled.
		await jest.advanceTimersByTimeAsync( 31000 );
		expect( mockSseExchange.close ).toHaveBeenCalled();
		const afterWindow = mockSseExchange.exchange.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( afterWindow );
		// Company from the heartbeat restarts the loop, which reopens one.
		mockOthers = true;
		mockCallbacks.others.forEach( ( cb ) => cb( true ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes(
			afterWindow + 1
		);
	} );

	function setVisibility( state: 'hidden' | 'visible' ) {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => state,
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
	}

	// A stream exchange that parks until the manager aborts it, the way a
	// real stream waits for its next event.
	function parkUntilAborted() {
		mockSseExchange.exchange.mockImplementation(
			( _payload, signal ) =>
				new Promise( ( _resolve, reject ) => {
					signal?.addEventListener( 'abort', () =>
						reject( new DOMException( 'Aborted', 'AbortError' ) )
					);
				} )
		);
	}

	it( 'SSE: a hidden tab drops its stream and receives at the background cadence; visible again reopens it at once', async () => {
		setSseMode( true );
		mockOthers = true;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		parkUntilAborted();
		register();
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		mockSseExchange.close.mockClear();

		// Hidden: the parked stream is dropped on purpose (no failure, no
		// backoff) and the tab receives over ordinary requests instead.
		setVisibility( 'hidden' );
		expect( mockSseExchange.close ).toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		// The background cadence, not the stream re-issue.
		await jest.advanceTimersByTimeAsync( 24999 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 1 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 25000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );

		// Visible again: the stream reopens at once.
		setVisibility( 'visible' );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 2 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'SSE: a tab hidden while alone polls like short polling through the discovery window, then goes quiet', async () => {
		setSseMode( true );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		parkUntilAborted();
		register();
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		mockSseExchange.close.mockClear();

		setVisibility( 'hidden' );
		expect( mockSseExchange.close ).toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		// Not streaming, so short polling's own rules: alone inside the
		// discovery window is the solo interval, past it nothing at all —
		// no stream, no timer.
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 30000 );
		const afterWindow = mockPostSyncUpdate.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterWindow );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'SSE: handshake signals ride the heartbeat, never a poll', async () => {
		setSseMode( true );
		mockOthers = true;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockSseExchange.exchange.mockResolvedValue( response( [ 1, 2 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		const carrier = mockSetSignalCarrier.mock.calls.at( -1 )?.[ 0 ] as
			| ( () => boolean )
			| undefined;
		expect( carrier?.() ).toBe( false );
	} );

	it( 'SSE: switches the channel off while streaming and back on while receiving runs on polling', async () => {
		setSseMode( true );
		mockOthers = true;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockSseExchange.exchange.mockResolvedValueOnce( response( [ 1, 2 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
		expect( mockSetDisabled ).toHaveBeenLastCalledWith( true );
		// The stream failed and receiving runs on polling for a while: the
		// channel is the wake path again until SSE is retried.
		mockSseExchange.available = false;
		await jest.advanceTimersByTimeAsync( 50 );
		expect( mockSetDisabled ).toHaveBeenLastCalledWith( false );
		expect( mockSseExchange.exchange ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'SSE: while no stream can be opened, receiving follows the short-polling cadence rules', async () => {
		setSseMode( true );
		mockOthers = true;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		// A stream failed a moment ago: the exchange refuses to open one
		// for a while, and every receive is an ordinary request.
		mockSseExchange.available = false;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		expect( mockSseExchange.exchange ).not.toHaveBeenCalled();
		// With company: the collaborator interval (1 s), not the solo one.
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		// Every peer reachable over the channel: no timer at all, and a
		// peer's announcement polls on demand.
		mockCoverage = true;
		mockCallbacks.coverage.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 10000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
		// The exchange willing again: the next receive reopens a stream.
		mockSseExchange.available = true;
		mockSseExchange.exchange.mockResolvedValue( response( [ 1, 2 ] ) );
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockSseExchange.exchange ).toHaveBeenCalled();
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'overlays channel presence on the poll response and re-applies it when it changes', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockChannelPresence = { 2: { name: 'live' }, 3: { name: 'new' } };
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		// The channel's base presence overlays the server's copy per
		// client (server-only fields such as cursors survive), and a peer
		// the server has not reported yet appears from the channel alone.
		expect( session.applyRemoteAwareness ).toHaveBeenLastCalledWith( {
			1: { user: 1 },
			2: { user: 2, name: 'live' },
			3: { name: 'new' },
		} );

		mockChannelPresence = { 2: { name: 'renamed' } };
		mockCallbacks.presence.forEach( ( cb ) => cb( 'test-room' ) );
		expect( session.applyRemoteAwareness ).toHaveBeenLastCalledWith( {
			1: { user: 1 },
			2: { user: 2, name: 'renamed' },
		} );
	} );

	describe( 'handing a room to and from a preferred transport', () => {
		it( 'resumes at the given cursor and releases the room with its cursor and unsent work, keeping the session', async () => {
			mockSignalingAvailable = false;
			mockPostSyncUpdate.mockResolvedValue( response( [ 1 ], 9 ) );
			const session = createMockSession();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: session as unknown as EngineSessionCodec,
				log: jest.fn(),
				onStatusChange: jest.fn(),
				initialCursor: 5,
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			expect(
				mockPostSyncUpdate.mock.calls[ 0 ][ 0 ].rooms[ 0 ].after
			).toBe( 5 );
			const onLocalUpdate = session.onLocalUpdate.mock
				.calls[ 0 ][ 0 ] as ( update: unknown, size: number ) => void;
			onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );

			const released = await pollingManager.releaseRoom( 'test-room' );
			expect( released ).toEqual( {
				cursor: 9,
				unsent: [ { type: 'update', data: 'AA==' } ],
			} );
			expect( session.destroy ).not.toHaveBeenCalled();
			// The loop is empty: nothing polls any more.
			await jest.advanceTimersByTimeAsync( 10000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'waits for a request in flight before releasing, so the cursor is final', async () => {
			mockSignalingAvailable = false;
			let release!: ( value: ReturnType< typeof response > ) => void;
			mockPostSyncUpdate.mockImplementationOnce(
				() =>
					new Promise( ( resolve ) => {
						release = resolve;
					} )
			);
			register();
			await jest.advanceTimersByTimeAsync( 0 );
			let released: unknown = null;
			void pollingManager.releaseRoom( 'test-room' ).then( ( value ) => {
				released = value;
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( released ).toBeNull();
			release( response( [ 1 ], 3 ) );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( released ).toEqual( { cursor: 3, unsent: [] } );
		} );
	} );

	it( 'SSE: a send answered after the loop stopped is settled by one receive', async () => {
		/*
		 * A codec that sends while alone (de-rtc). Its send goes out
		 * beside the stream, marked receive:false, and its answer waits
		 * for the stream to carry the cursor to the head the write saw.
		 * If the loop stops meanwhile (a stream event shows the tab alone
		 * past the discovery window), nobody would carry the cursor
		 * there: the manager polls once for it.
		 */
		setSseMode( true );
		const parked: Array<
			( event: ReturnType< typeof response > ) => void
		> = [];
		mockSseExchange.exchange.mockImplementation(
			( _payload, signal ) =>
				new Promise( ( resolve, reject ) => {
					parked.push( resolve );
					signal?.addEventListener( 'abort', () =>
						reject( new DOMException( 'Aborted', 'AbortError' ) )
					);
				} )
		);
		mockSseExchange.isOpen.mockReturnValue( true );
		let answer!: ( response: unknown ) => void;
		const send = new Promise( ( resolve ) => {
			answer = resolve;
		} );
		mockPostSyncUpdate.mockImplementation(
			( payload ) =>
				( true ===
				(
					payload as {
						rooms: Array< { rows_received_separately?: boolean } >;
					}
				 ).rooms[ 0 ].rows_received_separately
					? send
					: Promise.resolve( response( [ 1 ] ) ) ) as ReturnType<
					typeof mockPostSyncUpdate
				>
		);
		const dispositions = [ { intentId: 'p-1', status: 'applied' } ];
		const session = {
			...createMockSession( 1, true ),
			receiveDispositions: jest.fn(),
		};
		register( session );
		// Settled onto the stream, then parked past the discovery window
		// with no event so far.
		await jest.advanceTimersByTimeAsync( 31000 );
		expect( parked ).toHaveLength( 1 );

		const onLocalUpdate = session.onLocalUpdate.mock.calls[ 0 ][ 0 ] as (
			update: unknown,
			size: number
		) => void;
		onLocalUpdate( { data: 'x', type: 'update' }, 1 );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

		// The event shows the tab alone past the window: the loop stops
		// and drops its stream, with the send still in flight.
		mockSseExchange.close.mockClear();
		parked.shift()!( response( [ 1 ] ) );
		await jest.advanceTimersByTimeAsync( 50 );
		expect( mockSseExchange.close ).toHaveBeenCalled();
		expect( parked ).toHaveLength( 0 );

		answer( {
			...response( [ 1 ], 2 ),
			rooms: [ { ...response( [ 1 ], 2 ).rooms[ 0 ], dispositions } ],
		} );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( session.receiveDispositions ).not.toHaveBeenCalled();
		// One receive for the held answer.
		expect( parked ).toHaveLength( 1 );
		parked.shift()!( response( [ 1 ], 2 ) );
		await jest.advanceTimersByTimeAsync( 50 );
		expect( session.receiveDispositions ).toHaveBeenCalledWith(
			dispositions
		);
	} );
} );
