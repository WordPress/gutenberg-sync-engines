import { spawnSync } from 'node:child_process';
import {
	assessRun,
	contentAudit,
	deliveryMeasurements,
	deliveryOptions,
	distribution,
} from '../../benchmarks/host/delivery.mjs';

const scripts = [
	[ { text: ' w0t0x' }, { text: ' w0t1x' } ],
	[ { text: ' w1t0x' } ],
];
const snapshots = () => [
	{
		sent: { w0t0x: { at: 100, lagMs: 0 }, w0t1x: { at: 200, lagMs: 5 } },
		seen: { w0t0x: 100, w0t1x: 200, w1t0x: 550 },
		content: '<p>hostw0anchor w0t0x w0t1x</p><p>hostw1anchor w1t0x</p>',
	},
	{
		sent: { w1t0x: { at: 300, lagMs: 10 } },
		seen: { w0t0x: 150, w0t1x: 300, w1t0x: 300 },
		content: '<p>hostw0anchor w0t0x w0t1x</p><p>hostw1anchor w1t0x</p>',
	},
];
const run = () => ( {
	correct: true,
	delivery: deliveryMeasurements( snapshots(), scripts ),
} );

it( 'accepts custom counts and the old windows alias, including solo runs', () => {
	expect( deliveryOptions( {} ).peers ).toBe( 2 );
	expect( deliveryOptions( { peers: '16' } ).peers ).toBe( 16 );
	expect( deliveryOptions( { windows: '1' } ).peers ).toBe( 1 );
	expect( deliveryOptions( { peers: '5', windows: '5' } ).peers ).toBe( 5 );
	expect( () => deliveryOptions( { peers: '5', windows: '3' } ) ).toThrow(
		'must agree'
	);
} );

it.each( [ '0', '-1', '2.5', '2,4', 'no', true, '' ] )(
	'rejects invalid peer count %s',
	( peers ) => {
		expect( () => deliveryOptions( { peers } ) ).toThrow(
			'positive integer'
		);
	}
);

it( 'validates delivery limits before starting a browser', () => {
	expect( deliveryOptions( {} ) ).toMatchObject( {
		p95Ms: null,
		maxLagMs: 1000,
	} );
	for ( const key of [ 'p95-ms', 'max-lag-ms' ] ) {
		expect( () => deliveryOptions( { [ key ]: '-1' } ) ).toThrow(
			'positive integer'
		);
	}
	const result = spawnSync(
		process.execPath,
		[ 'tests/benchmarks/bench.mjs', '--peers=0' ],
		{ encoding: 'utf8' }
	);
	expect( result.status ).toBe( 1 );
	expect( result.stdout ).toContain( 'suite: host' );
	expect( result.stderr ).toContain( 'peers must be a positive integer' );
} );

it.each( [ '--peers=5', '--windows=5' ] )(
	'forwards %s to the host runner',
	( argument ) => {
		const result = spawnSync(
			process.execPath,
			[ 'tests/benchmarks/bench.mjs', argument, '--edit-seconds=1' ],
			{ encoding: 'utf8' }
		);
		expect( result.status ).toBe( 1 );
		expect( result.stdout ).toContain( 'suite: host' );
		expect( result.stderr ).toContain( 'edit-seconds must be at least 30' );
	}
);

it( 'counts every remote delivery with unequal numbers of edits per writer', () => {
	expect( deliveryMeasurements( snapshots(), scripts ) ).toEqual( {
		expected: 3,
		missing: 0,
		invalid: 0,
		missingInputs: 0,
		latencyMs: { n: 3, p50: 100, p95: 250, p99: 250, max: 250 },
		scheduleLagMs: { n: 3, p50: 5, p95: 10, p99: 10, max: 10 },
	} );
} );

it( 'keeps missing and invalid deliveries separate from measured percentiles', () => {
	const peers = snapshots();
	delete peers[ 0 ].seen.w1t0x;
	peers[ 1 ].seen.w0t1x = 199;
	expect( deliveryMeasurements( peers, scripts ) ).toMatchObject( {
		expected: 3,
		missing: 1,
		invalid: 1,
		latencyMs: { n: 1, p95: 50 },
	} );
	delete peers[ 0 ].sent.w0t0x;
	expect( deliveryMeasurements( peers, scripts ).missing ).toBe( 2 );
} );

it( 'reports percentiles by rank and does not invent a solo delivery time', () => {
	expect(
		distribution( Array.from( { length: 100 }, ( _, i ) => 100 - i ) )
	).toEqual( { n: 100, p50: 50, p95: 95, p99: 99, max: 100 } );
	const delivery = deliveryMeasurements(
		[ snapshots()[ 0 ] ],
		[ scripts[ 0 ] ]
	);
	expect( delivery ).toMatchObject( {
		expected: 0,
		missing: 0,
		latencyMs: null,
	} );
	expect(
		assessRun( { correct: true, delivery }, deliveryOptions( {} ) ).passed
	).toBe( true );
	const solo = snapshots()[ 0 ];
	delete solo.sent.w0t0x;
	expect(
		assessRun(
			{
				correct: true,
				delivery: deliveryMeasurements( [ solo ], [ scripts[ 0 ] ] ),
			},
			deliveryOptions( {} )
		).passed
	).toBe( false );
} );

it( 'fails missing content, missing delivery, invalid time, slow delivery, and slow input independently', () => {
	const limits = deliveryOptions( { 'p95-ms': '200' } );
	expect( assessRun( run(), deliveryOptions( {} ) ).passed ).toBe( true );
	expect( assessRun( run(), limits ).reasons ).toEqual( [
		'Edit delivery exceeded the p95 delay limit.',
	] );
	for ( const change of [
		{ correct: false },
		{ error: 'Typing failed' },
		{ requestErrors: 1 },
		{ pageErrors: 1 },
		{ delivery: { ...run().delivery, missing: 1 } },
		{ delivery: { ...run().delivery, invalid: 1 } },
		{ delivery: { ...run().delivery, scheduleLagMs: { max: 1001 } } },
	] ) {
		expect(
			assessRun( { ...run(), ...change }, deliveryOptions( {} ) ).passed
		).toBe( false );
	}
} );

it( 'detects edits that disappeared after delivery and repeated or unexpected markers', () => {
	const peers = snapshots();
	peers[ 1 ].content = '<p>w0t0x w0t0x w1t0x w9t0x</p>';
	expect( contentAudit( peers, scripts ) ).toMatchObject( {
		editorsAgree: false,
		missingCopies: 1,
		seenThenMissingCopies: 1,
		extraCopies: 1,
		perPeer: [
			{ missing: [] },
			{ missing: [ 'w0t1x' ], unexpected: [ 'w9t0x' ] },
		],
	} );
} );
