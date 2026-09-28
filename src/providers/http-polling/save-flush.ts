/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.apiFetch.
import apiFetch from '@wordpress/api-fetch';

/**
 * Flush-before-save: a lone tab holds its updates until company arrives,
 * and a save that lands while the room never saw those updates sets the
 * reload trap (the editor bootstraps from the stale room over the freshly
 * loaded post). So every entity save first flushes the held queue through
 * the room. The seam is the same `apiFetch` middleware de-rtc uses for its
 * declared base version: a POST/PUT to an entity's REST route, autosaves
 * excluded (they write a revision, never the post).
 */

const FLUSH_TIMEOUT_MS = 5000;

let flusher: ( () => Promise< void > ) | null = null;
let installed = false;

function isEntitySave( options: {
	path?: string;
	method?: string;
	data?: unknown;
} ): boolean {
	const method = String( options.method ?? 'GET' ).toUpperCase();
	if ( 'POST' !== method && 'PUT' !== method ) {
		return false;
	}
	const path = String( options.path ?? '' );
	if (
		-1 !== path.indexOf( '/autosaves' ) ||
		-1 !== path.indexOf( '/wp-sync/' )
	) {
		return false;
	}
	return /\/wp\/v2\/[a-z0-9_-]+\/\d+(?:\?|$)/.test( path );
}

/**
 * Registers the flush the middleware awaits before an entity save, and
 * installs the middleware on first use.
 *
 * @param flush Flushes held updates; resolves when they have gone out.
 */
export function registerSaveFlush(
	flush: ( () => Promise< void > ) | null
): void {
	flusher = flush;
	if ( installed || ! flush ) {
		return;
	}
	installed = true;
	apiFetch.use( async ( options, next ) => {
		if ( flusher && isEntitySave( options ) ) {
			try {
				await Promise.race( [
					flusher(),
					new Promise< void >( ( resolve ) =>
						setTimeout( resolve, FLUSH_TIMEOUT_MS )
					),
				] );
			} catch {
				// Never block the save itself.
			}
		}
		return next( options );
	} );
}

/**
 * Test use only: whether a request would trigger the flush.
 *
 * @param options        The apiFetch options.
 * @param options.path
 * @param options.method
 */
export function isEntitySaveForTesting( options: {
	path?: string;
	method?: string;
} ): boolean {
	return isEntitySave( options );
}
