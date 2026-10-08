/**
 * Builds a self-contained chart page from host benchmark result lines:
 * pick a metric, what goes along the bottom (people, post size, …), what
 * each line is (usually the engine), and the value every other variable
 * is held at. Each point is the median of the repeats; the bar through
 * it spans the lowest to the highest repeat. A table under the chart
 * holds the same numbers.
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

// Variables a chart can put on an axis, as columns of each run.
const DIMENSIONS = [
	[ 'engine', 'Engine' ],
	[ 'transport', 'Transport' ],
	[ 'windows', 'People' ],
	[ 'postSize', 'Post size' ],
	[ 'pattern', 'Editing pattern' ],
	[ 'editSeconds', 'Editing seconds' ],
	[ 'idleSeconds', 'Idle seconds' ],
	[ 'cache', 'Object cache' ],
	[ 'pollingInterval', 'Polling interval' ],
	[ 'commit', 'Plugin commit' ],
	[ 'machine', 'Machine' ],
];

/**
 * Reduces result lines to what the page needs.
 *
 * @param {Array<Object>} records Result lines.
 * @return {Object} { runs, metrics }.
 */
export function chartData( records ) {
	const metrics = {};
	const runs = records.map( ( record ) => {
		const values = {};
		for ( const result of record.results ) {
			const key = `${ result.phase }|${ result.metric }`;
			metrics[ key ] ??= {
				phase: result.phase,
				metric: result.metric,
				unit: result.unit,
				kind: result.kind,
			};
			values[ `${ key }|${ result.side }` ] = result.value;
		}
		return {
			engine: record.setup.engine,
			transport: record.setup.transport,
			windows: record.setup.windows,
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
	return { runs, metrics: Object.values( metrics ) };
}

/**
 * The page.
 *
 * @param {Array<Object>} records      Result lines.
 * @param {Object}        options
 * @param {Object|null}   options.plan The plan, whose center sets the defaults.
 * @return {string} HTML.
 */
export function chartHtml( records, { plan = null } = {} ) {
	const data = {
		...chartData( records ),
		dimensions: DIMENSIONS,
		center: plan?.center ?? {},
		title: plan?.name ? `Host benchmark: ${ plan.name }` : 'Host benchmark',
		generated: new Date().toISOString(),
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
	--series-1: #2a78d6;
	--series-2: #eb6834;
	--series-3: #1baf7a;
	--series-4: #eda100;
	--series-5: #e87ba4;
	--series-6: #008300;
	--series-7: #4a3aa7;
	--series-8: #e34948;
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
		--series-1: #3987e5;
		--series-2: #d95926;
		--series-3: #199e70;
		--series-4: #c98500;
		--series-5: #d55181;
		--series-6: #008300;
		--series-7: #9085e9;
		--series-8: #e66767;
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
	--series-1: #3987e5;
	--series-2: #d95926;
	--series-3: #199e70;
	--series-4: #c98500;
	--series-5: #d55181;
	--series-6: #008300;
	--series-7: #9085e9;
	--series-8: #e66767;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--surface);
	color: var(--text-primary);
	font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--text-secondary); margin: 0 0 20px; }
.controls { display: flex; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 8px; }
.controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
select {
	font: inherit; color: var(--text-primary); background: var(--panel);
	border: 1px solid var(--axis); border-radius: 6px; padding: 5px 8px; max-width: 100%;
}
.held { color: var(--text-muted); font-size: 12px; margin: 4px 0 16px; }
.held .controls label { color: var(--text-muted); }
.figure { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--text-secondary); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 8px 0 0; color: var(--text-secondary); font-size: 13px; }
.legend span::before {
	content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%;
	background: var(--swatch); margin-right: 6px; vertical-align: -1px;
}
.tip {
	position: absolute; pointer-events: none; background: var(--panel); color: var(--text-primary);
	border: 1px solid var(--axis); border-radius: 6px; padding: 6px 8px; font-size: 12px;
	white-space: nowrap; display: none; box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
}
.note { color: var(--text-muted); font-size: 12px; margin-top: 12px; }
table { border-collapse: collapse; width: 100%; margin-top: 20px; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
th { color: var(--text-secondary); font-weight: 600; }
.empty { padding: 48px 0; text-align: center; color: var(--text-muted); }
.scroll { overflow-x: auto; }
</style>
</head>
<body>
<main>
<h1 id="title"></h1>
<p class="sub" id="sub"></p>
<div class="controls" id="controls"></div>
<div class="held"><div class="controls" id="held"></div></div>
<div class="figure" id="figure"><div class="tip" id="tip"></div></div>
<div class="legend" id="legend"></div>
<p class="note" id="note"></p>
<div class="scroll"><table id="table"></table></div>
</main>
<script>
const DATA = ${ json };
const $ = ( id ) => document.getElementById( id );
const label = Object.fromEntries( DATA.dimensions );
const SIZE_ORDER = [ 'empty', 'medium', 'large' ];

const valuesOf = ( dim ) => {
	const set = [ ...new Set( DATA.runs.map( ( run ) => run[ dim ] ) ) ];
	return set.sort( ( a, b ) => {
		if ( 'postSize' === dim ) return SIZE_ORDER.indexOf( a ) - SIZE_ORDER.indexOf( b );
		if ( 'number' === typeof a && 'number' === typeof b ) return a - b;
		return String( a ).localeCompare( String( b ) );
	} );
};
const varying = DATA.dimensions.map( ( [ d ] ) => d ).filter( ( d ) => valuesOf( d ).length > 1 );
// Colors follow the entity: a series keeps its slot whatever is filtered.
const seriesSlot = ( dim, value ) => ( valuesOf( dim ).indexOf( value ) % 8 ) + 1;

const state = {
	metric: DATA.metrics.find( ( m ) => 'php_cpu_ms_per_person_min' === m.metric && 'editing' === m.phase )
		? 'editing|php_cpu_ms_per_person_min'
		: DATA.metrics[ 0 ] && DATA.metrics[ 0 ].phase + '|' + DATA.metrics[ 0 ].metric,
	side: 'sync',
	x: varying.includes( 'windows' ) ? 'windows' : varying[ 0 ] || 'engine',
	series: varying.includes( 'engine' ) ? 'engine' : 'none',
	held: {},
};
for ( const dim of varying ) {
	const values = valuesOf( dim );
	const center = DATA.center[ dim ];
	if ( values.includes( center ) ) {
		state.held[ dim ] = center;
	} else {
		// Most common value.
		const counts = new Map();
		DATA.runs.forEach( ( run ) => counts.set( run[ dim ], ( counts.get( run[ dim ] ) || 0 ) + 1 ) );
		state.held[ dim ] = values.reduce( ( a, b ) => ( counts.get( b ) > counts.get( a ) ? b : a ) );
	}
}

function select( name, options, value, onChange ) {
	const wrap = document.createElement( 'label' );
	wrap.textContent = name;
	const el = document.createElement( 'select' );
	for ( const [ v, text ] of options ) {
		const opt = document.createElement( 'option' );
		opt.value = JSON.stringify( v );
		opt.textContent = text;
		if ( v === value ) opt.selected = true;
		el.append( opt );
	}
	el.addEventListener( 'change', () => { onChange( JSON.parse( el.value ) ); render(); } );
	wrap.append( el );
	return wrap;
}

const metricName = ( m ) => m.metric.replace( /_/g, ' ' );
const SIDES = [ [ 'sync', 'With the plugin (sync)' ], [ 'baseline', 'Plugin off (baseline)' ], [ 'added', 'Added by the plugin' ] ];

function renderControls() {
	const metrics = DATA.metrics
		.slice()
		.sort( ( a, b ) => ( a.phase + a.metric ).localeCompare( b.phase + b.metric ) )
		.map( ( m ) => [ m.phase + '|' + m.metric, m.phase + ': ' + metricName( m ) + ' (' + m.unit + ( 'timed' === m.kind ? ', timed' : '' ) + ')' ] );
	const dims = varying.map( ( d ) => [ d, label[ d ] ] );
	$( 'controls' ).replaceChildren(
		select( 'Metric', metrics, state.metric, ( v ) => ( state.metric = v ) ),
		select( 'Show', SIDES, state.side, ( v ) => ( state.side = v ) ),
		select( 'Along the bottom', dims, state.x, ( v ) => {
			state.x = v;
			if ( state.series === v ) state.series = 'none';
		} ),
		select( 'One line per', [ [ 'none', 'Nothing (one line)' ], ...dims.filter( ( [ d ] ) => d !== state.x ) ], state.series, ( v ) => ( state.series = v ) )
	);
	const held = varying.filter( ( d ) => d !== state.x && d !== state.series );
	$( 'held' ).replaceChildren(
		...held.map( ( d ) => select( 'Hold ' + label[ d ].toLowerCase() + ' at', valuesOf( d ).map( ( v ) => [ v, String( v ) ] ), state.held[ d ], ( v ) => ( state.held[ d ] = v ) ) )
	);
}

function valueOf( run ) {
	const v = run.values;
	if ( 'added' === state.side ) {
		const s = v[ state.metric + '|sync' ];
		const b = v[ state.metric + '|baseline' ];
		return undefined === s || undefined === b ? undefined : s - b;
	}
	return v[ state.metric + '|' + state.side ];
}

function summarize( values ) {
	const sorted = values.slice().sort( ( a, b ) => a - b );
	const mid = Math.floor( sorted.length / 2 );
	return {
		n: sorted.length,
		min: sorted[ 0 ],
		max: sorted[ sorted.length - 1 ],
		median: sorted.length % 2 ? sorted[ mid ] : ( sorted[ mid - 1 ] + sorted[ mid ] ) / 2,
	};
}

const fmt = ( v ) => {
	if ( 0 === v ) return '0';
	const a = Math.abs( v );
	return a >= 100 ? v.toFixed( 0 ) : a >= 10 ? v.toFixed( 1 ) : a >= 1 ? v.toFixed( 2 ) : v.toFixed( 3 );
};

function niceMax( v ) {
	if ( v <= 0 ) return 1;
	const p = Math.pow( 10, Math.floor( Math.log10( v ) ) );
	return [ 1, 2, 2.5, 5, 10 ].map( ( m ) => m * p ).find( ( m ) => m >= v );
}

function render() {
	renderControls();
	const metric = DATA.metrics.find( ( m ) => m.phase + '|' + m.metric === state.metric );
	const held = varying.filter( ( d ) => d !== state.x && d !== state.series );
	const runs = DATA.runs.filter( ( run ) => held.every( ( d ) => run[ d ] === state.held[ d ] ) );
	const xs = valuesOf( state.x ).filter( ( x ) => runs.some( ( r ) => r[ state.x ] === x ) );
	const seriesValues = 'none' === state.series ? [ null ] : valuesOf( state.series ).filter( ( s ) => runs.some( ( r ) => r[ state.series ] === s ) );
	const series = seriesValues.map( ( s ) => ( {
		name: null === s ? metricName( metric ) : String( s ),
		color: 'var(--series-' + ( null === s ? 1 : seriesSlot( state.series, s ) ) + ')',
		points: xs.map( ( x ) => {
			const values = runs
				.filter( ( r ) => r[ state.x ] === x && ( null === s || r[ state.series ] === s ) )
				.map( valueOf )
				.filter( ( v ) => undefined !== v && null !== v );
			return values.length ? { x, ...summarize( values ) } : null;
		} ),
	} ) );

	$( 'title' ).textContent = DATA.title;
	$( 'sub' ).textContent = ( metric ? metric.phase + ' · ' + metricName( metric ) + ' · ' + metric.unit : '' ) +
		' — ' + DATA.runs.length + ' runs; dots are medians, bars span the lowest to highest repeat';
	$( 'note' ).textContent = metric && 'timed' === metric.kind
		? 'Timed metric: it depends on how fast the machine is, so compare it only between runs on the same machine.'
		: 'Counted metric: decided by what the software does, so it can be compared across machines.';

	const fig = $( 'figure' );
	fig.querySelectorAll( 'svg, .empty' ).forEach( ( el ) => el.remove() );
	const all = series.flatMap( ( s ) => s.points.filter( Boolean ) );
	if ( ! all.length ) {
		const empty = document.createElement( 'div' );
		empty.className = 'empty';
		empty.textContent = 'No runs match these choices.';
		fig.append( empty );
		$( 'legend' ).replaceChildren();
		$( 'table' ).replaceChildren();
		return;
	}
	const W = 960, H = 380, M = { l: 64, r: 140, t: 12, b: 44 };
	const lo = Math.min( 0, ...all.map( ( p ) => p.min ) );
	const hi = niceMax( Math.max( ...all.map( ( p ) => p.max ) ) );
	const y = ( v ) => M.t + ( H - M.t - M.b ) * ( 1 - ( v - lo ) / ( hi - lo ) );
	const step = ( W - M.l - M.r ) / xs.length;
	const x = ( i ) => M.l + step * ( i + 0.5 );
	const ns = 'http://www.w3.org/2000/svg';
	const el = ( name, attrs, text ) => {
		const node = document.createElementNS( ns, name );
		for ( const [ k, v ] of Object.entries( attrs ) ) node.setAttribute( k, v );
		if ( undefined !== text ) node.textContent = text;
		return node;
	};
	const svg = el( 'svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': ( metric ? metricName( metric ) : '' ) + ' by ' + label[ state.x ] } );
	for ( let i = 0; i <= 4; i++ ) {
		const v = lo + ( ( hi - lo ) * i ) / 4;
		svg.append( el( 'line', { x1: M.l, x2: W - M.r, y1: y( v ), y2: y( v ), stroke: 0 === v ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 } ) );
		svg.append( el( 'text', { x: M.l - 8, y: y( v ) + 4, 'text-anchor': 'end' }, fmt( v ) ) );
	}
	xs.forEach( ( v, i ) => svg.append( el( 'text', { x: x( i ), y: H - M.b + 20, 'text-anchor': 'middle' }, String( v ) ) ) );
	svg.append( el( 'text', { x: M.l + ( W - M.l - M.r ) / 2, y: H - 6, 'text-anchor': 'middle' }, label[ state.x ] ) );
	svg.append( el( 'text', { x: M.l, y: M.t - 2 + 0, 'text-anchor': 'start', dy: -2 }, metric ? metric.unit : '' ) );

	// Small sideways offsets keep overlapping whiskers apart.
	const offset = ( k ) => ( seriesValues.length > 1 ? ( k - ( seriesValues.length - 1 ) / 2 ) * Math.min( 14, step / ( seriesValues.length + 2 ) ) : 0 );
	const tip = $( 'tip' );
	const labels = [];
	series.forEach( ( s, k ) => {
		const pts = s.points.map( ( p, i ) => ( p ? { ...p, px: x( i ) + offset( k ), py: y( p.median ) } : null ) );
		const path = pts.filter( Boolean ).map( ( p, i ) => ( i ? 'L' : 'M' ) + p.px + ' ' + p.py ).join( ' ' );
		svg.append( el( 'path', { d: path, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' } ) );
		pts.forEach( ( p ) => {
			if ( ! p ) return;
			if ( p.max > p.min ) {
				svg.append( el( 'line', { x1: p.px, x2: p.px, y1: y( p.min ), y2: y( p.max ), stroke: s.color, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.55 } ) );
			}
			svg.append( el( 'circle', { cx: p.px, cy: p.py, r: 5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 } ) );
			const hit = el( 'circle', { cx: p.px, cy: p.py, r: 14, fill: 'transparent' } );
			hit.addEventListener( 'pointerenter', () => {
				tip.style.display = 'block';
				tip.innerHTML = '';
				const lines = [
					( 'none' === state.series ? '' : s.name + ' · ' ) + label[ state.x ] + ' ' + p.x,
					'median ' + fmt( p.median ) + ' ' + ( metric ? metric.unit : '' ),
					p.n > 1 ? 'range ' + fmt( p.min ) + ' – ' + fmt( p.max ) + ' (' + p.n + ' runs)' : '1 run',
				];
				lines.forEach( ( line, i ) => {
					const div = document.createElement( 'div' );
					div.textContent = line;
					if ( 0 === i ) div.style.fontWeight = '600';
					tip.append( div );
				} );
				const box = svg.getBoundingClientRect();
				const scale = box.width / W;
				tip.style.left = Math.min( p.px * scale + 12, box.width - 180 ) + 'px';
				tip.style.top = p.py * scale - 10 + 'px';
			} );
			hit.addEventListener( 'pointerleave', () => ( tip.style.display = 'none' ) );
			svg.append( hit );
		} );
		const last = pts.filter( Boolean ).pop();
		if ( last && seriesValues.length <= 4 && null !== seriesValues[ 0 ] ) {
			labels.push( { y: last.py, x: last.px, text: s.name } );
		}
	} );
	// Direct labels at the line ends, nudged apart so they never overlap.
	labels.sort( ( a, b ) => a.y - b.y );
	for ( let i = 1; i < labels.length; i++ ) labels[ i ].y = Math.max( labels[ i ].y, labels[ i - 1 ].y + 16 );
	labels.forEach( ( l ) => svg.append( el( 'text', { x: W - M.r + 14, y: l.y + 4, 'text-anchor': 'start', style: 'fill: var(--text-primary)' }, l.text ) ) );
	fig.prepend( svg );

	$( 'legend' ).replaceChildren(
		...( null === seriesValues[ 0 ] ? [] : series.map( ( s ) => {
			const span = document.createElement( 'span' );
			span.style.setProperty( '--swatch', s.color );
			span.textContent = s.name;
			return span;
		} ) )
	);

	const table = $( 'table' );
	const head = [ 'none' === state.series ? '' : label[ state.series ], label[ state.x ], 'runs', 'median', 'lowest', 'highest' ];
	const rows = series.flatMap( ( s ) => s.points.filter( Boolean ).map( ( p ) => [ 'none' === state.series ? '' : s.name, String( p.x ), p.n, fmt( p.median ), fmt( p.min ), fmt( p.max ) ] ) );
	table.replaceChildren();
	const tr = ( cells, tag ) => {
		const row = document.createElement( 'tr' );
		cells.forEach( ( c ) => {
			const cell = document.createElement( tag );
			cell.textContent = c;
			row.append( cell );
		} );
		return row;
	};
	table.append( tr( head, 'th' ), ...rows.map( ( r ) => tr( r, 'td' ) ) );
}

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
