/** @jest-environment node */
/* eslint jsdoc/check-tag-names: ["error", {"definedTags": ["jest-environment"]}] */
import {
	socketProcessCosts,
	sampleSocketProcesses,
} from '../../benchmarks/host/websocket-costs.mjs';

const before = {
	endpoint: 'http://server/bench-metrics',
	sample: {
		process_id: 'one',
		kind: 'php-websocket',
		elapsed_ms: 100,
		cpu_ms: 20,
		queries: 10,
		memory_bytes: 1024,
		memory_kind: 'php-allocated',
	},
};
const after = {
	...before,
	sample: {
		...before.sample,
		elapsed_ms: 2100,
		cpu_ms: 70,
		queries: 13,
		memory_bytes: 2048,
	},
};

it( 'reports whole-process differences and boundary memory without per-editor division', () => {
	expect( socketProcessCosts( [ before ], [ after ] )[ 0 ] ).toMatchObject( {
		sampledMs: 2000,
		cpuMs: 50,
		queries: 3,
		memoryStartBytes: 1024,
		memoryEndBytes: 2048,
	} );
} );
it.each( [
	{ ...after, error: 'missing' },
	{ ...after, sample: { ...after.sample, process_id: 'restarted' } },
	{ ...after, sample: { ...after.sample, elapsed_ms: 50 } },
	{ ...after, sample: { ...after.sample, cpu_ms: 10 } },
	{ ...after, sample: { ...after.sample, queries: 1 } },
	{ ...after, sample: { ...after.sample, memory_kind: 'rss' } },
	undefined,
] )(
	'does not turn missing or inconsistent samples into zero cost',
	( last ) => {
		expect(
			socketProcessCosts( [ before ], [ last ] )[ 0 ].error
		).toBeTruthy();
	}
);

it( 'rejects a server with missing CPU counters rather than reporting zero', async () => {
	const original = global.fetch;
	global.fetch = async () => ( {
		ok: true,
		json: async () => ( { ...before.sample, version: 1, cpu_ms: null } ),
	} );
	try {
		const rows = await sampleSocketProcesses( [ before.endpoint ] );
		expect( rows[ 0 ].error ).toBeTruthy();
	} finally {
		global.fetch = original;
	}
} );

it( 'retains valid raw samples and driver timing for audit', async () => {
	const original = global.fetch;
	const sample = { ...before.sample, version: 1 };
	global.fetch = async () => ( { ok: true, json: async () => sample } );
	try {
		const rows = await sampleSocketProcesses( [ before.endpoint ] );
		expect( rows[ 0 ].sample ).toEqual( sample );
		expect( rows[ 0 ].receivedMs ).toBeGreaterThanOrEqual(
			rows[ 0 ].sentMs
		);
	} finally {
		global.fetch = original;
	}
} );
