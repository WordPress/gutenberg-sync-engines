/**
 * Check measurement support before login, site changes, or editing.
 *
 * @param {string}   base    Site URL.
 * @param {Function} request HTTP client.
 * @return {Promise<void>} Resolves when the clock probe is supported.
 */
export async function checkMeasurementSupport( base, request = fetch ) {
	try {
		const response = await request( `${ base }/?_rtctest=1&_rtcclock=1`, {
			signal: AbortSignal.timeout( 10000 ),
			redirect: 'error',
		} );
		const data = await response.json();
		if (
			! response.ok ||
			data?.timeline_version !== 1 ||
			! Number.isFinite( data.at_ms ) ||
			typeof data.clock_id !== 'string' ||
			! data.clock_id
		) {
			throw new Error();
		}
	} catch {
		throw new Error(
			'Measurement check failed before any site changes. Check the target URL and WP_BASE_URL. The site must serve the current tests/benchmarks/host/mu-bench-log.php from mu-plugins, with its matching plugin files and diagnostics enabled. See tests/benchmarks/README.md.'
		);
	}
}
