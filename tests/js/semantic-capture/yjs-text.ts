/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * Internal dependencies
 */
import type { EditingEvent } from './capture';

/**
 * Proves targeted text application without choosing a block storage schema.
 * The resolver must return the Y.Text represented by the editor's BEFORE value.
 * Stale bases and rich HTML require the production editor binding, not a guess.
 * @param doc         Yjs document to edit.
 * @param event       Captured local edit.
 * @param resolveText Resolves a stable block ID to its shared text.
 */
export function applyPlainTextEvent(
	doc: Y.Doc,
	event: EditingEvent,
	resolveText: ( blockId: string ) => Y.Text
): boolean {
	if ( event.kind !== 'attributes' || event.before.length !== 1 ) {
		return false;
	}
	const before = event.before[ 0 ];
	const after = event.after[ 0 ];
	const fields = event.fields[ before.id ];
	const oldText = before.attributes.content;
	const newText = after.attributes.content;
	if (
		before.name !== 'core/paragraph' ||
		before.id !== after.id ||
		fields.length !== 1 ||
		fields[ 0 ] !== 'content' ||
		typeof oldText !== 'string' ||
		typeof newText !== 'string' ||
		/[<&]/.test( oldText + newText )
	) {
		return false;
	}
	const text = resolveText( before.id );
	if ( text.doc !== doc || text.toString() !== oldText ) {
		return false;
	}
	// Compare this field only. Code points keep a shared emoji surrogate
	// from being split; Y.Text positions themselves use UTF-16 offsets.
	const oldChars = Array.from( oldText );
	const newChars = Array.from( newText );
	let start = 0;
	while (
		start < oldChars.length &&
		start < newChars.length &&
		oldChars[ start ] === newChars[ start ]
	) {
		start++;
	}
	let end = 0;
	while (
		end < oldChars.length - start &&
		end < newChars.length - start &&
		oldChars[ oldChars.length - 1 - end ] ===
			newChars[ newChars.length - 1 - end ]
	) {
		end++;
	}
	const offset = oldChars.slice( 0, start ).join( '' ).length;
	const removed = oldChars.slice( start, oldChars.length - end ).join( '' );
	const inserted = newChars.slice( start, newChars.length - end ).join( '' );
	doc.transact( () => {
		text.delete( offset, removed.length );
		text.insert( offset, inserted );
	}, event.id );
	return true;
}
