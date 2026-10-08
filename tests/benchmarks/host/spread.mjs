/**
 * How much each metric moves between identical runs: for every setup
 * that ran more than once, the median of the repeats and their spread
 * (lowest to highest, as a share of the median). Run it on the `spread`
 * plan's results to learn which numbers are steady enough to compare,
 * and how big a change has to be before it is more than noise.
 *
 *   node tests/benchmarks/host/spread.mjs results=<results.jsonl> [side=sync|baseline|both]
 *
 * Prints one markdown table per setup, counted metrics first.
 */

import { fileURLToPath } from 'node:url';

import { canonical, cliOptions, readRecords } from './record.mjs';

/**
 * Groups result lines by setup and summarizes each metric's repeats.
 *
 * @param {Array<Object>} records Result lines.
 * @param {Array<string>} sides   Sides to include.
 * @return {Array<Object>} [{ setup, runs, rows: [{ phase, side, metric, unit, kind, n, median, min, max, spread }] }].
 */
export function spreadOf( records, sides = [ 'sync', 'baseline' ] ) {
	const bySetup = new Map();
	for ( const record of records ) {
		const key = canonical( record.setup );
		if ( ! bySetup.has( key ) ) {
			bySetup.set( key, { setup: record.setup, records: [] } );
		}
		bySetup.get( key ).records.push( record );
	}
	const out = [];
	for ( const { setup, records: group } of bySetup.values() ) {
		if ( group.length < 2 ) {
			continue;
		}
		const values = new Map();
		for ( const record of group ) {
			for ( const result of record.results ) {
				if ( ! sides.includes( result.side ) ) {
					continue;
				}
				const key = `${ result.phase }|${ result.side }|${ result.metric }`;
				if ( ! values.has( key ) ) {
					values.set( key, { ...result, values: [] } );
				}
				values.get( key ).values.push( result.value );
			}
		}
		const rows = [ ...values.values() ].map( ( entry ) => {
			const sorted = entry.values.slice().sort( ( a, b ) => a - b );
			const mid = Math.floor( sorted.length / 2 );
			const median =
				sorted.length % 2
					? sorted[ mid ]
					: ( sorted[ mid - 1 ] + sorted[ mid ] ) / 2;
			const min = sorted[ 0 ];
			const max = sorted[ sorted.length - 1 ];
			return {
				phase: entry.phase,
				side: entry.side,
				metric: entry.metric,
				unit: entry.unit,
				kind: entry.kind,
				n: sorted.length,
				median,
				min,
				max,
				// Lowest-to-highest range as a share of the median; null
				// when the median is 0 (a share of nothing means nothing).
				spread:
					0 === median ? null : ( max - min ) / Math.abs( median ),
			};
		} );
		const kindOrder = { counted: 0, timed: 1 };
		rows.sort(
			( a, b ) =>
				kindOrder[ a.kind ] - kindOrder[ b.kind ] ||
				a.phase.localeCompare( b.phase ) ||
				a.metric.localeCompare( b.metric ) ||
				a.side.localeCompare( b.side )
		);
		out.push( { setup, runs: group.length, rows } );
	}
	return out;
}

const number = ( value ) => {
	if ( 0 === value ) {
		return '0';
	}
	const abs = Math.abs( value );
	if ( abs >= 100 ) {
		return value.toFixed( 0 );
	}
	return abs >= 1 ? value.toFixed( 2 ) : value.toFixed( 4 );
};

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const opts = cliOptions();
	if ( ! opts.results ) {
		console.error(
			'usage: node tests/benchmarks/host/spread.mjs results=<results.jsonl> [side=sync|baseline|both]'
		);
		process.exit( 1 );
	}
	const side = String( opts.side ?? 'both' );
	const sides = 'both' === side ? [ 'sync', 'baseline' ] : [ side ];
	const groups = spreadOf( readRecords( String( opts.results ) ), sides );
	if ( ! groups.length ) {
		console.error( 'no setup ran more than once' );
		process.exit( 1 );
	}
	for ( const { setup, runs, rows } of groups ) {
		console.log(
			`\n${ setup.engine } ${ setup.transport } w${ setup.windows } ${ setup.postSize } ${ setup.pattern } ${ setup.editSeconds }s — ${ runs } runs\n`
		);
		console.log(
			'| kind | phase | side | metric | median | lowest | highest | spread |'
		);
		console.log( '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |' );
		for ( const row of rows ) {
			console.log(
				`| ${ row.kind } | ${ row.phase } | ${ row.side } | ${
					row.metric
				} | ${ number( row.median ) } | ${ number(
					row.min
				) } | ${ number( row.max ) } | ${
					null === row.spread
						? '—'
						: `${ Math.round( row.spread * 100 ) }%`
				} |`
			);
		}
	}
}
