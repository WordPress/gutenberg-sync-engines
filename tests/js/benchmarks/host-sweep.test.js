import { matchesDocument } from '../../benchmarks/host/measurement.mjs';
import {
	anchorText,
	bursts,
	expectedTexts,
	postFixture,
} from '../../benchmarks/host/content.mjs';
import {
	baselineKey,
	canonical,
	resultsOf,
	shortHash,
	spanResults,
} from '../../benchmarks/host/record.mjs';
import {
	expandPlan,
	planRuns,
	setupArgs,
} from '../../benchmarks/host/plan.mjs';
import { toCsv } from '../../benchmarks/host/export.mjs';
import {
	chartData,
	chartHtml,
	holdFixed,
} from '../../benchmarks/host/chart.mjs';

describe( 'post fixture', () => {
	it.each( [
		[ 'empty', 2 ],
		[ 'medium', 22 ],
		[ 'large', 202 ],
	] )( '%s post with two people has %i blocks', ( size, blocks ) => {
		const fixture = postFixture( 2, size );
		expect( fixture.blocks ).toBe( blocks );
		expect( fixture.bytes ).toBe(
			Buffer.byteLength( fixture.content, 'utf8' )
		);
		expect( fixture ).toEqual( postFixture( 2, size ) );
	} );

	it( 'spreads the anchors through a long post', () => {
		const { items } = postFixture( 3, 'large' );
		const positions = items
			.map( ( item, index ) =>
				undefined !== item.anchor ? index : -1
			)
			.filter( ( index ) => index >= 0 );
		expect( positions ).toHaveLength( 3 );
		expect( positions[ 0 ] ).toBe( 0 );
		expect( positions[ 1 ] ).toBeGreaterThan( 5 );
		expect( positions[ 2 ] ).toBeGreaterThan( positions[ 1 ] + 5 );
	} );

	it( 'never puts an anchor or a typed word in filler text', () => {
		const { content } = postFixture( 3, 'large' );
		const filler = content.replace( /hostw\danchor/g, '' );
		expect( filler ).not.toMatch( /hostw|w\d+t\d+x/ );
	} );

	it( 'refuses an unknown size', () => {
		expect( () => postFixture( 2, 'huge' ) ).toThrow( 'post-size' );
	} );
} );

describe( 'expected document', () => {
	it( 'own-paragraph matches the original single-paragraph fixture', () => {
		const texts = expectedTexts( {
			windows: 2,
			size: 'empty',
			pattern: 'own-paragraph',
			editSeconds: 30,
			authors: 1,
		} );
		expect( texts ).toHaveLength( 2 );
		expect( texts[ 0 ] ).toMatch( /^hostw0anchor w0t0x w0t1x/ );
		expect( texts[ 1 ] ).toBe( anchorText( 1 ) );
	} );

	it( 'new-blocks adds one paragraph per burst after the anchor', () => {
		const options = {
			windows: 2,
			size: 'empty',
			pattern: 'new-blocks',
			editSeconds: 30,
			authors: 2,
		};
		const texts = expectedTexts( options );
		const { editingScript } = jest.requireActual(
			'../../benchmarks/host/measurement.mjs'
		);
		const burstCount = ( index ) =>
			bursts( editingScript( index, 30000 ) ).length;
		expect( texts ).toHaveLength( 2 + burstCount( 0 ) + burstCount( 1 ) );
		expect( texts[ 0 ] ).toBe( 'hostw0anchor' );
		expect( texts[ 1 ] ).toMatch( /^w0t0x( w0t\d+x)*$/ );
		expect( texts[ 1 + burstCount( 0 ) ] ).toBe( 'hostw1anchor' );
	} );

	it.each( [ 'empty', 'medium', 'large' ] )(
		'the untouched %s fixture passes the content check',
		( size ) => {
			const { content } = postFixture( 3, size );
			const expected = expectedTexts( {
				windows: 3,
				size,
				pattern: 'own-paragraph',
				editSeconds: 30,
				authors: 0,
			} );
			expect( matchesDocument( content, expected ) ).toBe( true );
			// A lost list item or heading fails it.
			expect(
				matchesDocument(
					content.replace(
						/<li>[^<]*<\/li>|<h2[^>]*>[^<]*<\/h2>/,
						''
					),
					expected
				)
			).toBe( 'empty' === size );
		}
	);
} );

describe( 'plans', () => {
	const plan = {
		center: { engine: 'intent-log', windows: 2, postSize: 'medium' },
		vary: [
			{ engine: [ 'intent-log', 'de-rtc' ], windows: [ 1, 2, 3 ] },
			{
				engine: [ 'intent-log', 'de-rtc' ],
				postSize: [ 'empty', 'medium' ],
			},
		],
		repeat: 3,
	};

	it( 'expands groups around the center and measures shared setups once', () => {
		const setups = expandPlan( plan );
		// 6 from the first group; the second adds only the 2 empty posts.
		expect( setups ).toHaveLength( 8 );
		expect( setups[ 0 ].setup ).toEqual( {
			engine: 'intent-log',
			transport: 'http-polling',
			cache: 'none',
			wake: 'auto',
			windows: 1,
			postSize: 'medium',
			pattern: 'own-paragraph',
			editSeconds: 60,
			idleSeconds: 60,
		} );
		expect( new Set( setups.map( ( s ) => s.cell ) ).size ).toBe( 8 );
	} );

	it( 'repeats every setup and shuffles the same way every time', () => {
		const runs = planRuns( plan );
		expect( runs ).toHaveLength( 24 );
		expect( runs.map( ( r ) => `${ r.cell }#${ r.repeat }` ) ).toEqual(
			planRuns( plan ).map( ( r ) => `${ r.cell }#${ r.repeat }` )
		);
		expect( runs.map( ( r ) => r.cell ) ).not.toEqual(
			[ ...runs.map( ( r ) => r.cell ) ].sort()
		);
	} );

	it.each( [
		[ { center: { windows: 2 } }, 'must name an engine' ],
		[ { center: { engine: 'nope' } }, 'engine cannot be' ],
		[
			{ center: { engine: 'de-rtc', people: 2 } },
			'unknown plan variable',
		],
		[ { center: { engine: 'de-rtc', windows: 6 } }, 'windows cannot be' ],
		[
			{ center: { engine: 'de-rtc' }, vary: [ { windows: [] } ] },
			'non-empty list',
		],
		[
			{ center: { engine: 'de-rtc', wake: 'cache' } },
			'needs cache "redis"',
		],
	] )( 'refuses a bad plan: %j', ( bad, message ) => {
		expect( () => expandPlan( bad ) ).toThrow( message );
	} );

	it( 'turns a setup into host benchmark arguments', () => {
		expect(
			setupArgs( {
				engine: 'de-rtc',
				postSize: 'large',
				editSeconds: 90,
				pollingInterval: 0,
			} )
		).toEqual( [
			'engine=de-rtc',
			'post-size=large',
			'edit-seconds=90',
			'polling-interval=0',
		] );
	} );
} );

describe( 'result lines', () => {
	const span = {
		client: {
			requestsPerMinute: 30,
			kbPerMinute: 12,
			wsFramesPerMinute: 0,
		},
		baseClient: {
			requestsPerMinute: 2,
			kbPerMinute: 4,
			wsFramesPerMinute: 0,
		},
		server: {
			requestsPerMinute: 30,
			cpuMsPerMinute: 900,
			workerShare: 0.05,
			dbQueriesPerMinute: 600,
			optionWritesPerMinute: 0,
			peakMemoryMaxMb: 9,
		},
		baseServer: null,
		io: null,
		baseIo: { fsyncsPerMinute: 2 },
	};

	it( 'flattens a span into labeled rows and leaves missing values out', () => {
		const rows = spanResults( 'editing', span );
		const find = ( metric, side ) =>
			rows.find( ( r ) => r.metric === metric && r.side === side );
		expect( find( 'requests_per_person_min', 'sync' ) ).toEqual( {
			phase: 'editing',
			side: 'sync',
			metric: 'requests_per_person_min',
			value: 30,
			unit: 'requests/person-min',
			kind: 'counted',
		} );
		expect( find( 'php_cpu_ms_per_person_min', 'sync' ).kind ).toBe(
			'timed'
		);
		expect( find( 'db_queries_per_php_request', 'sync' ).value ).toBe( 20 );
		// No baseline server numbers, no sync fsync numbers.
		expect(
			find( 'php_cpu_ms_per_person_min', 'baseline' )
		).toBeUndefined();
		expect( find( 'db_fsyncs_per_person_min', 'sync' ) ).toBeUndefined();
		expect( find( 'db_fsyncs_per_person_min', 'baseline' ).value ).toBe(
			2
		);
	} );

	it( 'records a range as its midpoint with its bounds', () => {
		const rows = spanResults( 'editing', {
			...span,
			server: {
				...span.server,
				cpuMsPerMinute: { min: 800, max: 1000 },
				dbQueriesPerMinute: { min: 600, max: 600 },
			},
		} );
		const find = ( metric ) =>
			rows.find( ( r ) => r.metric === metric && r.side === 'sync' );
		expect( find( 'php_cpu_ms_per_person_min' ) ).toMatchObject( {
			value: 900,
			min: 800,
			max: 1000,
		} );
		// Bounds equal once rounded are a plain value.
		expect( find( 'db_queries_per_person_min' ) ).not.toHaveProperty(
			'min'
		);
		expect(
			spanResults( 'editing', {
				...span,
				server: {
					...span.server,
					workerShare: { min: 0.03602201, max: 0.03602204 },
				},
			} ).find(
				( r ) =>
					r.metric === 'php_worker_share_per_person' &&
					r.side === 'sync'
			)
		).not.toHaveProperty( 'min' );
		expect( find( 'db_queries_per_php_request' ).value ).toBe( 20 );
	} );

	it( 'reports peak memory for editing only', () => {
		expect(
			spanResults( 'idle', span ).some(
				( r ) => r.metric === 'php_peak_memory_mib'
			)
		).toBe( false );
	} );

	it( 'adds whole-job and room rows', () => {
		const rows = resultsOf(
			{
				spans: { editing: span, idle: span },
				job: {
					base: {
						tokens: 40,
						requests: 10,
						kb: 20,
						serverCpuS: null,
					},
					sync: { tokens: 40, requests: 80, kb: 40, serverCpuS: 3 },
				},
			},
			{ rows: 12, bytes: 2048 },
			false,
			{
				latencyMs: { p50: 400, p95: 900, p99: 950, max: 1200 },
				scheduleLagMs: { max: 30 },
			}
		);
		expect(
			rows.find( ( r ) => r.metric === 'delivery_p95_ms' )
		).toMatchObject( { phase: 'editing', side: 'sync', value: 900 } );
		expect(
			rows.find( ( r ) => r.metric === 'typing_lag_max_ms' ).value
		).toBe( 30 );
		expect( rows.some( ( r ) => r.phase === 'idle' ) ).toBe( false );
		const job = rows.filter( ( r ) => r.phase === 'job' );
		expect(
			job.find(
				( r ) => r.metric === 'requests_per_word' && r.side === 'sync'
			).value
		).toBe( 2 );
		expect( job.find( ( r ) => r.metric === 'room_kib' ).value ).toBe( 2 );
		expect(
			job.find(
				( r ) => r.metric === 'php_cpu_s' && r.side === 'baseline'
			)
		).toBeUndefined();
	} );

	it( 'keys a baseline phase without engine or transport', () => {
		const environment = {
			pluginCommit: 'abc',
			pluginDirty: false,
			php: '8.3',
			wp: '7.0',
			mysql: '8',
		};
		const setup = {
			engine: 'intent-log',
			transport: 'http-polling',
			windows: 2,
			postSize: 'medium',
			pattern: 'own-paragraph',
			editSeconds: 60,
			idleSeconds: 60,
			cache: 'none',
		};
		const key = ( changes, repeat = 1 ) =>
			shortHash(
				baselineKey(
					{ ...setup, ...changes },
					environment,
					'http://site',
					repeat
				)
			);
		expect( key( { engine: 'de-rtc', transport: 'sse' } ) ).toBe(
			key( {} )
		);
		expect( key( { windows: 3 } ) ).not.toBe( key( {} ) );
		expect( key( {}, 2 ) ).not.toBe( key( {} ) );
	} );

	it( 'writes the same text for the same object whatever the key order', () => {
		expect( canonical( { b: 1, a: { d: [ 2, 1 ], c: null } } ) ).toBe(
			canonical( { a: { c: null, d: [ 2, 1 ] }, b: 1 } )
		);
	} );
} );

describe( 'readers', () => {
	const record = {
		run: { plan: 'p', cell: 'c1', repeat: 1, startedAt: 't' },
		setup: {
			engine: 'de-rtc',
			transport: 'http-polling',
			delivery: 'polling, webrtc',
			windows: 2,
			postSize: 'medium',
			pattern: 'own-paragraph',
		},
		environment: {
			pluginCommit: 'abcdef1234',
			machine: { cpuModel: 'Chip "M"' },
		},
		results: [
			{
				phase: 'editing',
				side: 'sync',
				metric: 'requests_per_person_min',
				value: 30,
				unit: 'requests/person-min',
				kind: 'counted',
			},
			{
				phase: 'editing',
				side: 'baseline',
				metric: 'requests_per_person_min',
				value: 2,
				unit: 'requests/person-min',
				kind: 'counted',
			},
		],
	};

	it( 'exports one CSV row per number, quoting where needed', () => {
		const lines = toCsv( [ record ] ).trim().split( '\n' );
		expect( lines ).toHaveLength( 3 );
		expect( lines[ 0 ] ).toMatch( /^plan,cell,repeat,/ );
		expect( lines[ 1 ] ).toContain( '"polling, webrtc"' );
		expect( lines[ 1 ] ).toContain( '"Chip ""M"""' );
		expect( lines[ 1 ] ).toMatch(
			/,editing,sync,requests_per_person_min,30,,,requests\/person-min,counted$/
		);
	} );

	it( 'builds chart data keyed by phase, metric, and side', () => {
		const data = chartData( [ record ] );
		expect( data.runs[ 0 ] ).toMatchObject( {
			engine: 'de-rtc',
			peers: 2,
			commit: 'abcdef12',
		} );
		expect(
			data.runs[ 0 ].values[ 'editing|requests_per_person_min|baseline' ]
		).toBe( 2 );
	} );

	it( 'holds every other variable at the plan center, else the most common value', () => {
		const run = ( engine, peers, postSize, pattern ) => ( {
			engine,
			peers,
			postSize,
			pattern,
			values: {},
		} );
		const { runs, held } = holdFixed(
			[
				run( 'de-rtc', 1, 'medium', 'own-paragraph' ),
				run( 'de-rtc', 2, 'medium', 'own-paragraph' ),
				run( 'de-rtc', 2, 'large', 'own-paragraph' ),
				run( 'de-rtc', 2, 'large', 'own-paragraph' ),
				run( 'de-rtc', 2, 'medium', 'new-blocks' ),
			],
			{ postSize: 'medium' }
		);
		// medium is the center (though large is as common); own-paragraph
		// is the most common pattern among the medium runs.
		expect( held ).toEqual( [
			[ 'post size', 'medium' ],
			[ 'editing pattern', 'own-paragraph' ],
		] );
		expect( runs.map( ( r ) => r.peers ) ).toEqual( [ 1, 2 ] );
	} );

	it( 'embeds the data so it cannot end the script early', () => {
		const html = chartHtml( [
			{
				...record,
				setup: { ...record.setup, engine: '</script><b>' },
			},
		] );
		expect( html ).not.toContain( '</script><b>' );
		expect( html ).toContain( '\\u003c/script>' );
	} );
} );
