/**
 * What a failed REST request tells the engines' review lanes.
 */

/**
 * The parts of a REST error the review lanes read.
 */
export interface RestErrorParts {
	/** The error code, such as `review_stale`. Null when there is none. */
	code: string | null;
	/** The error's data (the status, and whatever the route added). */
	data: Record< string, unknown >;
}

/**
 * Reads the code and the data out of whatever a REST request rejected
 * with. `apiFetch` rejects with the server's error as an object
 * (`{ code, message, data }`), but a network failure rejects with
 * something else, so nothing about the value is taken for granted.
 *
 * @param error What the request rejected with.
 * @return The error's code and data.
 */
export function restErrorParts( error: unknown ): RestErrorParts {
	const parts: RestErrorParts = { code: null, data: {} };
	if ( ! error || 'object' !== typeof error ) {
		return parts;
	}

	if ( 'code' in error && 'string' === typeof error.code ) {
		parts.code = error.code;
	}
	if ( 'data' in error && error.data && 'object' === typeof error.data ) {
		parts.data = { ...error.data };
	}

	return parts;
}
