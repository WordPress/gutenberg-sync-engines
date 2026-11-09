/**
 * Read opt-in counters from explicitly selected WebSocket server processes.
 * Values describe the entire process, not an individual site or editor.
 *
 * @param {string[]} endpoints Measurement URLs.
 * @return {Promise<Array<Object>>} Samples or explicit failures.
 */
export async function sampleSocketProcesses( endpoints ) {
	return Promise.all(
		endpoints.map( async ( endpoint ) => {
			const sentMs = Date.now();
			try {
				const response = await fetch( endpoint, {
					signal: AbortSignal.timeout( 5000 ),
					redirect: 'error',
					headers: { 'Cache-Control': 'no-cache' },
				} );
				const sample = await response.json();
				if (
					! response.ok ||
					sample.version !== 1 ||
					typeof sample.process_id !== 'string' ||
					! sample.process_id ||
					! [ 'php-allocated', 'rss' ].includes(
						sample.memory_kind
					) ||
					[ 'elapsed_ms', 'cpu_ms', 'queries', 'memory_bytes' ].some(
						( key ) =>
							! Number.isFinite( sample[ key ] ) ||
							sample[ key ] < 0
					)
				) {
					throw new Error();
				}
				return { endpoint, sentMs, receivedMs: Date.now(), sample };
			} catch {
				return {
					endpoint,
					error: 'WebSocket process counters unavailable. Enable GSE_BENCH_METRICS=1 on the selected server.',
				};
			}
		} )
	);
}

/**
 * Compare snapshots bracketing a period. Do not call process memory a
 * per-editor allocation, or process uptime occupied PHP worker time.
 *
 * @param {Array<Object>} before Starting samples.
 * @param {Array<Object>} after  Ending samples.
 * @return {Array<Object>} Separate whole-process results.
 */
export function socketProcessCosts( before, after ) {
	return before.map( ( first, index ) => {
		const last = after[ index ];
		const a = first.sample;
		const b = last?.sample;
		const failure = first.error || last?.error;
		if (
			failure ||
			! a ||
			! b ||
			first.endpoint !== last.endpoint ||
			a.process_id !== b.process_id ||
			a.kind !== b.kind ||
			a.memory_kind !== b.memory_kind ||
			b.elapsed_ms <= a.elapsed_ms ||
			b.cpu_ms < a.cpu_ms ||
			b.queries < a.queries
		) {
			return {
				endpoint: first.endpoint,
				error:
					failure ||
					'WebSocket process restarted or its counters are inconsistent.',
			};
		}
		return {
			endpoint: first.endpoint,
			kind: b.kind,
			processId: b.process_id,
			sampledMs: b.elapsed_ms - a.elapsed_ms,
			cpuMs: b.cpu_ms - a.cpu_ms,
			queries: b.queries - a.queries,
			memoryKind: b.memory_kind,
			memoryStartBytes: a.memory_bytes,
			memoryEndBytes: b.memory_bytes,
		};
	} );
}
