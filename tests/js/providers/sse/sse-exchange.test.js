/**
 * External dependencies
 */
import { ReadableStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';
/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';
/**
 * Internal dependencies
 */
import {
	readSse,
	SseExchange,
} from '../../../../src/providers/sse/sse-exchange';

jest.mock( '@wordpress/api-fetch', () => jest.fn() );
const fetchMock = apiFetch;
const payload = ( after = 0, updates = [] ) => ( {
	rooms: [
		{
			room: 'postType/post:1',
			client_id: 1,
			after,
			awareness: {},
			updates,
		},
	],
} );
const response = ( cursor ) => ( {
	rooms: [
		{
			room: 'postType/post:1',
			end_cursor: cursor,
			awareness: {},
			updates: [],
		},
	],
} );
const frame = ( cursor ) =>
	`event: sync\ndata: ${ JSON.stringify( response( cursor ) ) }\n\n`;
function stream( chunks, close = true ) {
	return new ReadableStream( {
		start( controller ) {
			for ( const chunk of chunks ) {
				controller.enqueue( new TextEncoder().encode( chunk ) );
			}
			if ( close ) {
				controller.close();
			}
		},
	} );
}
function serve( chunks ) {
	fetchMock.mockResolvedValueOnce( {
		ok: true,
		headers: { get: () => 'text/event-stream' },
		body: stream( chunks ),
	} );
}

beforeEach( () => {
	Object.assign( globalThis, { TextEncoder, TextDecoder } );
	fetchMock.mockReset();
} );

it( 'decodes split frames, multiple frames, and ignores heartbeat comments', async () => {
	const text = ': keepalive\n\n' + frame( 1 ) + frame( 2 );
	const items = [];
	for await ( const item of readSse(
		stream( [ text.slice( 0, 35 ), text.slice( 35 ) ] ).getReader()
	) ) {
		items.push( item );
	}
	expect( items ).toEqual( [ response( 1 ), response( 2 ) ] );
} );

it( 'never applies an event cut off by a killed PHP process', async () => {
	const items = [];
	for await ( const item of readSse(
		stream( [ frame( 1 ), frame( 2 ).slice( 0, -2 ) ] ).getReader()
	) ) {
		items.push( item );
	}
	expect( items ).toEqual( [ response( 1 ) ] );
} );

it( 'keeps one response open for successive cursor advances', async () => {
	serve( [ frame( 1 ), frame( 2 ) ] );
	const exchange = new SseExchange();
	expect( await exchange.exchange( payload() ) ).toEqual( response( 1 ) );
	expect( await exchange.exchange( payload( 1 ) ) ).toEqual( response( 2 ) );
	expect( fetchMock ).toHaveBeenCalledTimes( 1 );
	exchange.close();
} );

it( 'reconnects after a kill with the last applied cursor, not a partial event', async () => {
	serve( [ frame( 4 ), frame( 5 ).slice( 0, -2 ) ] );
	serve( [ frame( 6 ) ] );
	const exchange = new SseExchange();
	await exchange.exchange( payload() );
	expect( await exchange.exchange( payload( 4 ) ) ).toEqual( response( 6 ) );
	expect( fetchMock.mock.calls[ 1 ][ 0 ].data.rooms[ 0 ].after ).toBe( 4 );
	exchange.close();
} );

it( 'keeps the stream open when only the awareness state changed', async () => {
	// A cursor move changes the tab's awareness many times a minute; it
	// rides the updates request beside the stream, never a reopen.
	serve( [ frame( 1 ), frame( 2 ) ] );
	const exchange = new SseExchange();
	await exchange.exchange( payload() );
	const signal = fetchMock.mock.calls[ 0 ][ 0 ].signal;
	const moved = payload( 1 );
	moved.rooms[ 0 ].awareness = { cursor: 7 };
	expect( await exchange.exchange( moved ) ).toEqual( response( 2 ) );
	expect( signal.aborted ).toBe( false );
	expect( fetchMock ).toHaveBeenCalledTimes( 1 );
	expect( exchange.isOpen() ).toBe( true );
	exchange.close();
	expect( exchange.isOpen() ).toBe( false );
} );

it( 'refuses a payload carrying updates: sends go beside the stream', async () => {
	serve( [ frame( 1 ) ] );
	const exchange = new SseExchange();
	await exchange.exchange( payload() );
	const signal = fetchMock.mock.calls[ 0 ][ 0 ].signal;
	await expect(
		exchange.exchange( payload( 1, [ { type: 'edit', data: 'x' } ] ) )
	).rejects.toThrow( 'never carries updates' );
	// A programming error, not a stream failure: the stream is untouched.
	expect( signal.aborted ).toBe( false );
	expect( fetchMock ).toHaveBeenCalledTimes( 1 );
	exchange.close();
} );

it( 'is unavailable for a while after a failure, then retries SSE', async () => {
	// While `available` is false the manager receives over ordinary
	// requests on its own; the exchange is simply not asked.
	jest.useFakeTimers();
	fetchMock.mockRejectedValueOnce( { code: 'rest_sse_unavailable' } );
	serve( [ frame( 2 ) ] );
	const exchange = new SseExchange();
	await expect( exchange.exchange( payload() ) ).rejects.toEqual( {
		code: 'rest_sse_unavailable',
	} );
	expect( exchange.available ).toBe( false );
	expect( exchange.isOpen() ).toBe( false );
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( true );
	expect( await exchange.exchange( payload( 1 ) ) ).toEqual( response( 2 ) );
	expect( fetchMock.mock.calls[ 1 ][ 0 ].path ).toBe( '/wp-sync/v1/sse' );
	exchange.close();
	jest.useRealTimers();
} );

it( 'lengthens the polling fallback on repeated failures and resets after a working stream', async () => {
	jest.useFakeTimers();
	const exchange = new SseExchange();
	const fail = async () => {
		fetchMock.mockRejectedValueOnce( { code: 'rest_sse_unavailable' } );
		await expect( exchange.exchange( payload() ) ).rejects.toBeDefined();
	};
	await fail();
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( true );
	await fail();
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( false );
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( true );
	await fail();
	jest.advanceTimersByTime( 15000 );
	expect( exchange.available ).toBe( false );
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( true );
	serve( [ frame( 1 ) ] );
	expect( await exchange.exchange( payload() ) ).toEqual( response( 1 ) );
	fetchMock.mockRejectedValueOnce( { code: 'rest_sse_unavailable' } );
	await expect( exchange.exchange( payload( 1 ) ) ).rejects.toBeDefined();
	jest.advanceTimersByTime( 5000 );
	expect( exchange.available ).toBe( true );
	exchange.close();
	jest.useRealTimers();
} );

it( 'rejects malformed events without advancing the cursor', async () => {
	serve( [ 'event: sync\ndata: {broken}\n\n' ] );
	await expect( new SseExchange().exchange( payload() ) ).rejects.toThrow();
} );

it( 'aborts a waiting stream for a local edit without entering failure backoff', async () => {
	let body;
	fetchMock.mockImplementationOnce( ( { signal } ) =>
		Promise.resolve( {
			ok: true,
			headers: { get: () => 'text/event-stream' },
			body: new ReadableStream( {
				start( controller ) {
					body = controller;
					signal.addEventListener( 'abort', () =>
						controller.error(
							new DOMException( 'Aborted', 'AbortError' )
						)
					);
					controller.enqueue(
						new TextEncoder().encode( frame( 1 ) )
					);
				},
			} ),
		} )
	);
	const exchange = new SseExchange();
	await exchange.exchange( payload() );
	const abort = new AbortController();
	const pending = exchange.exchange( payload( 1 ), abort.signal );
	abort.abort();
	await expect( pending ).rejects.toMatchObject( { name: 'AbortError' } );
	expect( exchange.available ).toBe( true );
	expect( body ).toBeDefined();
} );

it( 'bounds a server that never sends response headers', async () => {
	jest.useFakeTimers();
	fetchMock.mockImplementationOnce(
		( { signal } ) =>
			new Promise( ( resolve, reject ) => {
				signal.addEventListener( 'abort', () =>
					reject( new Error( 'timeout' ) )
				);
			} )
	);
	const exchange = new SseExchange();
	const pending = expect( exchange.exchange( payload() ) ).rejects.toThrow(
		'timeout'
	);
	jest.advanceTimersByTime( 25000 );
	await pending;
	expect( exchange.available ).toBe( false );
	jest.useRealTimers();
} );

it( 'keeps a five-minute stream alive on heartbeats, then aborts when they stop', async () => {
	jest.useFakeTimers();
	let body;
	let signal;
	fetchMock.mockImplementationOnce( ( options ) => {
		signal = options.signal;
		return Promise.resolve( {
			ok: true,
			headers: { get: () => 'text/event-stream' },
			body: new ReadableStream( {
				start( controller ) {
					body = controller;
					signal.addEventListener( 'abort', () =>
						controller.error( new Error( 'timeout' ) )
					);
					controller.enqueue(
						new TextEncoder().encode( frame( 1 ) )
					);
				},
			} ),
		} );
	} );
	const exchange = new SseExchange();
	try {
		await exchange.exchange( payload() );
		const pending = expect(
			exchange.exchange( payload( 1 ) )
		).rejects.toThrow( 'timeout' );
		for ( let elapsed = 0; elapsed < 300000; elapsed += 5000 ) {
			jest.advanceTimersByTime( 5000 );
			body.enqueue( new TextEncoder().encode( ': keepalive\n\n' ) );
			await Promise.resolve();
			await Promise.resolve();
			expect( signal.aborted ).toBe( false );
		}
		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
		jest.advanceTimersByTime( 25000 );
		await pending;
		expect( signal.aborted ).toBe( true );
	} finally {
		exchange.close();
		jest.useRealTimers();
	}
} );
