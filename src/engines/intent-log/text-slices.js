/**
 * Slices of one version-addressed text range after splits and joins.
 * No document metadata is needed: the retained log records ownership changes.
 */

/** @typedef {import('./engine-types').IntentEnvelope} IntentEnvelope */

/**
 * Expand a server-generated row in deterministic application order. Ranges
 * share one pre-edit coordinate frame, so deletions run right to left.
 * @param {IntentEnvelope} intent Accepted or predicted intent.
 * @return {IntentEnvelope[]} Plain intents sharing the original envelope.
 */
export function textSliceIntents( intent ) {
	if ( ! intent.textSlices ) {
		return [ intent ];
	}
	const { textSlices, ...envelope } = intent;
	/** @type {Map<string, IntentEnvelope[]>} */
	const groups = new Map();
	for ( const payload of textSlices ) {
		const key = JSON.stringify( [ payload.syncId, payload.field ] );
		if ( ! groups.has( key ) ) {
			groups.set( key, [] );
		}
		groups.get( key )?.push( { ...envelope, payload } );
	}
	return [ ...groups.values() ].flatMap( ( group ) =>
		group.sort(
			( a, b ) => Number( b.payload.start ) - Number( a.payload.start )
		)
	);
}

/**
 * Preserve the author's envelope and original selection for review.
 * @param {IntentEnvelope}   intent Original intent.
 * @param {IntentEnvelope[]} slices Transformed slices.
 * @return {IntentEnvelope} One edit with several effects.
 */
export function withTextSlices( intent, slices ) {
	return {
		...intent,
		textSlices: slices.flatMap( ( slice ) =>
			textSliceIntents( slice ).map( ( part ) => part.payload )
		),
	};
}
