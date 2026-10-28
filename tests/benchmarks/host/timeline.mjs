/**
 * Calibrate PHP timestamps against the driver's clock without assuming that
 * the request or response took half the round-trip time. All samples must
 * come from the same server. Keep the widest observed offset bounds.
 *
 * @param {Array<Object>} probes Server clock probes and local send/receive times.
 * @return {Object} Clock identity and offset bounds in milliseconds.
 */
export function clockRange( probes ) {
	if (
		! probes.length ||
		probes.some(
			( p ) =>
				! p ||
				p.timeline_version !== 1 ||
				p.clock_id !== probes[ 0 ].clock_id ||
				! Number.isFinite( p.at_ms ) ||
				! Number.isFinite( p.sentMs ) ||
				! Number.isFinite( p.receivedMs ) ||
				p.receivedMs < p.sentMs
		)
	) {
		throw new Error(
			'Missing clock calibration or responses from different servers.'
		);
	}
	return {
		id: probes[ 0 ].clock_id,
		min: Math.min( ...probes.map( ( p ) => p.at_ms - p.receivedMs ) ),
		max: Math.max( ...probes.map( ( p ) => p.at_ms - p.sentMs ) ),
	};
}

const counters = {
	cpu_ms: 'total_cpu_ms',
	queries: 'db_queries',
	option_writes: 'option_writes',
};

/**
 * Require complete, monotonic traces whose final counters match request totals.
 * A killed worker or missing shutdown row must not look like a cheap stream.
 *
 * @param {Array<Object>} rows     Completed request rows.
 * @param {Set<string>}   expected Request IDs known to have reached PHP.
 * @param {Object}        clock    Calibrated server clock.
 */
export function validateTimelines( rows, expected, clock ) {
	const seen = new Set();
	for ( const row of rows ) {
		const t = row.timeline;
		if (
			! t ||
			t.version !== 1 ||
			t.clock_id !== clock.id ||
			! t.cpu_available ||
			! t.clock_stable ||
			! row.request_id ||
			seen.has( row.request_id ) ||
			t.request_id !== row.request_id ||
			! Array.isArray( t.samples ) ||
			t.samples.length < 2 ||
			! Number.isFinite( t.request_start_ms ) ||
			! Number.isFinite( row.total_ms ) ||
			Object.keys( counters ).some(
				( key ) => t.samples[ 0 ][ key ] !== 0
			)
		) {
			throw new Error(
				'Missing, duplicate, or unsupported request timeline.'
			);
		}
		seen.add( row.request_id );
		let previous = {
			at_ms: t.request_start_ms,
			cpu_ms: 0,
			queries: 0,
			option_writes: 0,
		};
		for ( const sample of t.samples ) {
			for ( const key of [ 'at_ms', ...Object.keys( counters ) ] ) {
				if (
					! Number.isFinite( sample[ key ] ) ||
					sample[ key ] < previous[ key ]
				) {
					throw new Error(
						'A request clock or cumulative counter moved backwards.'
					);
				}
			}
			previous = sample;
		}
		for ( const [ key, total ] of Object.entries( counters ) ) {
			if (
				! Number.isFinite( row[ total ] ) ||
				Math.abs( previous[ key ] - row[ total ] ) > 0.011
			) {
				throw new Error(
					'Timeline counters do not match the whole-request totals.'
				);
			}
		}
		if (
			Math.abs( previous.at_ms - t.request_start_ms - row.total_ms ) > 0.1
		) {
			throw new Error(
				'Timeline duration does not match the whole-request duration.'
			);
		}
	}
	if ( ! seen.size || [ ...expected ].some( ( id ) => ! seen.has( id ) ) ) {
		throw new Error(
			'Some PHP requests have no completed timeline; server totals are unavailable.'
		);
	}
}

function union( intervals ) {
	const merged = [];
	for ( const interval of intervals
		.filter( ( [ start, end ] ) => end > start )
		.sort( ( a, b ) => a[ 0 ] - b[ 0 ] ) ) {
		const last = merged[ merged.length - 1 ];
		if ( last && interval[ 0 ] <= last[ 1 ] ) {
			last[ 1 ] = Math.max( last[ 1 ], interval[ 1 ] );
		} else {
			merged.push( [ ...interval ] );
		}
	}
	return merged;
}

const overlap = ( start, end, windows ) =>
	windows.reduce(
		( total, [ lo, hi ] ) =>
			total + Math.max( 0, Math.min( end, hi ) - Math.max( start, lo ) ),
		0
	);

/**
 * Attribute actual occupied time by interval overlap. CPU and query deltas
 * are exact inside a window. A delta that straddles an uncertain boundary
 * contributes zero to the lower bound and all its work to the upper bound.
 * Never distribute bursty CPU or queries in proportion to elapsed time.
 *
 * @param {Array<Object>} rows    Validated request timelines for one approach.
 * @param {Array<Object>} spans   Local start/end times of the measured periods.
 * @param {Object}        clock   Server-clock offset bounds.
 * @param {number}        persons Editors sharing each period.
 * @return {Object} Totals and per-person rates, each with min/max bounds.
 */
export function measureTimelines( rows, spans, clock, persons ) {
	const definite = union(
		spans.map( ( s ) => [ s.startMs + clock.max, s.endMs + clock.min ] )
	);
	const possible = union(
		spans.map( ( s ) => [ s.startMs + clock.min, s.endMs + clock.max ] )
	);
	const totals = {
		workerMs: { min: 0, max: 0 },
		cpu_ms: { min: 0, max: 0 },
		queries: { min: 0, max: 0 },
		option_writes: { min: 0, max: 0 },
	};
	let peak = 0;
	for ( const row of rows ) {
		const t = row.timeline;
		const end = t.samples[ t.samples.length - 1 ].at_ms;
		totals.workerMs.min += overlap( t.request_start_ms, end, definite );
		const occupied = overlap( t.request_start_ms, end, possible );
		totals.workerMs.max += occupied;
		if ( occupied > 0 ) {
			peak = Math.max( peak, row.peak_memory );
		}
		for ( let i = 1; i < t.samples.length; i++ ) {
			const before = t.samples[ i - 1 ];
			const after = t.samples[ i ];
			const contained = definite.some(
				( [ lo, hi ] ) =>
					before.at_ms >= lo && after.at_ms <= hi && before.at_ms < hi
			);
			const intersects = possible.some(
				( [ lo, hi ] ) =>
					( after.at_ms > lo ||
						( before.at_ms === after.at_ms &&
							after.at_ms === lo ) ) &&
					before.at_ms < hi
			);
			for ( const key of Object.keys( counters ) ) {
				const delta = after[ key ] - before[ key ];
				totals[ key ].min += contained ? delta : 0;
				totals[ key ].max += intersects ? delta : 0;
			}
		}
	}
	const ms = spans.reduce( ( total, s ) => total + s.endMs - s.startMs, 0 );
	const scale = ( bounds, divisor ) => ( {
		min: bounds.min / divisor,
		max: bounds.max / divisor,
	} );
	return {
		totals,
		rates:
			ms > 0
				? {
						cpuMsPerMinute: scale(
							totals.cpu_ms,
							( ms * persons ) / 60000
						),
						workerShare: scale( totals.workerMs, ms * persons ),
						dbQueriesPerMinute: scale(
							totals.queries,
							( ms * persons ) / 60000
						),
						optionWritesPerMinute: scale(
							totals.option_writes,
							( ms * persons ) / 60000
						),
						peakMemoryMaxMb: peak ? peak / 1048576 : null,
				  }
				: null,
	};
}
