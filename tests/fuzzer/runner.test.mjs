import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readReport, replayCommand } from './run.mjs';

test( 'replays preserve the schedule and inherited CPU throttle', () => {
	const command = replayCommand(
		{
			users: 3,
			profile: 'undo',
			faultRate: '0.4',
			burstRate: '0.7',
			noFaults: true,
			noReload: true,
			noLifecycle: true,
		},
		{ combo: 'intent-log/sse-daemon', seed: 17 },
		24,
		{
			RTC_FUZZ_CPU_THROTTLE: '5',
			UNRELATED_SECRET: 'must not appear',
		}
	);
	assert.equal(
		command,
		"RTC_FUZZ_CPU_THROTTLE='5' npm run fuzz -- --combos=intent-log/sse-daemon --seed-list=17 --steps=24 --users=3 --trace=retain-on-failure --profile='undo' --fault-rate='0.4' --burst-rate='0.7' --no-faults --no-reload --no-lifecycle"
	);
} );

test( 'empty, incomplete, and setup-error reports cannot pass a campaign', async () => {
	const directory = await mkdtemp( path.join( os.tmpdir(), 'fuzz-report-' ) );
	const reportPath = path.join( directory, 'report.json' );
	const suite = {
		specs: [
			{
				title: 'seed 1',
				tests: [ { results: [ { status: 'passed' } ] } ],
			},
		],
	};
	try {
		await writeFile( reportPath, JSON.stringify( { suites: [] } ) );
		await assert.rejects(
			readReport( reportPath, [ 1 ] ),
			/Incomplete Playwright report/
		);
		await writeFile( reportPath, JSON.stringify( { suites: [ suite ] } ) );
		await assert.rejects(
			readReport( reportPath, [ 1, 2 ] ),
			/Incomplete Playwright report/
		);
		assert.equal(
			( await readReport( reportPath, [ '1' ] ) )[ 0 ].status,
			'passed'
		);
		await writeFile(
			reportPath,
			JSON.stringify( {
				suites: [ suite ],
				errors: [ { message: 'setup failed' } ],
			} )
		);
		await assert.rejects( readReport( reportPath, [ 1 ] ), /setup failed/ );
	} finally {
		await rm( directory, { recursive: true, force: true } );
	}
} );
