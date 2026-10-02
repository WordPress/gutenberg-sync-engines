/*
 * @jest-environment node
 */

/**
 * The example advisory relay (examples/advisory-relay/relay.mjs), run as a
 * real process: separate WordPress installs that share one relay must not
 * see each other's editors or save notices, even though they share its one
 * secret and every single site is blog 1 (issue #126).
 */

/**
 * External dependencies
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

const RELAY = path.resolve(
	__dirname,
	'../../../examples/advisory-relay/relay.mjs'
);
const SECRET = 'shared-secret-for-installs-that-trust-each-other';
const POST_ROOM = 'postType/post:1';
const ROOMS = [ POST_ROOM, 'postType/*', 'taxonomy/*', 'root/*' ];

const b64 = ( value ) => Buffer.from( value ).toString( 'base64url' );

/**
 * Mints an access token the way WP_WebSocket_Access_Token::mint() does.
 *
 * @param {Object} options
 * @param {string} options.iss      The install.
 * @param {string} [options.secret] The signing secret.
 * @param {number} [options.user]   The user id.
 * @return {string} The access token.
 */
function mint( { iss, secret = SECRET, user = 1 } ) {
	const now = Math.floor( Date.now() / 1000 );
	const head = b64( JSON.stringify( { alg: 'HS256', typ: 'JWT' } ) );
	const body = b64(
		JSON.stringify( {
			user_id: user,
			blog_id: 1,
			iss,
			rooms: ROOMS,
			iat: now,
			exp: now + 120,
		} )
	);
	const signature = createHmac( 'sha256', secret )
		.update( `${ head }.${ body }` )
		.digest( 'base64url' );
	return `${ head }.${ body }.${ signature }`;
}

const wait = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

function freePort() {
	return new Promise( ( resolve ) => {
		const server = createServer().listen( 0, () => {
			const { port } = server.address();
			server.close( () => resolve( port ) );
		} );
	} );
}

let relay;
let url;
const sockets = [];

beforeAll( async () => {
	const port = await freePort();
	url = `ws://localhost:${ port }`;
	relay = spawn( process.execPath, [ RELAY ], {
		env: {
			...process.env,
			PORT: String( port ),
			WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET: SECRET,
		},
		stdio: [ 'ignore', 'pipe', 'inherit' ],
	} );
	await new Promise( ( resolve, reject ) => {
		relay.stdout.on( 'data', ( data ) => {
			if ( String( data ).includes( 'listening' ) ) {
				resolve();
			}
		} );
		relay.on( 'exit', ( code ) =>
			reject( new Error( `relay exited with ${ code }` ) )
		);
	} );
} );

afterEach( () => {
	while ( sockets.length ) {
		sockets.pop().close();
	}
} );

afterAll( () => {
	relay?.kill();
} );

/**
 * Opens one editor tab's socket and follows the given rooms.
 *
 * @param {string}   token    The access token.
 * @param {number}   clientId The tab's client id.
 * @param {string}   name     What the roster shows for the tab.
 * @param {string[]} rooms    The rooms to follow.
 * @return {Promise<WebSocket>} The open socket, collecting frames.
 */
function openTab(
	token,
	clientId,
	name,
	rooms = [ POST_ROOM, 'root/comment' ]
) {
	return new Promise( ( resolve, reject ) => {
		const ws = new WebSocket( url, [
			'wp-sync',
			`wp-sync-token.${ token }`,
		] );
		sockets.push( ws );
		ws.frames = [];
		ws.on( 'message', ( data ) => ws.frames.push( JSON.parse( data ) ) );
		ws.on( 'open', () => {
			for ( const room of rooms ) {
				ws.send(
					JSON.stringify( {
						type: 'advisory',
						room,
						client_id: clientId,
						presence: { name },
					} )
				);
			}
			resolve( ws );
		} );
		ws.on( 'unexpected-response', ( _request, response ) =>
			reject( new Error( `refused ${ response.statusCode }` ) )
		);
		ws.on( 'error', reject );
	} );
}

/**
 * The names in the last roster a tab received for a room.
 *
 * @param {WebSocket} ws   The tab.
 * @param {string}    room The room.
 * @return {string[]} The names, sorted.
 */
function rosterNames( ws, room ) {
	const roster = ws.frames
		.filter( ( frame ) => frame.event === 'roster' && frame.room === room )
		.at( -1 );
	return ( roster?.peers ?? [] )
		.map( ( peer ) => peer.presence?.name )
		.sort();
}

const gotAnnounce = ( ws ) =>
	ws.frames.some( ( frame ) => frame.event === 'announce' );

/**
 * Alice (site A) and Bob (site B) edit post 1; a second tab of site A
 * (Carol) shows the relay still works within one install. Alice saves.
 *
 * @param {Object} siteA Token options for site A.
 * @param {Object} siteB Token options for site B.
 * @return {Promise<Object>} The three tabs.
 */
async function aliceSavesBesideBob( siteA, siteB ) {
	const alice = await openTab( mint( { ...siteA, user: 4 } ), 101, 'Alice' );
	const carol = await openTab( mint( { ...siteA, user: 5 } ), 102, 'Carol' );
	const bob = await openTab( mint( { ...siteB, user: 7 } ), 202, 'Bob' );
	await wait( 200 );
	alice.send(
		JSON.stringify( {
			type: 'advisory',
			room: POST_ROOM,
			client_id: 101,
			announce: POST_ROOM,
		} )
	);
	await wait( 200 );
	return { alice, carol, bob };
}

function expectApart( { alice, carol, bob } ) {
	for ( const room of [ POST_ROOM, 'root/comment' ] ) {
		expect( rosterNames( bob, room ) ).toEqual( [ 'Bob' ] );
		expect( rosterNames( alice, room ) ).toEqual( [ 'Alice', 'Carol' ] );
	}
	expect( gotAnnounce( bob ) ).toBe( false );
	expect( gotAnnounce( carol ) ).toBe( true );
}

describe( 'advisory relay shared by two installs', () => {
	test( 'installs sharing its secret stay apart by their install name', async () => {
		expectApart(
			await aliceSavesBesideBob(
				{ iss: 'site-a.example' },
				{ iss: 'site-b.example' }
			)
		);
	} );

	test( 'refuses a token signed with another secret', async () => {
		await expect(
			openTab(
				mint( { iss: 'site-b.example', secret: 'another-secret' } ),
				1,
				'Mallory'
			)
		).rejects.toThrow( 'refused 403' );
	} );

	test( 'refuses an install name that is not a string, as verify() does', async () => {
		await expect(
			openTab( mint( { iss: null } ), 1, 'Mallory' )
		).rejects.toThrow( 'refused 403' );
	} );
} );
