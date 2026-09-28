/**
 * Internal dependencies
 */
import {
	attachCounters,
	observeTransport,
	observeSseWait,
	diffCounters,
	deliveryTransport,
} from '../../benchmarks/transport/lib.mjs';

it( 'counts SSE bytes before response completion and identifies the transport', async () => {
	const handlers = {};
	const page = {
		on: jest.fn(),
		context: () => ( {
			newCDPSession: async () => ( {
				on: ( name, handler ) => {
					handlers[ name ] = handler;
				},
				send: jest.fn(),
			} ),
		} ),
	};
	const counters = attachCounters( page );
	await counters.ready;
	const before = counters.snapshot();
	expect( observeSseWait( counters ) ).toBe( 'none' );
	handlers[ 'Network.responseReceived' ]( {
		requestId: '1',
		response: {
			url: 'http://site/?rest_route=%2Fwp-sync%2Fv1%2Fsse',
			status: 200,
			mimeType: 'text/event-stream',
			headers: { 'X-WP-Sync-SSE-Wait': 'version-cache' },
		},
	} );
	expect( observeSseWait( counters ) ).toBe( 'version-cache' );
	handlers[ 'Network.dataReceived' ]( { requestId: '1', dataLength: 120 } );
	expect( observeTransport( counters ) ).toBe( 'sse' );
	expect(
		diffCounters( before, counters.snapshot(), 60000 )
			.responseBytesPerMinute
	).toBe( 120 );
	handlers[ 'Network.loadingFailed' ]( { requestId: '1' } );
	handlers[ 'Network.dataReceived' ]( { requestId: '1', dataLength: 120 } );
	expect( counters.snapshot().sseBytesReceived ).toBe( 120 );
} );

it( 'maps the current settings radio choices', () => {
	expect( deliveryTransport( 'sse' ) ).toBe( 'sse' );
	expect( deliveryTransport( 'polling-webrtc' ) ).toBe( 'http-polling' );
} );

it( 'does not confuse advisory socket traffic with the content transport', async () => {
	const events = {};
	const frames = {};
	const page = {
		on: ( event, handler ) => {
			events[ event ] = handler;
		},
		context: () => ( {
			newCDPSession: async () => ( { on: jest.fn(), send: jest.fn() } ),
		} ),
	};
	const counters = attachCounters( page );
	await counters.ready;
	events.websocket( {
		on: ( event, handler ) => {
			frames[ event ] = handler;
		},
	} );
	frames.framesent( { payload: '{"type":"advisory"}' } );
	frames.framereceived( { payload: '{"type":"advisory","event":"roster"}' } );
	expect( counters.snapshot().wsFramesSent ).toBe( 1 );
	expect( observeTransport( counters ) ).toBe( 'none' );
	events.request( {
		url: () => 'http://site/wp-sync/v1/updates',
		postDataBuffer: () => null,
	} );
	expect( observeTransport( counters ) ).toBe( 'http-polling' );
	frames.framesent( { payload: '{"type":"sync","rooms":[]}' } );
	expect( observeTransport( counters ) ).toBe( 'websocket' );
} );
