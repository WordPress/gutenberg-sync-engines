/**
 * External dependencies
 */
import type * as Y from 'yjs';

/*
 * The prototype's action capture (`capture`) used to receive every
 * block-editor action through core-data's `onEditorAction` seam. That seam
 * is gone from Gutenberg, and the plugin does not re-implement a store
 * middleware for it: the development fixture under
 * tests/tools/semantic-capture/ no longer receives live editor actions.
 */
declare global {
	interface Window {
		_gseSemanticPrototype?: {
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
