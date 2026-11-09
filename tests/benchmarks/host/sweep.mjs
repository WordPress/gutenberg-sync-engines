/**
 * The host benchmark sweep: runs the host benchmark once per run of a
 * plan and collects every result line into one results file — the data
 * set behind the CSV export and the chart page.
 *
 *   node tests/benchmarks/host/sweep.mjs plan=scaling
 *   node tests/benchmarks/host/sweep.mjs plan=scaling dry-run=1
 *   npm run bench -- --suite=sweep --plan=scaling
 *
 * Arguments (bare key=value, like every benchmark here):
 *
 *   plan=      a plan name (tests/benchmarks/host/plans/<name>.json) or
 *              a path to a plan file; plan.mjs documents the format
 *   out=       output directory (default bench-results/host/<plan name>)
 *   dry-run=1  list the runs and exit
 *   max-runs=  stop after this many runs (to spread a sweep over time)
 *   headed=1   visible browsers (debugging)
 *
 * What it writes in the output directory:
 *
 *   results.jsonl  one result line per finished run (record.mjs)
 *   failures.jsonl one line per failed run, with the end of its log
 *   results.csv    the results as one row per number (export.mjs)
 *   chart.html     a chart page built from the results (chart.mjs)
 *   baselines/     saved plugin-off phases, reused across engines
 *   details/       each run's full JSON report
 *   logs/          each run's console output
 *   plan.json      the plan as it was run
 *
 * RESUMING: a run already in results.jsonl for the same plan, setup,
 * repeat, and plugin commit is skipped, so rerunning the same command
 * after a stop (or a failure) picks up where it left off. Failed runs
 * are retried. Once a setup fails, its remaining repeats are skipped
 * for the rest of that sweep: a setup that fails usually fails every
 * time (an engine problem the run found), and each try costs minutes.
 * After three failures in a row the sweep stops: that is nearly always
 * the environment (a stopped site, an inactive plugin), not the setups.
 *
 * Requires what the host benchmark requires (a running site, the
 * plugin active, Playwright's chromium). Environment: WP_BASE_URL /
 * WP_USERNAME / WP_PASSWORD as usual, passed through to every run.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliOptions } from '../transport/lib.mjs';
import { planRuns, setupArgs, setupLabel } from './plan.mjs';
import { readRecords } from './record.mjs';
import { writeCsv } from './export.mjs';
import { writeChart } from './chart.mjs';

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = path.resolve( HERE, '../../..' );
const opts = parseCliOptions();

const KNOWN = [ 'plan', 'out', 'dry-run', 'max-runs', 'headed', 'help' ];
const unknown = Object.keys( opts ).filter(
	( key ) => ! KNOWN.includes( key )
);
if ( opts.help || ! opts.plan || unknown.length ) {
	if ( unknown.length ) {
		console.error( `unknown argument(s): ${ unknown.join( ', ' ) }` );
	}
	console.error(
		'usage: node tests/benchmarks/host/sweep.mjs plan=<name|path> [out=<dir>] [dry-run=1] [max-runs=N] [headed=1]'
	);
	process.exit( opts.help ? 0 : 1 );
}

const planPath = fs.existsSync( String( opts.plan ) )
	? String( opts.plan )
	: path.join( HERE, 'plans', `${ opts.plan }.json` );
const plan = JSON.parse( fs.readFileSync( planPath, 'utf8' ) );
const planName = plan.name ?? path.basename( planPath, '.json' );
const outDir = path.resolve(
	REPO_ROOT,
	String( opts.out ?? path.join( 'bench-results', 'host', planName ) )
);
const runs = planRuns( plan );
const MAX_RUNS = opts[ 'max-runs' ] ? Number( opts[ 'max-runs' ] ) : Infinity;

const commit = execFileSync( 'git', [ 'rev-parse', 'HEAD' ], {
	cwd: REPO_ROOT,
	encoding: 'utf8',
} ).trim();
const dirty = Boolean(
	execFileSync( 'git', [ 'status', '--porcelain' ], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
	} ).trim()
);

const resultsFile = path.join( outDir, 'results.jsonl' );
const runKey = ( cell, repeat ) => `${ cell }#${ repeat }`;
const done = new Set(
	readRecords( resultsFile )
		.filter(
			( record ) =>
				record.run?.plan === planName &&
				record.environment?.pluginCommit === commit
		)
		.map( ( record ) => runKey( record.run.cell, record.run.repeat ) )
);
const pending = runs.filter(
	( run ) => ! done.has( runKey( run.cell, run.repeat ) )
);

console.log( `plan: ${ planName } (${ planPath })` );
console.log(
	`runs: ${ runs.length } (${ runs.length / ( plan.repeat ?? 1 ) } setups × ${
		plan.repeat ?? 1
	} repeats), ${ runs.length - pending.length } already done, ${
		pending.length
	} to run`
);
console.log( `output: ${ outDir }` );
if ( dirty ) {
	console.log(
		'WARNING: the working tree has uncommitted changes — results are recorded against the last commit, which does not fully describe the code measured'
	);
}

if ( opts[ 'dry-run' ] ) {
	pending.forEach( ( run, index ) =>
		console.log(
			`  ${ index + 1 }. ${ setupLabel( run.setup ) } r${
				run.repeat
			}  [${ run.cell }]`
		)
	);
	process.exit( 0 );
}

for ( const dir of [ 'baselines', 'details', 'logs' ] ) {
	fs.mkdirSync( path.join( outDir, dir ), { recursive: true } );
}
fs.writeFileSync(
	path.join( outDir, 'plan.json' ),
	JSON.stringify( plan, null, 2 ) + '\n'
);

// On macOS, keep the machine from idle-sleeping for as long as this
// process lives (closing a laptop's lid on battery still sleeps it; the
// host benchmark refuses a span the machine slept through).
if ( 'darwin' === process.platform ) {
	spawn( 'caffeinate', [ '-i', '-s', '-w', String( process.pid ) ], {
		stdio: 'ignore',
		detached: true,
	} ).unref();
}

let child = null;
let stopping = false;
const onSignal = ( signal ) => {
	stopping = true;
	console.error(
		`\n${ signal } — letting the current run restore the site, then stopping…`
	);
	// The host benchmark restores site state on SIGINT/SIGTERM itself.
	child?.kill( signal );
};
process.on( 'SIGINT', () => onSignal( 'SIGINT' ) );
process.on( 'SIGTERM', () => onSignal( 'SIGTERM' ) );

/**
 * Runs the host benchmark for one run, its output going to a log file.
 *
 * @param {Object} run     Planned run.
 * @param {string} logFile Log path.
 * @return {Promise<number>} Exit code.
 */
function runOne( run, logFile ) {
	const name = `${ run.cell }-r${ run.repeat }`;
	const args = [
		path.join( HERE, 'host-benchmark.mjs' ),
		...setupArgs( run.setup ),
		`record=${ resultsFile }`,
		`baseline-cache=${ path.join( outDir, 'baselines' ) }`,
		`json=${ path.join( outDir, 'details', `${ name }.json` ) }`,
		`plan=${ planName }`,
		`cell=${ run.cell }`,
		`repeat=${ run.repeat }`,
		...( opts.headed ? [ 'headed=1' ] : [] ),
	];
	const log = fs.openSync( logFile, 'w' );
	return new Promise( ( resolve ) => {
		child = spawn( process.execPath, args, {
			cwd: REPO_ROOT,
			stdio: [ 'ignore', log, log ],
		} );
		child.on( 'exit', ( code, signal ) => {
			fs.closeSync( log );
			child = null;
			if ( null !== code ) {
				resolve( code );
			} else {
				resolve( signal ? 130 : 1 );
			}
		} );
	} );
}

const durations = [];
const formatSeconds = ( seconds ) =>
	`${ Math.floor( seconds / 60 ) }m${ String(
		Math.round( seconds % 60 )
	).padStart( 2, '0' ) }s`;
let consecutiveFailures = 0;
let ran = 0;
const failedCells = new Set();
for ( const [ index, run ] of pending.entries() ) {
	if ( stopping || ran >= MAX_RUNS ) {
		break;
	}
	if ( failedCells.has( run.cell ) ) {
		console.log(
			`[${ index + 1 }/${ pending.length }] ${ setupLabel(
				run.setup
			) } r${
				run.repeat
			} … skipped (this setup failed earlier in this sweep)`
		);
		continue;
	}
	const name = `${ run.cell }-r${ run.repeat }`;
	const logFile = path.join( outDir, 'logs', `${ name }.log` );
	const eta = durations.length
		? ` — about ${ formatSeconds(
				( durations.reduce( ( a, b ) => a + b, 0 ) /
					durations.length ) *
					( Math.min( pending.length, MAX_RUNS ) - index )
		  ) } left`
		: '';
	process.stdout.write(
		`[${ index + 1 }/${ pending.length }] ${ setupLabel( run.setup ) } r${
			run.repeat
		}${ eta } … `
	);
	const started = Date.now();
	const code = await runOne( run, logFile );
	const seconds = ( Date.now() - started ) / 1000;
	ran++;
	if ( 0 === code ) {
		durations.push( seconds );
		consecutiveFailures = 0;
		console.log( `ok (${ formatSeconds( seconds ) })` );
		continue;
	}
	const tail = fs
		.readFileSync( logFile, 'utf8' )
		.trimEnd()
		.split( '\n' )
		.slice( -15 )
		.join( '\n' );
	fs.appendFileSync(
		path.join( outDir, 'failures.jsonl' ),
		JSON.stringify( {
			plan: planName,
			cell: run.cell,
			repeat: run.repeat,
			setup: run.setup,
			pluginCommit: commit,
			at: new Date().toISOString(),
			exitCode: code,
			log: logFile,
			tail,
		} ) + '\n'
	);
	console.log( `FAILED (exit ${ code }; log: ${ logFile })` );
	failedCells.add( run.cell );
	if ( stopping ) {
		break;
	}
	if ( ++consecutiveFailures >= 3 ) {
		console.error(
			'three failures in a row — stopping (check the environment: npm run doctor). The last one ended with:\n' +
				tail
		);
		break;
	}
}

const records = readRecords( resultsFile );
if ( records.length ) {
	const csv = writeCsv( records, path.join( outDir, 'results.csv' ) );
	const chart = writeChart( records, path.join( outDir, 'chart.html' ), {
		plan,
	} );
	console.log( '' );
	console.log( `results: ${ resultsFile } (${ records.length } runs)` );
	console.log( `csv:     ${ csv }` );
	console.log( `chart:   ${ chart }` );
}
process.exit( stopping ? 130 : 0 );
