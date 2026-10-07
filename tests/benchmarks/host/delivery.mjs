/**
 * Validate peer counts and optional delivery limits before opening a browser.
 *
 * @param {Object} args Parsed command arguments.
 */
export function deliveryOptions( args ) {
	const integer = ( value, name ) => {
		const number = Number( value );
		if (
			typeof value === 'boolean' ||
			! Number.isSafeInteger( number ) ||
			number < 1
		) {
			throw new Error( `${ name } must be a positive integer` );
		}
		return number;
	};
	const peers = integer( args.peers ?? args.windows ?? 2, 'peers' );
	if (
		args.windows !== undefined &&
		integer( args.windows, 'windows' ) !== peers
	) {
		throw new Error(
			'peers and windows must agree when both are supplied'
		);
	}
	return {
		peers,
		p95Ms:
			args[ 'p95-ms' ] === undefined
				? null
				: integer( args[ 'p95-ms' ], 'p95-ms' ),
		maxLagMs: integer( args[ 'max-lag-ms' ] ?? 1000, 'max-lag-ms' ),
	};
}

export function distribution( values ) {
	if ( ! values.length ) {
		return null;
	}
	const sorted = [ ...values ].sort( ( a, b ) => a - b );
	const at = ( p ) => sorted[ Math.ceil( p * sorted.length ) - 1 ];
	return {
		n: sorted.length,
		p50: at( 0.5 ),
		p95: at( 0.95 ),
		p99: at( 0.99 ),
		max: sorted.at( -1 ),
	};
}

/**
 * Count missing arrivals separately so fast deliveries cannot hide lost edits.
 *
 * @param {Array<Object>}        snapshots Per-peer sends and arrivals.
 * @param {Array<Array<Object>>} scripts   Scheduled tokens per writer.
 * @return {Object} Delivery counts and time distributions.
 */
export function deliveryMeasurements( snapshots, scripts ) {
	const latencies = [];
	const lags = [];
	let missing = 0;
	let invalid = 0;
	let missingInputs = 0;
	for ( let writer = 0; writer < scripts.length; writer++ ) {
		for ( let round = 0; round < scripts[ writer ].length; round++ ) {
			const token = scripts[ writer ][ round ].text.trim();
			const sent = snapshots[ writer ].sent[ token ];
			if ( sent ) {
				lags.push( sent.lagMs );
			} else {
				missingInputs++;
			}
			for ( let receiver = 0; receiver < snapshots.length; receiver++ ) {
				if ( receiver === writer ) {
					continue;
				}
				const seen = snapshots[ receiver ].seen[ token ];
				if ( ! sent || seen === undefined ) {
					missing++;
				} else if ( seen < sent.at ) {
					invalid++;
				} else {
					latencies.push( seen - sent.at );
				}
			}
		}
	}
	return {
		expected:
			scripts.reduce( ( total, script ) => total + script.length, 0 ) *
			( snapshots.length - 1 ),
		missing,
		invalid,
		missingInputs,
		latencyMs: distribution( latencies ),
		scheduleLagMs: distribution( lags ),
	};
}

export function assessRun( run, options ) {
	const reasons = [];
	if ( run.error ) {
		reasons.push( run.error );
	}
	if ( ! run.correct ) {
		reasons.push(
			'The editors did not all retain the complete expected document.'
		);
	}
	if (
		! run.delivery ||
		( run.delivery.expected > 0 && ! run.delivery.latencyMs ) ||
		run.delivery.missingInputs ||
		run.delivery.missing ||
		run.delivery.invalid
	) {
		reasons.push( 'Some edit deliveries are missing or invalid.' );
	}
	if (
		options.p95Ms !== null &&
		run.delivery?.latencyMs?.p95 > options.p95Ms
	) {
		reasons.push( 'Edit delivery exceeded the p95 delay limit.' );
	}
	if (
		! run.delivery?.scheduleLagMs ||
		run.delivery.scheduleLagMs.max > options.maxLagMs
	) {
		reasons.push(
			'The browser could not sustain the requested edit rate.'
		);
	}
	if ( run.requestErrors || run.pageErrors ) {
		reasons.push( 'Browser or collaboration request errors occurred.' );
	}
	return { passed: reasons.length === 0, reasons };
}

/**
 * Separate agreement from correctness and count marker damage per editor.
 * Counts are marker copies across editors, not distinct authored edits.
 *
 * @param {Array<Object>}        editors Final editor snapshots.
 * @param {Array<Array<Object>>} scripts Scheduled tokens per writer.
 * @return {Object} Content evidence, independent of arrival timing.
 */
export function contentAudit( editors, scripts ) {
	const expected = new Set(
		scripts.flat().map( ( token ) => token.text.trim() )
	);
	const perPeer = editors.map( ( editor, peer ) => {
		const counts = new Map();
		for ( const token of editor.content.match( /\bw\d+t\d+x\b/g ) ?? [] ) {
			counts.set( token, ( counts.get( token ) ?? 0 ) + 1 );
		}
		const missing = [ ...expected ].filter(
			( token ) => ! counts.has( token )
		);
		return {
			peer,
			missing,
			seenThenMissing: missing.filter(
				( token ) => editor.seen[ token ] !== undefined
			),
			duplicates: [ ...counts ]
				.filter(
					( [ token, count ] ) => expected.has( token ) && count > 1
				)
				.map( ( [ token, count ] ) => ( { token, copies: count } ) ),
			unexpected: [ ...counts.keys() ].filter(
				( token ) => ! expected.has( token )
			),
		};
	} );
	return {
		editorsAgree:
			editors.length > 0 &&
			editors.every(
				( editor ) => editor.content === editors[ 0 ].content
			),
		missingCopies: perPeer.reduce(
			( sum, peer ) => sum + peer.missing.length,
			0
		),
		seenThenMissingCopies: perPeer.reduce(
			( sum, peer ) => sum + peer.seenThenMissing.length,
			0
		),
		extraCopies: perPeer.reduce(
			( sum, peer ) =>
				sum +
				peer.duplicates.reduce(
					( n, token ) => n + token.copies - 1,
					0
				),
			0
		),
		perPeer,
	};
}
