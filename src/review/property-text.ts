/**
 * A post field's value as the text a review record carries for a
 * `property` target, and as an accepted decision sends it back: strings
 * as they are, anything else as JSON (see SyncConflictTarget).
 *
 * @param value The field's value.
 * @return The text.
 */
export function propertyText( value: unknown ): string {
	if ( 'string' === typeof value ) {
		return value;
	}
	if ( undefined === value || null === value ) {
		return '';
	}
	return JSON.stringify( value );
}
