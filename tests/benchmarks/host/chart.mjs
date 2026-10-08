/**
 * Builds a self-contained chart page from host benchmark result lines.
 * Deliberately simple: one drop-down picks the metric; the chart puts
 * the number of peers along the bottom and the metric's unit up the
 * side, and draws up to eight lines:
 *
 *   - without the plugin, while editing (gray dotted) and while idle
 *     (gray dash-dot). The plugin-off phase is one person at a time, so
 *     each is one value (the median of every plugin-off measurement),
 *     drawn flat across every peer count.
 *   - each engine while editing (solid) and while idle (dashed).
 *
 * A metric about typing has no idle lines (nobody types while idle),
 * and edit delivery has no plugin-off line (nobody receives edits).
 *
 * Each point is the median of the repeats. When the results hold more
 * than one value of another variable (post size, pattern, …), the page
 * keeps the plan's center value (else the most common one) and says so
 * under the title, so every point compares like with like.
 *
 *   node tests/benchmarks/host/chart.mjs results=<results.jsonl> [out=<chart.html>] [plan=<plan name|path>]
 *
 * The sweep runner writes one next to its results automatically. The
 * page needs no network: the data and the drawing code are inline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliOptions, readRecords } from './record.mjs';

// Variables held fixed (all but peers and engine), with their labels.
const HELD = [
	[ 'transport', 'transport' ],
	[ 'postSize', 'post size' ],
	[ 'pattern', 'editing pattern' ],
	[ 'editSeconds', 'editing seconds' ],
	[ 'idleSeconds', 'idle seconds' ],
	[ 'cache', 'object cache' ],
	[ 'pollingInterval', 'polling interval' ],
	[ 'commit', 'plugin commit' ],
	[ 'machine', 'machine' ],
];

// The metrics the drop-down offers, in order, with plain names and units.
// Metrics not listed here (whole-job totals, room size) are left out:
// they have no editing or idle value to draw.
export const CHART_METRICS = [
	[
		'php_worker_share_per_person',
		'PHP worker share',
		'share of one PHP worker per person',
	],
	[ 'php_peak_memory_mib', 'Peak PHP memory', 'MiB per request' ],
	[ 'php_requests_per_person_min', 'PHP requests', 'per person per minute' ],
	[
		'payload_kib_per_person_min',
		'Data sent and received',
		'KiB per person per minute',
	],
	[
		'db_queries_per_person_min',
		'Database queries',
		'per person per minute',
	],
	[ 'db_fsyncs_per_person_min', 'Database fsyncs', 'per person per minute' ],
	[
		'option_writes_per_person_min',
		'Options-cache invalidations',
		'per person per minute',
	],
	[ 'typing_lag_max_ms', 'Longest typing delay', 'ms' ],
	[ 'delivery_p50_ms', 'Edit delivery, median', 'ms' ],
	[ 'delivery_p95_ms', 'Edit delivery, 95th percentile', 'ms' ],
	[ 'delivery_max_ms', 'Edit delivery, slowest', 'ms' ],
];

/**
 * Reduces result lines to what the page needs.
 *
 * @param {Array<Object>} records Result lines.
 * @return {Object} { runs }, each run's values keyed phase|metric|side.
 */
export function chartData( records ) {
	const runs = records.map( ( record ) => {
		const values = {};
		for ( const result of record.results ) {
			values[ `${ result.phase }|${ result.metric }|${ result.side }` ] =
				result.value;
		}
		return {
			engine: record.setup.engine,
			peers: record.setup.windows,
			transport: record.setup.transport,
			postSize: record.setup.postSize,
			pattern: record.setup.pattern,
			editSeconds: record.setup.editSeconds,
			idleSeconds: record.setup.idleSeconds,
			cache: record.setup.cache,
			pollingInterval: record.setup.pollingInterval,
			commit: ( record.environment.pluginCommit ?? '' ).slice( 0, 8 ),
			machine: record.environment.machine?.cpuModel ?? 'unknown',
			values,
		};
	} );
	return { runs };
}

/**
 * Keeps the runs that match one value of every held variable: the plan's
 * center value when the results have it, else the most common value.
 *
 * @param {Array<Object>} runs   chartData runs.
 * @param {Object}        center The plan's center setup.
 * @return {Object} { runs, held: [ [ label, value ] ] for varied variables }.
 */
export function holdFixed( runs, center = {} ) {
	const held = [];
	let kept = runs;
	for ( const [ key, label ] of HELD ) {
		const counts = new Map();
		for ( const run of kept ) {
			counts.set( run[ key ], ( counts.get( run[ key ] ) ?? 0 ) + 1 );
		}
		if ( counts.size < 2 ) {
			continue;
		}
		const value = counts.has( center[ key ] )
			? center[ key ]
			: [ ...counts ].sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ][ 0 ];
		kept = kept.filter( ( run ) => run[ key ] === value );
		held.push( [ label, value ] );
	}
	return { runs: kept, held };
}

/**
 * The page.
 *
 * @param {Array<Object>} records      Result lines.
 * @param {Object}        options
 * @param {Object|null}   options.plan The plan, whose center is kept.
 * @return {string} HTML.
 */
export function chartHtml( records, { plan = null } = {} ) {
	const { runs, held } = holdFixed(
		chartData( records ).runs,
		plan?.center ?? {}
	);
	const data = {
		runs,
		held,
		metrics: CHART_METRICS,
		title: plan?.name ? `Host benchmark: ${ plan.name }` : 'Host benchmark',
	};
	const json = JSON.stringify( data ).replace( /</g, '\\u003c' );
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host Benchmark Chart</title>
<style>
:root {
	color-scheme: light;
	--surface: #fcfcfb;
	--panel: #f4f3f0;
	--text-primary: #0b0b0b;
	--text-secondary: #52514e;
	--text-muted: #75746f;
	--grid: #e6e5e1;
	--axis: #b5b4ae;
	--baseline: #75746f;
	--series-1: #2a78d6;
	--series-2: #eb6834;
	--series-3: #1baf7a;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		color-scheme: dark;
		--surface: #1a1a19;
		--panel: #242422;
		--text-primary: #ffffff;
		--text-secondary: #c3c2b7;
		--text-muted: #9a998f;
		--grid: #33332f;
		--axis: #5c5b55;
		--baseline: #9a998f;
		--series-1: #3987e5;
		--series-2: #d95926;
		--series-3: #199e70;
	}
}
:root[data-theme="dark"] {
	color-scheme: dark;
	--surface: #1a1a19;
	--panel: #242422;
	--text-primary: #ffffff;
	--text-secondary: #c3c2b7;
	--text-muted: #9a998f;
	--grid: #33332f;
	--axis: #5c5b55;
	--baseline: #9a998f;
	--series-1: #3987e5;
	--series-2: #d95926;
	--series-3: #199e70;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--surface);
	color: var(--text-primary);
	font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.held { color: var(--text-muted); font-size: 12px; margin: 0 0 16px; }
select {
	font: inherit; color: var(--text-primary); background: var(--panel);
	border: 1px solid var(--axis); border-radius: 6px; padding: 6px 10px;
	max-width: 100%; margin-bottom: 12px;
}
.figure { position: relative; }
svg { display: block; overflow: visible; }
svg text { fill: var(--text-secondary); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-size: 13px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend svg { width: 28px; height: 10px; }
.tip {
	position: absolute; pointer-events: none; background: var(--panel); color: var(--text-primary);
	border: 1px solid var(--axis); border-radius: 6px; padding: 6px 8px; font-size: 12px;
	white-space: nowrap; display: none; box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
}
.empty { padding: 48px 0; text-align: center; color: var(--text-muted); }
</style>
</head>
<body>
<main>
<h1 id="title"></h1>
<p class="held" id="held"></p>
<select id="metric" aria-label="Metric"></select>
<div class="figure" id="figure"><div class="tip" id="tip"></div></div>
<div class="legend" id="legend"></div>
</main>
<script>
const DATA = ${ json };
const $ = ( id ) => document.getElementById( id );
const ENGINES = [ 'intent-log', 'yjs-server', 'de-rtc' ];
const PHASES = [ [ 'editing', 'editing', '' ], [ 'idle', 'idle', '6 5' ] ];

const median = ( values ) => {
	const sorted = values.slice().sort( ( a, b ) => a - b );
	const mid = Math.floor( sorted.length / 2 );
	return sorted.length % 2 ? sorted[ mid ] : ( sorted[ mid - 1 ] + sorted[ mid ] ) / 2;
};
const valuesOf = ( runs, key ) =>
	runs.map( ( run ) => run.values[ key ] ).filter( ( v ) => undefined !== v );
const fmt = ( v ) => {
	if ( 0 === v ) return '0';
	const a = Math.abs( v );
	return a >= 100 ? v.toFixed( 0 ) : a >= 10 ? v.toFixed( 1 ) : a >= 1 ? v.toFixed( 2 ) : v.toFixed( 3 );
};
const niceMax = ( v ) => {
	if ( v <= 0 ) return 1;
	const p = Math.pow( 10, Math.floor( Math.log10( v ) ) );
	return [ 1, 2, 2.5, 5, 10 ].map( ( m ) => m * p ).find( ( m ) => m >= v );
};

// Lines for one metric: the flat baseline, then engine × phase.
function linesFor( metric ) {
	const lines = [];
	// Without the plugin: measured one person at a time, so one value
	// per phase, drawn flat across every peer count.
	for ( const [ phase, label, dash ] of [ [ 'editing', 'editing', '2 4' ], [ 'idle', 'idle', '8 4 2 4' ] ] ) {
		const base = valuesOf( DATA.runs, phase + '|' + metric + '|baseline' );
		if ( base.length ) {
			lines.push( { label: 'Without the plugin, ' + label, color: 'var(--baseline)', dash, flat: median( base ) } );
		}
	}
	const engines = [
		...ENGINES.filter( ( e ) => DATA.runs.some( ( r ) => r.engine === e ) ),
		...[ ...new Set( DATA.runs.map( ( r ) => r.engine ) ) ].filter( ( e ) => ! ENGINES.includes( e ) ),
	];
	engines.forEach( ( engine, i ) => {
		for ( const [ phase, label, dash ] of PHASES ) {
			const runs = DATA.runs.filter( ( r ) => r.engine === engine );
			const peers = [ ...new Set( runs.map( ( r ) => r.peers ) ) ].sort( ( a, b ) => a - b );
			const points = peers
				.map( ( p ) => {
					const values = valuesOf( runs.filter( ( r ) => r.peers === p ), phase + '|' + metric + '|sync' );
					return values.length ? { x: p, y: median( values ), n: values.length } : null;
				} )
				.filter( Boolean );
			if ( points.length ) {
				// A small sideways shift per engine keeps lines that sit on
				// the same values (memory often does) from hiding each other.
				lines.push( { label: engine + ', ' + label, color: 'var(--series-' + ( ( i % 3 ) + 1 ) + ')', dash, points, shift: ( i - ( engines.length - 1 ) / 2 ) * 6 } );
			}
		}
	} );
	return lines;
}

function render() {
	const [ metric, name, unit ] = DATA.metrics.find( ( m ) => m[ 0 ] === $( 'metric' ).value );
	const lines = linesFor( metric );
	const fig = $( 'figure' );
	fig.querySelectorAll( 'svg, .empty' ).forEach( ( el ) => el.remove() );
	const peers = [ ...new Set( DATA.runs.map( ( r ) => r.peers ) ) ].sort( ( a, b ) => a - b );
	const ys = lines.flatMap( ( l ) => ( l.points ? l.points.map( ( p ) => p.y ) : [ l.flat ] ) );
	if ( ! ys.length || ! peers.length ) {
		const empty = document.createElement( 'div' );
		empty.className = 'empty';
		empty.textContent = 'No results for this metric.';
		fig.append( empty );
		$( 'legend' ).replaceChildren();
		return;
	}
	// Draw at the real width so text keeps its size on a phone.
	const W = Math.max( 320, fig.clientWidth || 900 );
	const H = Math.round( Math.min( 400, Math.max( 260, W * 0.45 ) ) );
	const M = { l: 56, r: 16, t: 24, b: 44 };
	const top = niceMax( Math.max( ...ys ) );
	const decimals = Math.max( 0, -Math.floor( Math.log10( top / 4 ) ) );
	const tick = ( v ) => v.toFixed( Math.min( decimals, 3 ) );
	const y = ( v ) => M.t + ( H - M.t - M.b ) * ( 1 - v / top );
	const lo = peers[ 0 ], hi = peers[ peers.length - 1 ];
	const x = ( p ) => ( lo === hi ? ( M.l + W - M.r ) / 2 : M.l + 24 + ( ( W - M.l - M.r - 48 ) * ( p - lo ) ) / ( hi - lo ) );
	const ns = 'http://www.w3.org/2000/svg';
	const el = ( tag, attrs, text ) => {
		const node = document.createElementNS( ns, tag );
		for ( const [ k, v ] of Object.entries( attrs ) ) node.setAttribute( k, v );
		if ( undefined !== text ) node.textContent = text;
		return node;
	};
	const svg = el( 'svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': name + ' by number of peers' } );
	for ( let i = 0; i <= 4; i++ ) {
		const v = ( top * i ) / 4;
		svg.append( el( 'line', { x1: M.l, x2: W - M.r, y1: y( v ), y2: y( v ), stroke: 0 === i ? 'var(--axis)' : 'var(--grid)' } ) );
		svg.append( el( 'text', { x: M.l - 8, y: y( v ) + 4, 'text-anchor': 'end' }, tick( v ) ) );
	}
	svg.append( el( 'text', { x: M.l, y: M.t - 10 }, unit ) );
	for ( const p of peers ) {
		svg.append( el( 'text', { x: x( p ), y: H - M.b + 20, 'text-anchor': 'middle' }, String( p ) ) );
	}
	svg.append( el( 'text', { x: M.l + ( W - M.l - M.r ) / 2, y: H - 6, 'text-anchor': 'middle' }, 'Peers' ) );

	const tip = $( 'tip' );
	const hover = ( node, text, px, py ) => {
		node.addEventListener( 'pointerenter', () => {
			tip.textContent = text;
			tip.style.display = 'block';
			const scale = svg.getBoundingClientRect().width / W;
			tip.style.left = Math.min( px * scale + 12, svg.getBoundingClientRect().width - 200 ) + 'px';
			tip.style.top = py * scale - 10 + 'px';
		} );
		node.addEventListener( 'pointerleave', () => ( tip.style.display = 'none' ) );
	};
	for ( const line of lines ) {
		if ( line.points ) {
			const px = ( p ) => x( p.x ) + line.shift;
			const d = line.points.map( ( p, i ) => ( i ? 'L' : 'M' ) + px( p ) + ' ' + y( p.y ) ).join( ' ' );
			svg.append( el( 'path', { d, fill: 'none', stroke: line.color, 'stroke-width': 2, 'stroke-dasharray': line.dash, 'stroke-linejoin': 'round' } ) );
			for ( const p of line.points ) {
				svg.append( el( 'circle', { cx: px( p ), cy: y( p.y ), r: 4, fill: line.color, stroke: 'var(--surface)', 'stroke-width': 2 } ) );
				const hit = el( 'circle', { cx: px( p ), cy: y( p.y ), r: 12, fill: 'transparent' } );
				hover( hit, line.label + ', ' + p.x + ' peer' + ( 1 === p.x ? '' : 's' ) + ': ' + fmt( p.y ) + ' (median of ' + p.n + ')', px( p ), y( p.y ) );
				svg.append( hit );
			}
		} else {
			svg.append( el( 'line', { x1: M.l, x2: W - M.r, y1: y( line.flat ), y2: y( line.flat ), stroke: line.color, 'stroke-width': 2, 'stroke-dasharray': line.dash, 'stroke-linecap': 'round' } ) );
			const hit = el( 'line', { x1: M.l, x2: W - M.r, y1: y( line.flat ), y2: y( line.flat ), stroke: 'transparent', 'stroke-width': 12 } );
			hover( hit, line.label + ': ' + fmt( line.flat ) + ' per person', M.l + 40, y( line.flat ) );
			svg.append( hit );
		}
	}
	fig.prepend( svg );

	$( 'legend' ).replaceChildren(
		...lines.map( ( line ) => {
			const item = document.createElement( 'span' );
			const swatch = el( 'svg', { viewBox: '0 0 28 10', 'aria-hidden': 'true' } );
			swatch.append( el( 'line', { x1: 1, x2: 27, y1: 5, y2: 5, stroke: line.color, 'stroke-width': 2, 'stroke-dasharray': line.dash, 'stroke-linecap': 'round' } ) );
			item.append( swatch, document.createTextNode( line.label ) );
			return item;
		} )
	);
}

$( 'title' ).textContent = DATA.title;
$( 'held' ).textContent = DATA.held.length
	? 'Held at: ' + DATA.held.map( ( [ label, value ] ) => label + ' ' + value ).join( ' · ' )
	: '';
for ( const [ metric, name, unit ] of DATA.metrics ) {
	if ( ! DATA.runs.some( ( run ) => Object.keys( run.values ).some( ( k ) => k.split( '|' )[ 1 ] === metric ) ) ) continue;
	const option = document.createElement( 'option' );
	option.value = metric;
	option.textContent = name + ' (' + unit + ')';
	$( 'metric' ).append( option );
}
$( 'metric' ).addEventListener( 'change', render );
let resized = null;
window.addEventListener( 'resize', () => {
	clearTimeout( resized );
	resized = setTimeout( render, 100 );
} );
render();
</script>
</body>
</html>
`;
}

/**
 * Writes the chart page.
 *
 * @param {Array<Object>} records Result lines.
 * @param {string}        file    Output path.
 * @param {Object}        options chartHtml options.
 * @return {string} Output path.
 */
export function writeChart( records, file, options = {} ) {
	fs.writeFileSync( file, chartHtml( records, options ) );
	return file;
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const opts = cliOptions();
	if ( ! opts.results ) {
		console.error(
			'usage: node tests/benchmarks/host/chart.mjs results=<results.jsonl> [out=<chart.html>] [plan=<name|path>]'
		);
		process.exit( 1 );
	}
	let plan = null;
	if ( opts.plan ) {
		const here = path.dirname( fileURLToPath( import.meta.url ) );
		const planPath = fs.existsSync( String( opts.plan ) )
			? String( opts.plan )
			: path.join( here, 'plans', `${ opts.plan }.json` );
		plan = JSON.parse( fs.readFileSync( planPath, 'utf8' ) );
	}
	const out = path.resolve(
		String(
			opts.out ??
				path.join(
					path.dirname( String( opts.results ) ),
					'chart.html'
				)
		)
	);
	console.log(
		writeChart( readRecords( String( opts.results ) ), out, { plan } )
	);
}
