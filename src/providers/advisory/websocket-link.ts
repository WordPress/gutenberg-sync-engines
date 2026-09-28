/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { ANY_ROOM } from './announce';
import {
	getAdvisorySettings,
	getPresenceRoom,
	getPresenceToken,
	getSyncClientId,
	installSignaling,
	type DiscoveredPeer,
} from './signaling';
import {
	WEBSOCKET_ADVISORY,
	type AdvisoryLink,
	type AdvisoryLinkHost,
	type PresenceEntry,
} from './link';

/**
 * The WebSocket link of the advisory channel (`channel.ts`): one socket
 * per tab to the plugin's sync daemon (the same daemon and the same
 * one-time token handshake the websocket TRANSPORT uses) — or, in
 * access-token mode, to any relay a host runs that verifies the signed access token
 * (`examples/advisory-relay/`; the format is in
 * docs/plan/advisory-channel.md). The server relays presence and "go
 * and poll" notices between the tabs in a room. The socket carries no
 * rows and the server does no engine work for it: it keeps an in-memory
 * roster per room and fans out what a tab sends (the plugin's daemon
 * also tells the room's tabs when its own once-a-second scan finds rows
 * a writer off the channel landed; a relay cannot, and the heartbeat's
 * head-cursor check covers that). Short polling stays the base transport
 * and every read and write stays on the REST endpoint.
 *
 * Wire (JSON text frames):
 *
 * - client → daemon `{ type: 'advisory', room, client_id, presence_token?,
 *   presence?, announce? }`: subscribes the socket to the room (first
 *   frame), updates this tab's presence for it, or announces rows landed
 *   in the named room (`announce: <room>` or `*`).
 * - daemon → clients `{ type: 'advisory', event: 'roster', room, peers }`:
 *   every subscriber of the room with its token and latest presence,
 *   sent whenever the roster changes.
 * - daemon → clients `{ type: 'advisory', event: 'announce', room }`: a
 *   peer announced, or the daemon's scan found new rows.
 *
 * Coverage is exact: the daemon's roster says which tabs (by token) and
 * which sessions (by client id) are reachable, so a tab that cannot open
 * the socket, or one whose peer has not, keeps the timer cadence.
 */

const WS_TOKEN_API_PATH = '/wp-sync/v1/ws-token';
const SUBPROTOCOL = 'wp-sync';
const TOKEN_PROTOCOL_PREFIX = 'wp-sync-token.';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

interface RosterPeer {
	clientId: number;
	token: string | null;
}

type ServerFrame =
	| {
			type: 'advisory';
			event: 'roster';
			room: string;
			peers: Array< {
				client_id: number;
				token?: string;
				presence?: unknown;
			} >;
	  }
	| { type: 'advisory'; event: 'announce'; room: string }
	| { type: 'error'; code?: string; message?: string };

let host: AdvisoryLinkHost | null = null;
let suspended = false;
let socket: WebSocket | null = null;
let connecting = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType< typeof setTimeout > | null = null;
/** Bumped on every close so a token fetched for a dead attempt is dropped. */
let attempt = 0;
/** Per room, the peers the daemon's last roster listed (own id excluded). */
const rosters: Map< string, Map< number, RosterPeer > > = new Map();
/** The client id this socket declared per room. */
const subscribed: Map< string, number > = new Map();

function socketUrl(): string | null {
	return getAdvisorySettings()?.socketUrl ?? null;
}

function isOpen(): boolean {
	return null !== socket && WebSocket.OPEN === socket.readyState;
}

function wantsConnection(): boolean {
	return null !== host && ! suspended && host.isActive();
}

/**
 * Fetches the handshake credential: a one-time token, or in access-token mode
 * a signed access token allowing the tab's post room (which is why the room is
 * named; a relay refuses follows for rooms the access token does not name).
 */
async function fetchToken(): Promise< string > {
	const room = getPresenceRoom();
	const response = ( await apiFetch( {
		method: 'POST',
		path: WS_TOKEN_API_PATH,
		data: room ? { room } : {},
	} ) ) as { token?: string };
	if ( ! response?.token ) {
		throw new Error( 'Invalid ws-token response' );
	}
	return response.token;
}

function send( frame: Record< string, unknown > ): void {
	if ( ! isOpen() ) {
		return;
	}
	try {
		socket!.send( JSON.stringify( frame ) );
	} catch {
		// A closing socket; the close handler takes it from here.
	}
}

/**
 * Subscribes (or refreshes) this tab in a room, carrying its presence
 * when given. The first frame for a room binds the client id to it.
 *
 * @param room     The room.
 * @param clientId This tab's session client id in the room.
 * @param extra    Presence or announce fields.
 */
function subscribe(
	room: string,
	clientId: number,
	extra: Record< string, unknown > = {}
): void {
	if ( ! isOpen() ) {
		return;
	}
	const known = subscribed.get( room );
	if ( undefined !== known && known !== clientId ) {
		// The daemon binds one client id per socket and room; a session
		// that restarted under a new id needs a fresh socket.
		reopen();
		return;
	}
	subscribed.set( room, clientId );
	const token = getPresenceToken();
	send( {
		type: 'advisory',
		room,
		client_id: clientId,
		...( getPresenceRoom() === room && token
			? { presence_token: token }
			: {} ),
		...extra,
	} );
}

function clearRosters(): void {
	const rooms = Array.from( rosters.keys() );
	for ( const room of rooms ) {
		for ( const peer of rosters.get( room )!.values() ) {
			host?.presence( room, peer.clientId, null );
		}
	}
	rosters.clear();
	subscribed.clear();
}

function applyRoster(
	room: string,
	peers: Array< { client_id: number; token?: string; presence?: unknown } >
): void {
	const own = subscribed.get( room ) ?? getSyncClientId();
	const next: Map< number, RosterPeer > = new Map();
	for ( const peer of peers ) {
		const clientId = Number( peer.client_id );
		if (
			! Number.isFinite( clientId ) ||
			clientId <= 0 ||
			clientId === own
		) {
			continue;
		}
		next.set( clientId, {
			clientId,
			token: 'string' === typeof peer.token ? peer.token : null,
		} );
		host?.presence( room, clientId, peer.presence ?? null );
	}
	const previous = rosters.get( room );
	if ( previous ) {
		for ( const clientId of previous.keys() ) {
			if ( ! next.has( clientId ) ) {
				host?.presence( room, clientId, null );
			}
		}
	}
	rosters.set( room, next );
	host?.coverageChanged();
}

function onMessage( event: MessageEvent ): void {
	let frame: ServerFrame;
	try {
		frame = JSON.parse( String( event.data ) ) as ServerFrame;
	} catch {
		return;
	}
	if (
		! frame ||
		'advisory' !== frame.type ||
		'string' !== typeof frame.room
	) {
		return;
	}
	switch ( frame.event ) {
		case 'roster':
			applyRoster(
				frame.room,
				Array.isArray( frame.peers ) ? frame.peers : []
			);
			break;
		case 'announce':
			host?.announce( frame.room );
			break;
		default:
			break;
	}
}

function clearReconnectTimer(): void {
	if ( reconnectTimer ) {
		clearTimeout( reconnectTimer );
		reconnectTimer = null;
	}
}

function scheduleReconnect(): void {
	if ( reconnectTimer || ! wantsConnection() ) {
		return;
	}
	const delay = Math.min(
		RECONNECT_MAX_MS,
		RECONNECT_BASE_MS * 2 ** reconnectAttempts
	);
	reconnectAttempts++;
	reconnectTimer = setTimeout( () => {
		reconnectTimer = null;
		connect();
	}, delay );
}

function onClose(): void {
	socket = null;
	connecting = false;
	attempt++;
	clearRosters();
	host?.coverageChanged();
	scheduleReconnect();
}

function closeSocket(): void {
	attempt++;
	connecting = false;
	clearReconnectTimer();
	const closing = socket;
	socket = null;
	if ( closing ) {
		closing.removeEventListener( 'message', onMessage );
		closing.removeEventListener( 'close', onClose );
		try {
			closing.close();
		} catch {
			// Already closed.
		}
	}
	clearRosters();
}

function reopen(): void {
	closeSocket();
	host?.coverageChanged();
	connect();
}

/**
 * The socket opened: subscribe this tab to its post's room right away (so
 * the roster carries its token before any presence is sent), then replay
 * the presence the channel last sent, room by room.
 */
function onOpen(): void {
	connecting = false;
	reconnectAttempts = 0;
	const room = getPresenceRoom();
	const clientId = getSyncClientId();
	if ( room && null !== clientId ) {
		subscribe( room, clientId );
	}
	for ( const entry of host?.sentPresence() ?? [] ) {
		subscribe( entry.room, entry.clientId, {
			presence: entry.state ?? null,
		} );
	}
}

function connect(): void {
	if ( connecting || isOpen() || ! wantsConnection() ) {
		return;
	}
	const url = socketUrl();
	if ( ! url || 'function' !== typeof window.WebSocket ) {
		return;
	}
	connecting = true;
	const thisAttempt = attempt;
	fetchToken()
		.then( ( token ) => {
			if ( thisAttempt !== attempt || ! wantsConnection() ) {
				connecting = false;
				return;
			}
			// The token rides the subprotocol offer list, never the URL
			// (query strings land in server and proxy access logs); the
			// daemon consumes it and echoes the base protocol on accept.
			const opened = new window.WebSocket( url, [
				SUBPROTOCOL,
				`${ TOKEN_PROTOCOL_PREFIX }${ token }`,
			] );
			socket = opened;
			opened.addEventListener( 'open', () => {
				if ( socket === opened ) {
					onOpen();
				}
			} );
			opened.addEventListener( 'message', onMessage );
			opened.addEventListener( 'close', onClose );
			opened.addEventListener( 'error', () => {
				if ( socket === opened ) {
					opened.close();
				}
			} );
		} )
		.catch( () => {
			connecting = false;
			if ( thisAttempt === attempt ) {
				scheduleReconnect();
			}
		} );
}

function coversPeers(
	discovered: DiscoveredPeer[],
	clientIds: number[]
): boolean {
	if ( ! isOpen() ) {
		return false;
	}
	const room = getPresenceRoom();
	const roomRoster = room ? rosters.get( room ) : undefined;
	if ( ! roomRoster ) {
		return false;
	}
	const tokens = new Set< string >();
	for ( const peer of roomRoster.values() ) {
		if ( peer.token ) {
			tokens.add( peer.token );
		}
	}
	for ( const peer of discovered ) {
		if ( ! tokens.has( peer.token ) ) {
			return false;
		}
	}
	for ( const id of clientIds ) {
		let reachable = false;
		for ( const roster of rosters.values() ) {
			if ( roster.has( id ) ) {
				reachable = true;
				break;
			}
		}
		if ( ! reachable ) {
			return false;
		}
	}
	return true;
}

export const websocketLink: AdvisoryLink = {
	slug: WEBSOCKET_ADVISORY,

	isAvailable(): boolean {
		return null !== getAdvisorySettings() && null !== socketUrl();
	},

	isStoodDown(): boolean {
		return false;
	},

	start( channel: AdvisoryLinkHost ): void {
		host = channel;
		installSignaling();
		connect();
	},

	stop(): void {
		closeSocket();
		suspended = false;
		reconnectAttempts = 0;
		host = null;
	},

	setSuspended( value: boolean ): void {
		if ( value === suspended ) {
			return;
		}
		suspended = value;
		if ( value ) {
			closeSocket();
			host?.coverageChanged();
		} else {
			reconnectAttempts = 0;
			connect();
		}
	},

	canSend(): boolean {
		return isOpen();
	},

	sendPresence( entry: PresenceEntry ): void {
		subscribe( entry.room, entry.clientId, {
			presence: entry.state ?? null,
		} );
	},

	/**
	 * Announces on the named room's subscription when this socket has
	 * one, else on the post's room (which every peer tab subscribes to),
	 * naming the room written so receivers poll the right one.
	 *
	 * @param room The room written, or `*`.
	 */
	sendAnnounce( room: string ): void {
		const via =
			ANY_ROOM !== room && subscribed.has( room )
				? room
				: getPresenceRoom();
		const clientId = via
			? subscribed.get( via ) ?? getSyncClientId()
			: null;
		if ( ! via || null === clientId ) {
			return;
		}
		subscribe( via, clientId, { announce: room } );
	},

	/**
	 * The tab is going away: close the socket so the daemon drops this
	 * tab from its rosters at once. A page restored from the back-forward
	 * cache is not going away after all; the pending retry brings it
	 * back, the way a discovered peer re-offers over WebRTC.
	 */
	sendBye(): void {
		closeSocket();
		scheduleReconnect();
	},

	coversPeers,

	/**
	 * `peers` lists the TABS on the post room's roster (one entry per
	 * tab, like the WebRTC link's); `rooms` the rooms this socket follows.
	 */
	debugState(): Record< string, unknown > {
		const room = getPresenceRoom();
		const peers: Array< Record< string, unknown > > = [];
		for ( const peer of ( room
			? rosters.get( room )
			: undefined
		)?.values() ?? [] ) {
			peers.push( {
				token: peer.token,
				clientId: peer.clientId,
				open: true,
			} );
		}
		let state = 'closed';
		if ( isOpen() ) {
			state = 'open';
		} else if ( connecting ) {
			state = 'connecting';
		}
		return {
			socket: state,
			attempts: reconnectAttempts,
			peers,
			rooms: Array.from( subscribed.keys() ),
		};
	},

	reset(): void {
		closeSocket();
		host = null;
		suspended = false;
		reconnectAttempts = 0;
		attempt = 0;
	},
};
