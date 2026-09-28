import { spawnSync } from 'node:child_process';
import {
	attachAllTrafficCounters,
	editingScript,
	matchesDocument,
	serverCoverageLimits,
} from '../../benchmarks/host/measurement.mjs';

it( 'accepts cache and wake controls before workload validation', () => {
	for ( const argument of [ 'cache=none', 'wake=table' ] ) {
		const result = spawnSync(
			process.execPath,
			[
				'tests/benchmarks/host/host-benchmark.mjs',
				argument,
				'edit-seconds=1',
			],
			{ encoding: 'utf8' }
		);
		expect( result.status ).toBe( 1 );
		expect( result.stderr ).not.toContain( 'unknown argument' );
		expect( result.stderr ).toContain( 'edit-seconds must be at least 30' );
	}
} );

it( 'defines complete work before either phase starts', () => {
	const script = editingScript( 1, 30000 );
	expect( script.length ).toBeGreaterThan( 0 );
	expect( script ).toEqual( editingScript( 1, 30000 ) );
	expect( script ).not.toEqual( editingScript( 0, 30000 ) );
	expect(
		script.every(
			( token, index ) =>
				token.at < 30000 &&
				( index === 0 || token.at > script[ index - 1 ].at )
		)
	).toBe( true );
	expect( new Set( script.map( ( token ) => token.text ) ).size ).toBe(
		script.length
	);
} );

describe( 'completed document validation', () => {
	const expected = [ 'hostw0anchor w0t0x w0t1x', 'hostw1anchor w1t0x' ];
	const content =
		'<!-- wp:paragraph {"metadata":{"syncId":"id"}} -->\n<p>hostw0anchor w0t0x w0t1x</p>\n<!-- /wp:paragraph -->\n<p>hostw1anchor w1t0x</p>';
	it( 'accepts the same text with engine metadata and normal serialization whitespace', () => {
		expect( matchesDocument( content, expected ) ).toBe( true );
	} );
	it.each( [
		content.replace( ' w0t1x', '' ),
		content.replace( 'w0t1x', 'w0t1x w0t1x' ),
		content.replace( 'w0t0x w0t1x', 'w0t1x w0t0x' ),
		content + '<p>extra</p>',
		content + '<div>extra</div>',
		undefined,
	] )( 'rejects incomplete or changed content: %s', ( changed ) => {
		expect( matchesDocument( changed, expected ) ).toBe( false );
	} );
} );

it( 'counts socket payloads and open stream bytes once, separately from HTTP requests', async () => {
	const handlers = {};
	const page = {
		on: ( event, handler ) => {
			handlers[ event ] = handler;
		},
	};
	const transport = {
		sseBytesReceived: 20,
		wsBytesSent: 30,
		wsBytesReceived: 40,
		wsFramesSent: 1,
		wsFramesReceived: 2,
	};
	const counters = attachAllTrafficCounters( page, () => transport );
	handlers.request( { postDataBuffer: () => Buffer.alloc( 5 ) } );
	await handlers.response( {
		url: () => 'http://site/other',
		body: async () => Buffer.alloc( 10 ),
	} );
	await handlers.response( {
		url: () => 'http://site/?rest_route=%2Fwp-sync%2Fv1%2Fsse',
		body: async () => {
			throw new Error(
				'An open stream must not be read as a complete body'
			);
		},
	} );
	expect( counters.snapshot() ).toEqual( {
		requests: 1,
		requestBytes: 35,
		responseBytes: 70,
		wsFrames: 3,
	} );
	transport.sseBytesReceived += 7;
	expect( counters.snapshot().responseBytes ).toBe( 77 );
} );

it( 'withholds total server costs when request logs cannot cover them', () => {
	const polling = {
		muMeasurement: true,
		transport: 'http-polling',
		sockets: false,
	};
	expect( serverCoverageLimits( polling ) ).toEqual( [] );
	expect(
		serverCoverageLimits( { ...polling, transport: 'sse' } )[ 0 ]
	).toContain( 'span phases' );
	expect(
		serverCoverageLimits( { ...polling, sockets: true } )[ 0 ]
	).toContain( 'advisory relay' );
	expect(
		serverCoverageLimits( { ...polling, transport: 'websocket' } )[ 0 ]
	).toContain( 'not measured' );
	expect(
		serverCoverageLimits( { ...polling, muMeasurement: false } )[ 0 ]
	).toContain( 'baseline' );
} );
