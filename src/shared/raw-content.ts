/**
 * Extract the raw content string from an edited record's `content` property,
 * which is represented either as a plain string or as an object with a `raw`
 * property. Returns undefined for any other shape, notably the lazy serializer
 * function that replaces it once the editor has registered its own content
 * edit.
 *
 * @param value The edited record's `content` property.
 */
export function getRawContentString( value: unknown ): string | undefined {
	if ( 'string' === typeof value ) {
		return value;
	}

	if (
		value &&
		'object' === typeof value &&
		'raw' in value &&
		'string' === typeof value.raw
	) {
		return value.raw;
	}

	return undefined;
}
