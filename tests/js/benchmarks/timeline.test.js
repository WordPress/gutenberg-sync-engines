import {
	clockRange,
	measureTimelines,
	validateTimelines,
} from '../../benchmarks/host/timeline.mjs';

const clock = { id: 'server-a', min: 0, max: 0 };
const sample = ( at, cpu, queries = 0 ) => ( {
	at_ms: at,
	cpu_ms: cpu,
	queries,
	option_writes: 0,
} );
const row = ( samples, id = 'request-1' ) => ( {
	request_id: id,
	total_ms: samples.at( -1 ).at_ms - samples[ 0 ].at_ms,
	total_cpu_ms: samples.at( -1 ).cpu_ms,
	db_queries: samples.at( -1 ).queries,
	option_writes: 0,
	peak_memory: 1048576,
	timeline: {
		version: 1,
		request_id: id,
		clock_id: clock.id,
		cpu_available: true,
		clock_stable: true,
		request_start_ms: samples[ 0 ].at_ms,
		samples,
	},
} );

it( 'counts a stream in periods it crosses, regardless of its original label', () => {
	const stream = row( [
		sample( 0, 0 ),
		sample( 20000, 10, 2 ),
		sample( 40000, 15, 4 ),
		sample( 80000, 16, 5 ),
		sample( 100000, 18, 6 ),
	] );
	stream.scenario = 'setup';
	const editing = measureTimelines(
		[ stream ],
		[ { startMs: 20000, endMs: 40000 } ],
		clock,
		1
	);
	const idle = measureTimelines(
		[ stream ],
		[ { startMs: 40000, endMs: 80000 } ],
		clock,
		1
	);
	expect( editing.totals.workerMs ).toEqual( { min: 20000, max: 20000 } );
	expect( idle.totals.workerMs ).toEqual( { min: 40000, max: 40000 } );
	expect( editing.totals.cpu_ms ).toEqual( { min: 5, max: 5 } );
	expect( idle.totals.queries ).toEqual( { min: 1, max: 1 } );
	expect( idle.rates.workerShare ).toEqual( { min: 1, max: 1 } );
} );

it( 'bounds a CPU burst across a boundary instead of spreading it evenly', () => {
	const stream = row( [
		sample( 0, 0 ),
		sample( 9, 0 ),
		sample( 11, 40, 8 ),
		sample( 20, 40, 8 ),
	] );
	const result = measureTimelines(
		[ stream ],
		[ { startMs: 0, endMs: 10 } ],
		clock,
		1
	);
	expect( result.totals.cpu_ms ).toEqual( { min: 0, max: 40 } );
	expect( result.totals.queries ).toEqual( { min: 0, max: 8 } );
	expect( result.totals.workerMs ).toEqual( { min: 10, max: 10 } );
} );

it( 'does not double-count reconnects or adjacent baseline periods', () => {
	const rows = [
		row( [ sample( 0, 0 ), sample( 10, 4, 2 ) ] ),
		row( [ sample( 10, 0 ), sample( 20, 6, 3 ) ], 'request-2' ),
	];
	const result = measureTimelines(
		rows,
		[
			{ startMs: 0, endMs: 10 },
			{ startMs: 10, endMs: 20 },
		],
		clock,
		1
	);
	expect( result.totals.workerMs ).toEqual( { min: 20, max: 20 } );
	expect( result.totals.cpu_ms ).toEqual( { min: 10, max: 10 } );
	expect( result.totals.queries ).toEqual( { min: 5, max: 5 } );
} );

it( 'includes clock uncertainty in the worker-time bounds', () => {
	const stream = row( [ sample( 0, 0 ), sample( 100, 10 ) ] );
	const result = measureTimelines(
		[ stream ],
		[ { startMs: 20, endMs: 80 } ],
		{ ...clock, min: -5, max: 5 },
		1
	);
	expect( result.totals.workerMs ).toEqual( { min: 50, max: 70 } );
} );

it( 'calibrates without assuming symmetric network delay', () => {
	expect(
		clockRange( [
			{
				clock_id: 'a',
				timeline_version: 1,
				at_ms: 110,
				sentMs: 0,
				receivedMs: 20,
			},
		] )
	).toEqual( { id: 'a', min: 90, max: 110 } );
	expect( () => clockRange( [ null ] ) ).toThrow();
	expect( () =>
		clockRange( [ { clock_id: 'a' }, { clock_id: 'b' } ] )
	).toThrow();
} );

it( 'reconciles samples against whole-request totals', () => {
	const good = row( [
		sample( 0, 0 ),
		sample( 50, 2, 1 ),
		sample( 100, 7, 9 ),
	] );
	expect( () =>
		validateTimelines( [ good ], new Set( [ good.request_id ] ), clock )
	).not.toThrow();
	expect(
		measureTimelines( [ good ], [ { startMs: 0, endMs: 100 } ], clock, 1 )
			.totals.cpu_ms
	).toEqual( { min: 7, max: 7 } );
	expect( () =>
		validateTimelines( [ { ...good, db_queries: 10 } ], new Set(), clock )
	).toThrow( 'totals' );
	expect( () =>
		validateTimelines( [ good, good ], new Set(), clock )
	).toThrow( 'duplicate' );
	expect( () =>
		validateTimelines( [ good ], new Set( [ 'killed-worker' ] ), clock )
	).toThrow( 'completed timeline' );
} );

it( 'rejects clock jumps and incomplete samples', () => {
	const backwards = row( [
		sample( 0, 0 ),
		sample( 50, 5 ),
		sample( 40, 9 ),
	] );
	expect( () =>
		validateTimelines( [ backwards ], new Set(), clock )
	).toThrow( 'backwards' );
	const jump = row( [ sample( 0, 0 ), sample( 100, 1 ) ] );
	jump.timeline.clock_stable = false;
	expect( () => validateTimelines( [ jump ], new Set(), clock ) ).toThrow();
	expect( () => validateTimelines( [], new Set(), clock ) ).toThrow();
} );
