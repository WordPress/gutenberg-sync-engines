/**
 * Build the same typing script for both phases, independent of host speed.
 * Offsets describe intended timing; a slow browser must finish every token.
 *
 * @param {number} index      Window index.
 * @param {number} durationMs Intended editing duration.
 * @return {Array<Object>} Scheduled tokens.
 */
export function editingScript( index, durationMs ) {
	let step = index * 97 + 1;
	const jitter = ( min, max ) =>
		min +
		( ( ( step++ * 2654435761 ) % 4294967296 ) / 4294967296 ) *
			( max - min );
	const script = [];
	let at = 0;
	while ( at < durationMs ) {
		at += jitter( 2000, 6000 );
		const burst = Math.round( jitter( 4, 9 ) );
		for ( let i = 0; i < burst && at < durationMs; i++ ) {
			script.push( { at, text: ` w${ index }t${ script.length }x` } );
			at += jitter( 250, 550 );
		}
	}
	return script;
}

/**
 * Compare the fixture's complete paragraph text, ignoring block metadata.
 * Extra blocks, missing tokens, duplicates, and changed order must fail.
 *
 * @param {string}        content  Serialized post content.
 * @param {Array<string>} expected Expected paragraph text.
 * @return {boolean} Whether the full fixture is present.
 */
export function matchesDocument( content, expected ) {
	if ( typeof content !== 'string' ) {
		return false;
	}
	const paragraphs = [];
	const remaining = content
		.replace( /<!--[\s\S]*?-->/g, '' )
		.replace( /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g, ( _, text ) => {
			paragraphs.push(
				text
					.replace( /&nbsp;|&#160;/g, ' ' )
					.replace( /\s+/g, ' ' )
					.trim()
			);
			return '';
		} );
	return (
		remaining.trim() === '' &&
		paragraphs.length === expected.length &&
		paragraphs.every( ( text, index ) => text === expected[ index ] )
	);
}

/**
 * Whole-phase server totals require complete measurement coverage.
 * Stream shutdown rows cannot allocate work to editing and idle periods.
 * Socket processes are outside the PHP request logger.
 *
 * @param {Object}  options               Measurement configuration.
 * @param {boolean} options.muMeasurement Whether the baseline was measured.
 * @param {string}  options.transport     Observed content transport.
 * @param {boolean} options.sockets       Whether any sockets were used.
 * @return {Array<string>} Reasons totals cannot be reported.
 */
export function serverCoverageLimits( { muMeasurement, transport, sockets } ) {
	const limits = [];
	if ( ! muMeasurement ) {
		limits.push( 'The baseline has no whole-request measurements.' );
	}
	if ( transport === 'sse' ) {
		limits.push(
			'SSE requests span phases; shutdown logs cannot split their server cost between editing and idle.'
		);
	}
	if ( transport === 'websocket' || sockets ) {
		limits.push(
			'WebSocket server or advisory relay CPU, memory, and worker time are not measured.'
		);
	}
	return limits;
}

/**
 * Count HTTP body bytes, streamed SSE bytes, and all WebSocket payloads.
 * Headers, compression, protocol overhead, and WebRTC are not measured.
 *
 * @param {Object}   page         Playwright page.
 * @param {Function} syncSnapshot Current transport counters.
 * @return {Object} Cumulative counters.
 */
export function attachAllTrafficCounters( page, syncSnapshot ) {
	const c = { requests: 0, requestBytes: 0, responseBytes: 0 };
	page.on( 'request', ( request ) => {
		c.requests++;
		c.requestBytes += request.postDataBuffer()?.length ?? 0;
	} );
	page.on( 'response', async ( response ) => {
		if (
			decodeURIComponent( response.url() ).includes( '/wp-sync/v1/sse' )
		) {
			return;
		}
		try {
			c.responseBytes += ( await response.body() ).length;
		} catch {
			// Aborted or unavailable responses have unknown body sizes.
		}
	} );
	return {
		snapshot: () => {
			const sync = syncSnapshot();
			return {
				...c,
				requestBytes: c.requestBytes + sync.wsBytesSent,
				responseBytes:
					c.responseBytes +
					sync.sseBytesReceived +
					sync.wsBytesReceived,
				wsFrames: sync.wsFramesSent + sync.wsFramesReceived,
			};
		},
	};
}
