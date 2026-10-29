import type { EntitySyncManager } from '@wordpress/core-data';
/**
 * External dependencies
 */
import type * as Y from 'yjs';

declare global {
	interface Window {
		_gseSemanticPrototype?: {
			capture?: EntitySyncManager[ 'onEditorAction' ];
			apply: (
				doc: Y.Doc,
				changes: Record< string, unknown >,
				entity: string
			) => boolean;
		};
	}
}

/**
 * Optional development binding, installed only by the prototype fixture.
 * @param doc     Shared document.
 * @param changes Local entity edits.
 * @param entity  Entity that owns this shared document.
 */
export function applySemanticPrototype(
	doc: Y.Doc,
	changes: Record< string, unknown >,
	entity: string
): boolean {
	return (
		typeof window !== 'undefined' &&
		window._gseSemanticPrototype?.apply( doc, changes, entity ) === true
	);
}

/**
 * Send accepted editor actions to the optional development capture. The
 * selected entity provider is the only Gutenberg registration.
 * @param change Accepted action and its before/after state.
 */
export const captureSemanticPrototypeAction: NonNullable<
	EntitySyncManager[ 'onEditorAction' ]
> = ( change ) => {
	if ( typeof window !== 'undefined' ) {
		window._gseSemanticPrototype?.capture?.( change );
	}
};
