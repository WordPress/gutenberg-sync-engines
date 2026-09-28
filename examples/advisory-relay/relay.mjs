#!/usr/bin/env node
/**
 * A WebSocket relay for the advisory channel.
 *
 * Each editor tab opens one socket and proves authorization with a token that
 * WordPress signed with a shared secret. The relay keeps a roster of who is
 * present in each room and passes announcements between them. It never sees
 * content, never calls WordPress, and never stores anything.
 *
 * Environment variables:
 *   HOST				    default: localhost
 *   PORT                                   default: 8790
 *   WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET  the secret WordPress signs with
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const SECRET = process.env.WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET;
const PORT = Number( process.env.PORT || 8790 );

if ( ! SECRET ) {
	// eslint-disable-next-line no-console
	console.error( 'Set WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET.' );
	process.exit( 1 );
}

/**
 * Checks an access token and returns its claims, or null.
 *
 * The token is `header.payload.signature`, base64url each. The signature
 * is HMAC-SHA256 over `header.payload`. The claims are `user_id`,
 * `blog_id`, `rooms` (room names, or `<kind>/*`), `iat`, and `exp`.
 *
 * @param {string} token The access token.
 * @return {object|null} The claims, or null.
 */
function verifyAccessToken( token ) {
	const [ header, payload, signature ] = String( token ).split( '.' );
	if ( ! header || ! payload || ! signature ) {
		return null;
	}
	const expected = createHmac( 'sha256', SECRET )
		.update( `${ header }.${ payload }` )
		.digest( 'base64url' );
	if (
		expected.length !== signature.length ||
		! timingSafeEqual( Buffer.from( expected ), Buffer.from( signature ) )
	) {
		return null;
	}
	let claims;
	try {
		const head = JSON.parse( Buffer.from( header, 'base64url' ) );
		if ( head.alg !== 'HS256' ) {
			return null;
		}
		claims = JSON.parse( Buffer.from( payload, 'base64url' ) );
	} catch {
		return null;
	}
	const now = Math.floor( Date.now() / 1000 );
	const valid =
		Number.isInteger( claims.user_id ) &&
		Number.isInteger( claims.blog_id ) &&
		Array.isArray( claims.rooms ) &&
		claims.rooms.every( ( room ) => typeof room === 'string' ) &&
		Number.isInteger( claims.exp ) &&
		now < claims.exp + 30; // 30 s of clock skew.
	return valid ? claims : null;
}

/**
 * Whether the token's rooms allow following a room: an exact name, or
 * `<kind>/*` for a collection room (one without an object id).
 *
 * @param {string[]} rooms The token's rooms.
 * @param {string}   room  The room to follow.
 * @return {boolean} Whether it is allowed.
 */
function allowsRoom( rooms, room ) {
	if ( rooms.includes( room ) ) {
		return true;
	}
	const kind = room.split( '/' )[ 0 ];
	return ! room.includes( ':' ) && rooms.includes( `${ kind }/*` );
}

/**
 * The followers of each room, keyed by site AND room (room names are
 * not site-qualified, and one relay may serve several sites). Each
 * follower entry holds what the roster shows for that tab.
 *
 * @type {Map<string, Map<import('ws').WebSocket, {client_id: number, token: string, presence: object|null}>>}
 */
const rooms = new Map();

const key = ( ws, room ) => `${ ws.claims.blog_id }/${ room }`;
const send = ( ws, frame ) => ws.send( JSON.stringify( frame ) );

/**
 * Sends a room's roster to everyone following it.
 *
 * @param {string} roomKey The site-and-room key.
 * @param {string} room    The room.
 */
function sendRoster( roomKey, room ) {
	const followers = rooms.get( roomKey );
	if ( ! followers ) {
		return;
	}
	const peers = [ ...followers.values() ];
	for ( const ws of followers.keys() ) {
		send( ws, { type: 'advisory', event: 'roster', room, peers } );
	}
}

/**
 * Handles one frame from a tab: `{ type: 'advisory', room, client_id,
 * presence_token?, presence?, announce? }`. Every frame names a room;
 * the first one for that room follows it. Then the frame does one of
 * three things: a bare follow (join the roster), a presence update, or
 * an announce (a room the tab wrote to, for the others to poll).
 *
 * @param {import('ws').WebSocket} ws      The tab's socket.
 * @param {Object}                 message The decoded frame.
 */
function handle( ws, message ) {
	const { room, client_id: clientId } = message;
	if (
		message.type !== 'advisory' ||
		typeof room !== 'string' ||
		! /^[^/]+\/[^/:]+(?::\S+)?$/.test( room ) ||
		! Number.isInteger( clientId ) ||
		clientId < 1
	) {
		send( ws, { type: 'error', code: 'websocket_invalid_advisory' } );
		return;
	}
	const roomKey = key( ws, room );

	const joined = ! rooms.get( roomKey )?.has( ws );
	if ( joined ) {
		if ( ! allowsRoom( ws.claims.rooms, room ) ) {
			send( ws, {
				type: 'error',
				code: 'rest_cannot_edit',
				rooms: [ room ],
			} );
			return;
		}
		if ( ! rooms.has( roomKey ) ) {
			rooms.set( roomKey, new Map() );
		}
		rooms
			.get( roomKey )
			.set( ws, { client_id: clientId, token: '', presence: null } );
	}

	const me = rooms.get( roomKey ).get( ws );
	if ( me.client_id !== clientId ) {
		// One client id per socket and room; another could impersonate
		// a different tab.
		ws.close( 1008, 'client_id mismatch' );
		return;
	}
	if ( typeof message.presence_token === 'string' ) {
		me.token = message.presence_token;
	}

	let action = 'follow';
	if ( 'announce' in message ) {
		action = 'announce';
	} else if ( 'presence' in message ) {
		action = 'presence';
	}

	switch ( action ) {
		case 'presence':
			me.presence =
				message.presence && typeof message.presence === 'object'
					? message.presence
					: null;
			sendRoster( roomKey, room );
			break;

		case 'announce':
			if ( joined ) {
				sendRoster( roomKey, room );
			}
			for ( const peer of rooms.get( roomKey ).keys() ) {
				if ( peer !== ws ) {
					send( peer, {
						type: 'advisory',
						event: 'announce',
						room: message.announce,
					} );
				}
			}
			break;

		case 'follow':
		default:
			sendRoster( roomKey, room );
	}
}

/**
 * A socket closed: leave its rooms and tell the others.
 *
 * @param {import('ws').WebSocket} ws The socket.
 */
function leave( ws ) {
	for ( const [ roomKey, followers ] of rooms ) {
		if ( ! followers.delete( ws ) ) {
			continue;
		}
		if ( followers.size === 0 ) {
			rooms.delete( roomKey );
		} else {
			sendRoster( roomKey, roomKey.slice( roomKey.indexOf( '/' ) + 1 ) );
		}
	}
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

const server = createServer( ( request, response ) => {
	// `GET /health` for monitoring; everything else must upgrade.
	response.writeHead( request.url === '/health' ? 200 : 400 );
	response.end();
} );

const wss = new WebSocketServer( {
	noServer: true,
	maxPayload: 64 * 1024,
	// Echo the base subprotocol only, never the access-token entry.
	handleProtocols: ( offered ) => offered.has( 'wp-sync' ) && 'wp-sync',
} );

server.on( 'upgrade', ( request, socket, head ) => {
	// The access token rides the subprotocol offer, never the URL:
	// `Sec-WebSocket-Protocol: wp-sync, wp-sync-token.<token>`.
	const offers = String( request.headers[ 'sec-websocket-protocol' ] )
		.split( ',' )
		.map( ( offer ) => offer.trim() );
	const token = offers
		.find( ( offer ) => offer.startsWith( 'wp-sync-token.' ) )
		?.slice( 'wp-sync-token.'.length );
	const claims =
		offers.includes( 'wp-sync' ) && token && verifyAccessToken( token );
	if ( ! claims ) {
		socket.end( 'HTTP/1.1 403 Forbidden\r\n\r\n' );
		return;
	}
	wss.handleUpgrade( request, socket, head, ( ws ) => {
		ws.claims = claims;
		ws.alive = true;
		ws.on( 'pong', () => ( ws.alive = true ) );
		ws.on( 'message', ( data ) => {
			try {
				handle( ws, JSON.parse( data ) );
			} catch {
				send( ws, {
					type: 'error',
					code: 'websocket_invalid_message',
				} );
			}
		} );
		ws.on( 'close', () => leave( ws ) );
	} );
} );

// Keepalive at 15s: a tab that misses a ping is gone.
setInterval( () => {
	for ( const ws of wss.clients ) {
		if ( ! ws.alive ) {
			ws.terminate();
			continue;
		}
		ws.alive = false;
		ws.ping();
	}
}, 15000 );

server.listen( PORT, () => {
	// eslint-disable-next-line no-console
	console.log( `[advisory-relay] listening on port ${ PORT }` );
} );
