/**
 * Exports host benchmark result lines as CSV: one row per number, with
 * the run's setup and environment repeated on every row. That "one
 * number per row" shape loads as-is into a spreadsheet pivot table,
 * pandas, R, or a charting tool, and keeps working when metrics are
 * added.
 *
 *   node tests/benchmarks/host/export.mjs results=<results.jsonl> [out=<file.csv>]
 *
 * Without out= the CSV goes to standard output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliOptions, readRecords } from './record.mjs';

// CSV columns: [ header, value reader ].
export const COLUMNS = [
	[ 'plan', ( r ) => r.run.plan ],
	[ 'cell', ( r ) => r.run.cell ],
	[ 'repeat', ( r ) => r.run.repeat ],
	[ 'started_at', ( r ) => r.run.startedAt ],
	[ 'baseline_reused', ( r ) => r.run.baselineReused ],
	[ 'engine', ( r ) => r.setup.engine ],
	[ 'transport', ( r ) => r.setup.transport ],
	[ 'delivery', ( r ) => r.setup.delivery ],
	[ 'cache', ( r ) => r.setup.cache ],
	[ 'wake', ( r ) => r.setup.wake ],
	[ 'windows', ( r ) => r.setup.windows ],
	[ 'post_size', ( r ) => r.setup.postSize ],
	[ 'post_blocks', ( r ) => r.setup.postBlocks ],
	[ 'post_bytes', ( r ) => r.setup.postBytes ],
	[ 'post_hash', ( r ) => r.setup.postHash ],
	[ 'pattern', ( r ) => r.setup.pattern ],
	[ 'edit_seconds', ( r ) => r.setup.editSeconds ],
	[ 'idle_seconds', ( r ) => r.setup.idleSeconds ],
	[ 'polling_interval', ( r ) => r.setup.pollingInterval ],
	[ 'plugin_commit', ( r ) => r.environment.pluginCommit ],
	[ 'plugin_dirty', ( r ) => r.environment.pluginDirty ],
	[ 'gutenberg_pin', ( r ) => r.environment.gutenbergPin ],
	[ 'php', ( r ) => r.environment.php ],
	[ 'wp', ( r ) => r.environment.wp ],
	[ 'mysql', ( r ) => r.environment.mysql ],
	[ 'runner', ( r ) => r.environment.runner ],
	[ 'machine', ( r ) => r.environment.machine?.cpuModel ],
];

const RESULT_COLUMNS = [
	'phase',
	'side',
	'metric',
	'value',
	'min',
	'max',
	'unit',
	'kind',
];

/**
 * Quotes a CSV field when it needs it.
 *
 * @param {*} value Field value.
 * @return {string} CSV field.
 */
function field( value ) {
	if ( null === value || undefined === value ) {
		return '';
	}
	const text = String( value );
	return /[",\n]/.test( text ) ? `"${ text.replace( /"/g, '""' ) }"` : text;
}

/**
 * Converts result lines to CSV text.
 *
 * @param {Array<Object>} records Result lines.
 * @return {string} CSV.
 */
export function toCsv( records ) {
	const lines = [
		[ ...COLUMNS.map( ( [ header ] ) => header ), ...RESULT_COLUMNS ].join(
			','
		),
	];
	for ( const record of records ) {
		const fixed = COLUMNS.map( ( [ , read ] ) => field( read( record ) ) );
		for ( const result of record.results ) {
			lines.push(
				[
					...fixed,
					...RESULT_COLUMNS.map( ( key ) => field( result[ key ] ) ),
				].join( ',' )
			);
		}
	}
	return lines.join( '\n' ) + '\n';
}

/**
 * Writes result lines as a CSV file.
 *
 * @param {Array<Object>} records Result lines.
 * @param {string}        file    Output path.
 * @return {string} Output path.
 */
export function writeCsv( records, file ) {
	fs.writeFileSync( file, toCsv( records ) );
	return file;
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const opts = cliOptions();
	if ( ! opts.results ) {
		console.error(
			'usage: node tests/benchmarks/host/export.mjs results=<results.jsonl> [out=<file.csv>]'
		);
		process.exit( 1 );
	}
	const records = readRecords( String( opts.results ) );
	if ( opts.out ) {
		console.log( writeCsv( records, path.resolve( String( opts.out ) ) ) );
	} else {
		process.stdout.write( toCsv( records ) );
	}
}
