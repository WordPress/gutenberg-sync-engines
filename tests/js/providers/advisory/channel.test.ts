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
 * Two tabs in one process: each tab is an isolated module registry (its own
 * signaling and channel state) wired through a fake heartbeat "server" that
 * relays handshake messages between mailboxes, and a fake RTCPeerConnection
 * pair whose data channels deliver messages synchronously.
 */

type Hook = ( data: Record< string, unknown > ) => void;
const mockAdded: Array< { hook: string; callback: Hook } > = [];

jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn( ( hook: string, _ns: string, callback: Hook ) => {
		mockAdded.push( { hook, callback } );
	} ),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

class FakeDataChannel {
	public readyState = 'connecting';
	public onopen: ( () => void ) | null = null;
	public onmessage: ( ( event: { data: string } ) => void ) | null = null;
	public onclose: ( () => void ) | null = null;
	public peer: FakeDataChannel | null = null;
	public sent: string[] = [];
	public label: string;

	constructor( label: string ) {
		this.label = label;
	}

	send( raw: string ): void {
		if ( 'open' !== this.readyState ) {
			throw new Error( 'not open' );
		}
		this.sent.push( raw );
		this.peer?.onmessage?.( { data: raw } );
	}

	close(): void {
		if ( 'closed' === this.readyState ) {
			return;
		}
		this.readyState = 'closed';
		const peer = this.peer;
		this.peer = null;
		this.onclose?.();
		if ( peer && 'closed' !== peer.readyState ) {
			peer.peer = null;
			peer.close();
		}
	}
}

let nextPcId = 1;
const pcsById: Map< string, FakePeerConnection > = new Map();

class FakePeerConnection extends EventTarget {
	public id = `pc${ nextPcId++ }`;
	public iceGatheringState = 'complete';
	public connectionState = 'new';
	public localDescription: RTCSessionDescriptionInit | null = null;
	public remoteDescription: RTCSessionDescriptionInit | null = null;
	public onicecandidate:
		| ( ( event: { candidate: { toJSON: () => unknown } | null } ) => void )
		| null = null;
	public onconnectionstatechange: ( () => void ) | null = null;
	public ondatachannel:
		| ( ( event: { channel: FakeDataChannel } ) => void )
		| null = null;
	public localChannel: FakeDataChannel | null = null;
	public remoteChannel: FakeDataChannel | null = null;
	public static all: FakePeerConnection[] = [];

	constructor( public config: unknown ) {
		super();
		pcsById.set( this.id, this );
		FakePeerConnection.all.push( this );
	}

	createDataChannel( label: string ): FakeDataChannel {
		this.localChannel = new FakeDataChannel( label );
		return this.localChannel;
	}

	async createOffer(): Promise< RTCSessionDescriptionInit > {
		return { type: 'offer', sdp: this.id };
	}

	async createAnswer(): Promise< RTCSessionDescriptionInit > {
		return { type: 'answer', sdp: this.id };
	}

	async setLocalDescription( d: RTCSessionDescriptionInit ): Promise< void > {
		this.localDescription = d;
		// Trickle: a host candidate turns up right after the description.
		queueMicrotask(
			() =>
				this.onicecandidate?.( {
					candidate: {
						toJSON: () => ( { candidate: 'host:' + this.id } ),
					},
				} )
		);
	}

	async setRemoteDescription(
		d: RTCSessionDescriptionInit
	): Promise< void > {
		this.remoteDescription = d;
		if ( 'answer' === d.type ) {
			const responder = pcsById.get( d.sdp! );
			if ( responder ) {
				FakePeerConnection.connectPair( this, responder );
			}
		}
	}

	public candidates: unknown[] = [];

	async addIceCandidate( candidate: unknown ): Promise< void > {
		this.candidates.push( candidate );
	}

	close(): void {
		this.connectionState = 'closed';
		this.localChannel?.close();
		this.remoteChannel?.close();
	}

	fail(): void {
		this.connectionState = 'failed';
		this.onconnectionstatechange?.();
	}

	static connectPair(
		initiator: FakePeerConnection,
		responder: FakePeerConnection
	): void {
		const dc = initiator.localChannel!;
		const rdc = new FakeDataChannel( dc.label );
		responder.remoteChannel = rdc;
		dc.peer = rdc;
		rdc.peer = dc;
		responder.ondatachannel?.( { channel: rdc } );
		dc.readyState = 'open';
		rdc.readyState = 'open';
		initiator.connectionState = 'connected';
		responder.connectionState = 'connected';
		initiator.onconnectionstatechange?.();
		responder.onconnectionstatechange?.();
		rdc.onopen?.();
		dc.onopen?.();
	}
}

type SignalingModule =
	typeof import('../../../../src/providers/advisory/signaling');
type ChannelModule =
	typeof import('../../../../src/providers/advisory/channel');
type AnnounceModule =
	typeof import('../../../../src/providers/advisory/announce');

interface Tab {
	token: string;
	clientId: number;
	signaling: SignalingModule;
	channel: ChannelModule;
	announce: AnnounceModule;
	send: Hook;
	tick: Hook;
}

const ROOM = 'postType/post:7';
const KEY = 'gutenberg_sync_engines_advisory';
const mailboxes: Map< string, Array< Record< string, string > > > = new Map();

function createTab( token: string, clientId: number, maxPeers = 8 ): Tab {
	let tab: Tab | null = null;
	jest.isolateModules( () => {
		const signaling: SignalingModule = require( '../../../../src/providers/advisory/signaling' );
		const channel: ChannelModule = require( '../../../../src/providers/advisory/channel' );
		const announce: AnnounceModule = require( '../../../../src/providers/advisory/announce' );
		signaling.setAdvisorySettingsForTesting( {
			room: ROOM,
			token,
			iceServers: [],
			maxPeers,
		} );
		signaling.setSyncClientId( clientId );
		mockAdded.length = 0;
		signaling.installSignaling();
		channel.startAdvisoryChannel();
		const send = mockAdded.find(
			( a ) => 'heartbeat.send' === a.hook
		)!.callback;
		const tick = mockAdded.find(
			( a ) => 'heartbeat.tick' === a.hook
		)!.callback;
		tab = { token, clientId, signaling, channel, announce, send, tick };
	} );
	return tab!;
}

/**
 * One heartbeat for a tab: drains its outbox into the peers' mailboxes,
 * then answers with the given peer list and the tab's own mailbox.
 *
 * @param tab   The tab beating.
 * @param peers The other tabs the server reports.
 */
function beat( tab: Tab, peers: Tab[] ): void {
	const data: Record< string, unknown > = {};
	tab.send( data );
	const probe = data[ KEY ] as {
		signals?: Array< Record< string, string > >;
	};
	for ( const signal of probe?.signals ?? [] ) {
		if ( ! mailboxes.has( signal.to ) ) {
			mailboxes.set( signal.to, [] );
		}
		mailboxes.get( signal.to )!.push( {
			id: signal.id,
			from: tab.token,
			kind: signal.kind,
			data: signal.data,
		} );
	}
	tab.tick( {
		[ KEY ]: {
			others: peers.length > 0,
			peers: peers.map( ( peer ) => ( {
				token: peer.token,
				client_id: peer.clientId,
				user_id: 1,
			} ) ),
			signals: mailboxes.get( tab.token )?.splice( 0 ) ?? [],
		},
	} );
}

async function flush(): Promise< void > {
	await jest.advanceTimersByTimeAsync( 60 );
}

/**
 * Runs the whole handshake between two tabs: discovery, offer, answer.
 *
 * @param a The lower-token tab (initiator).
 * @param b The other tab.
 */
async function connectTabs( a: Tab, b: Tab ): Promise< void > {
	beat( a, [ b ] ); // A discovers B and starts an offer.
	await flush();
	beat( a, [ b ] ); // The offer leaves A's outbox.
	beat( b, [ a ] ); // B receives the offer and answers.
	await flush();
	beat( b, [ a ] ); // The answer leaves B's outbox.
	beat( a, [ b ] ); // A receives the answer: connected.
	await flush();
}

describe( 'advisory channel', () => {
	let tabs: Tab[];

	beforeEach( () => {
		jest.useFakeTimers();
		( globalThis as { RTCPeerConnection?: unknown } ).RTCPeerConnection =
			FakePeerConnection;
		( window as { wp?: unknown } ).wp = {
			heartbeat: { interval: jest.fn(), connectNow: jest.fn() },
		};
		mailboxes.clear();
		pcsById.clear();
		FakePeerConnection.all = [];
		tabs = [];
	} );

	afterEach( () => {
		for ( const tab of tabs ) {
			tab.channel.resetAdvisoryChannelForTesting();
			tab.signaling.resetSignalingForTesting();
		}
		jest.useRealTimers();
		delete ( globalThis as { RTCPeerConnection?: unknown } )
			.RTCPeerConnection;
		delete ( window as { wp?: unknown } ).wp;
	} );

	it( 'connects two tabs in two heartbeat hops and exchanges hello, presence, and announcements', async () => {
		const a = createTab( 'tok-a', 1 );
		const b = createTab( 'tok-b', 2 );
		tabs = [ a, b ];
		const announcedAtA = jest.fn();
		a.channel.onAdvisoryAnnounce( announcedAtA );
		const presenceAtB = jest.fn();
		b.channel.onAdvisoryPresence( presenceAtB );
		a.channel.setPresenceSource( () => [
			{ room: ROOM, clientId: 1, state: { cursor: 'p1' } },
		] );

		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );
		await connectTabs( a, b );

		// The hello carried each side's client id: both cover each other,
		// by token and by client id.
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
		expect( b.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
		// A client id nobody on the channel claims is not covered.
		expect( a.channel.advisoryCoversClients( [ 1, 2, 3 ] ) ).toBe( false );

		// Presence flows on the loop, only when it changes.
		await jest.advanceTimersByTimeAsync( 250 );
		expect( b.channel.getChannelPresence( ROOM ) ).toEqual( {
			1: { cursor: 'p1' },
		} );
		expect( presenceAtB ).toHaveBeenCalledWith( ROOM );
		const calls = presenceAtB.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 500 );
		expect( presenceAtB.mock.calls.length ).toBe( calls );

		// A write notice from B tells A to poll; it carries the room only.
		b.announce.announceLocalWrite( ROOM );
		expect( announcedAtA ).toHaveBeenCalledWith( ROOM );
	} );

	it( 'loses coverage and forgets presence when a peer connection fails, then retries', async () => {
		const a = createTab( 'tok-a', 1 );
		const b = createTab( 'tok-b', 2 );
		tabs = [ a, b ];
		a.channel.setPresenceSource( () => [
			{ room: ROOM, clientId: 1, state: { cursor: 'p1' } },
		] );
		await connectTabs( a, b );
		await jest.advanceTimersByTimeAsync( 250 );
		expect( b.channel.getChannelPresence( ROOM ) ).toEqual( {
			1: { cursor: 'p1' },
		} );
		const coverageAtB = jest.fn();
		b.channel.onAdvisoryCoverageChanged( coverageAtB );

		// B's side fails: coverage drops and A's presence is forgotten.
		const bPc = FakePeerConnection.all.find(
			( pc ) => null !== pc.remoteChannel
		)!;
		bPc.fail();
		expect( b.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );
		expect( b.channel.getChannelPresence( ROOM ) ).toEqual( {} );
		expect( coverageAtB ).toHaveBeenCalled();
		// The data channel closed on both ends, so A dropped too.
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );

		// The initiator retries after its backoff; a fresh handshake heals.
		await jest.advanceTimersByTimeAsync( 2000 );
		await connectTabs( a, b );
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
		expect( b.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
	} );

	it( 'sends the description at once and trickles candidates behind it, ignoring a duplicate offer', async () => {
		const a = createTab( 'tok-a', 1 );
		const b = createTab( 'tok-b', 2 );
		tabs = [ a, b ];
		const outgoingFromA: Array< Record< string, string > > = [];
		beat( a, [ b ] );
		await flush();
		// Peek at A's outbox: the offer, then the candidate found after it.
		const data: Record< string, unknown > = {};
		a.send( data );
		const probe = data[ KEY ] as {
			signals: Array< Record< string, string > >;
		};
		outgoingFromA.push( ...probe.signals );
		expect( outgoingFromA.map( ( s ) => s.kind ) ).toEqual( [
			'offer',
			'ice',
		] );
		// Deliver the offer twice (a retried request): B answers once.
		const offer = outgoingFromA[ 0 ];
		for ( const signal of [ offer, offer, outgoingFromA[ 1 ] ] ) {
			if ( ! mailboxes.has( 'tok-b' ) ) {
				mailboxes.set( 'tok-b', [] );
			}
			mailboxes.get( 'tok-b' )!.push( {
				id: signal.id,
				from: 'tok-a',
				kind: signal.kind,
				data: signal.data,
			} );
		}
		beat( b, [ a ] );
		await flush();
		const bOut: Record< string, unknown > = {};
		b.send( bOut );
		const bSignals = (
			bOut[ KEY ] as { signals: Array< Record< string, string > > }
		 ).signals;
		expect( bSignals.filter( ( s ) => 'answer' === s.kind ) ).toHaveLength(
			1
		);
		expect(
			FakePeerConnection.all.filter(
				( pc ) => 'closed' === pc.connectionState
			)
		).toHaveLength( 0 );
	} );

	it( 'buffers a candidate that arrives before its offer and applies it once the offer lands', async () => {
		const a = createTab( 'tok-a', 1 );
		const b = createTab( 'tok-b', 2 );
		tabs = [ a, b ];
		beat( a, [ b ] );
		await flush();
		const data: Record< string, unknown > = {};
		a.send( data );
		const [ offer, ice ] = (
			data[ KEY ] as { signals: Array< Record< string, string > > }
		 ).signals;
		expect( ice.kind ).toBe( 'ice' );
		// The candidate overtakes the offer (two carriers in flight).
		mailboxes.set( 'tok-b', [
			{ id: ice.id, from: 'tok-a', kind: 'ice', data: ice.data },
		] );
		beat( b, [ a ] );
		await flush();
		expect( b.channel.getAdvisoryDebugState().peers ).toHaveLength( 1 );
		mailboxes.set( 'tok-b', [
			{ id: offer.id, from: 'tok-a', kind: 'offer', data: offer.data },
		] );
		beat( b, [ a ] );
		await flush();
		const bPc = FakePeerConnection.all.find(
			( pc ) => null !== pc.remoteDescription
		)!;
		expect( bPc.candidates ).toEqual( [ JSON.parse( ice.data ) ] );
	} );

	it( 'drops a peer whose token disappears from discovery', async () => {
		const a = createTab( 'tok-a', 1 );
		const b = createTab( 'tok-b', 2 );
		tabs = [ a, b ];
		await connectTabs( a, b );
		expect( a.channel.advisoryCoversClients( [] ) ).toBe( true );
		beat( a, [] );
		expect( a.channel.advisoryCoversClients( [] ) ).toBe( false );
		expect( a.channel.getAdvisoryDebugState().peers ).toEqual( [] );
	} );

	it( 'stands down above the peer cap and while the transport disables it', async () => {
		const a = createTab( 'tok-a', 1, 1 );
		const b = createTab( 'tok-b', 2, 1 );
		const c = createTab( 'tok-c', 3, 1 );
		tabs = [ a, b, c ];

		beat( a, [ b, c ] );
		await flush();
		expect( a.channel.isAdvisoryActive() ).toBe( false );
		expect( FakePeerConnection.all ).toHaveLength( 0 );

		// Back under the cap: connects.
		await connectTabs( a, b );
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );

		// The active transport switches it off: peers are told goodbye.
		a.channel.setAdvisoryDisabledByTransport( true );
		expect( a.channel.isAdvisoryActive() ).toBe( false );
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );
		expect( b.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );

		// And back on: reconnects to the discovered peers.
		a.channel.setAdvisoryDisabledByTransport( false );
		await connectTabs( a, b );
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( true );
	} );

	it( 'stays inert without WebRTC or without the signaling lane', () => {
		delete ( globalThis as { RTCPeerConnection?: unknown } )
			.RTCPeerConnection;
		const a = createTab( 'tok-a', 1 );
		tabs = [ a ];
		expect( a.channel.isAdvisoryActive() ).toBe( false );
		expect( a.channel.advisoryCoversClients( [ 1, 2 ] ) ).toBe( false );
	} );
} );
