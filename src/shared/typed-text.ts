/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided by the editor runtime.
import { getBlockType, parse } from '@wordpress/blocks';

/*
 * What a person did before a window's first sync response arrived.
 *
 * Until the room's document arrives, the editor shows the saved post as it
 * parsed it, and any edit hands the engine that whole tree. The tree is
 * the saved post plus the person's edits, while the room's document may be
 * older or newer than the saved post, so treating the tree as an edit of
 * the document counts every difference between the two as the person's
 * work (issues #57 and #100). An engine either authors the tree against
 * the version of the room that shows the saved post (showsSavedPost), so
 * its own merge moves the edits past what landed since, or carries over
 * only the rich-text changes (findTypedTextSinceSave).
 */

/**
 * The saved post as the editor parsed it, or null when it cannot be
 * parsed.
 *
 * @param savedContent The loaded record's raw content.
 */
export function parseSavedPost( savedContent: string ): EditorBlock[] | null {
	try {
		return parse( savedContent ) as EditorBlock[];
	} catch {
		return null;
	}
}

/**
 * Whether a version of the room's document shows the saved post: the same
 * block types in the same order and nesting, with the same rich text.
 * Block identity is compared only where both sides carry one (the saved
 * post may predate identities). Other attributes are not compared: each
 * engine stores them in its own form, and parsing adds defaults.
 *
 * @param saved   The saved post (parseSavedPost).
 * @param version A version of the room's document, as editor blocks.
 */
export function showsSavedPost(
	saved: EditorBlock[],
	version: EditorBlock[]
): boolean {
	if ( saved.length !== version.length ) {
		return false;
	}
	return saved.every( ( before, i ) => {
		const block = version[ i ];
		if ( before.name !== block.name ) {
			return false;
		}
		const savedId = syncIdOf( before );
		const versionId = syncIdOf( block );
		if ( savedId && versionId && savedId !== versionId ) {
			return false;
		}
		const names = new Set( [
			...Object.keys( before.attributes ?? {} ),
			...Object.keys( block.attributes ?? {} ),
		] );
		for ( const name of names ) {
			if (
				isRichText( block.name, name ) &&
				richTextToString( before.attributes?.[ name ] ) !==
					richTextToString( block.attributes?.[ name ] )
			) {
				return false;
			}
		}
		return showsSavedPost(
			before.innerBlocks ?? [],
			block.innerBlocks ?? []
		);
	} );
}

/**
 * A block's identity (`metadata.syncId`), if it carries one.
 *
 * @param block A block.
 */
function syncIdOf( block: EditorBlock ): string | undefined {
	const syncId = (
		block.attributes?.metadata as { syncId?: unknown } | undefined
	 )?.syncId;
	return 'string' === typeof syncId ? syncId : undefined;
}

/**
 * The rich-text changes a tree carries over the saved post, or null when
 * they differ in any other way or the saved post cannot be parsed.
 *
 * @param savedContent The loaded record's raw content.
 * @param tree         The editor's tree after the person typed.
 */
export function findTypedTextSinceSave(
	savedContent: string,
	tree: EditorBlock[]
): TypedTextEdit[] | null {
	const saved = parseSavedPost( savedContent );
	return saved ? findTypedTextEdits( saved, tree ) : null;
}

/** A block as the editor holds it, as far as this comparison reads it. */
export interface EditorBlock {
	name: string;
	attributes: Record< string, unknown >;
	innerBlocks?: EditorBlock[];
}

/**
 * One change to one rich-text attribute: at `path` (block indexes, outer
 * to inner), `attribute` had `removed` replaced by `inserted` at `offset`.
 * `syncId` is the block's saved identity, when it has one, and `before` the
 * attribute's whole saved text.
 */
export interface TypedTextEdit {
	path: number[];
	syncId?: string;
	attribute: string;
	before: string;
	offset: number;
	removed: string;
	inserted: string;
}

/**
 * The rich-text changes between the tree the person started from and the
 * tree they typed into, or null when the two differ in any other way
 * (block count, block type, a non-text attribute).
 *
 * @param base  The saved post as the editor parsed it.
 * @param after The editor's tree after the person typed.
 * @param path  Block indexes of the containing block, outer to inner.
 */
export function findTypedTextEdits(
	base: EditorBlock[],
	after: EditorBlock[],
	path: number[] = []
): TypedTextEdit[] | null {
	if ( base.length !== after.length ) {
		return null;
	}
	const edits: TypedTextEdit[] = [];
	for ( let i = 0; i < base.length; i++ ) {
		const before = base[ i ];
		const block = after[ i ];
		if ( before.name !== block.name ) {
			return null;
		}
		const names = new Set( [
			...Object.keys( before.attributes ?? {} ),
			...Object.keys( block.attributes ?? {} ),
		] );
		for ( const name of names ) {
			const oldValue = before.attributes?.[ name ];
			const newValue = block.attributes?.[ name ];
			if ( isRichText( block.name, name ) ) {
				const oldText = richTextToString( oldValue );
				const newText = richTextToString( newValue );
				if ( oldText !== newText ) {
					const syncId = syncIdOf( block );
					edits.push( {
						path: [ ...path, i ],
						...( syncId ? { syncId } : {} ),
						attribute: name,
						before: oldText,
						...diffText( oldText, newText ),
					} );
				}
			} else if (
				! isDeepEqual(
					withoutSyncId( name, oldValue ),
					withoutSyncId( name, newValue )
				)
			) {
				return null;
			}
		}
		const inner = findTypedTextEdits(
			before.innerBlocks ?? [],
			block.innerBlocks ?? [],
			[ ...path, i ]
		);
		if ( ! inner ) {
			return null;
		}
		edits.push( ...inner );
	}
	return edits;
}

/**
 * An attribute value with the block's identity left out. The editor stamps
 * `metadata.syncId` on blocks of a post saved without one before anybody
 * types, so the stamp alone is no edit by the person.
 *
 * @param name  Attribute name.
 * @param value Attribute value.
 */
function withoutSyncId( name: string, value: unknown ): unknown {
	if ( 'metadata' !== name || ! value || 'object' !== typeof value ) {
		return value;
	}
	const { syncId, ...rest } = value as Record< string, unknown >;
	return Object.keys( rest ).length > 0 ? rest : undefined;
}

/**
 * The one contiguous change between two strings: the text after the
 * common start that is not part of the common end.
 *
 * @param before The text before the change.
 * @param after  The text after the change.
 */
function diffText(
	before: string,
	after: string
): Pick< TypedTextEdit, 'offset' | 'removed' | 'inserted' > {
	const max = Math.min( before.length, after.length );
	let start = 0;
	while ( start < max && before[ start ] === after[ start ] ) {
		start++;
	}
	let end = 0;
	while (
		end < max - start &&
		before[ before.length - 1 - end ] === after[ after.length - 1 - end ]
	) {
		end++;
	}
	return {
		offset: start,
		removed: before.slice( start, before.length - end ),
		inserted: after.slice( start, after.length - end ),
	};
}

/**
 * A rich-text attribute as a string: the editor holds RichTextData, the
 * parser may hold either, and a missing value reads as empty.
 *
 * @param value The attribute value.
 */
function richTextToString( value: unknown ): string {
	return null === value || undefined === value ? '' : String( value );
}

/**
 * Whether a registered block's attribute holds rich text.
 *
 * @param blockName     Block name.
 * @param attributeName Attribute name.
 */
function isRichText( blockName: string, attributeName: string ): boolean {
	const attributes = getBlockType( blockName )?.attributes as
		| Record< string, { type?: string } >
		| undefined;
	return 'rich-text' === attributes?.[ attributeName ]?.type;
}

/**
 * Structural equality for the JSON values a block attribute holds.
 *
 * @param a A value.
 * @param b Another value.
 */
function isDeepEqual( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}
	if ( Array.isArray( a ) && Array.isArray( b ) ) {
		return (
			a.length === b.length &&
			a.every( ( item, i ) => isDeepEqual( item, b[ i ] ) )
		);
	}
	if (
		a &&
		b &&
		'object' === typeof a &&
		'object' === typeof b &&
		! Array.isArray( a ) &&
		! Array.isArray( b )
	) {
		const aRecord = a as Record< string, unknown >;
		const bRecord = b as Record< string, unknown >;
		const aKeys = Object.keys( aRecord );
		return (
			aKeys.length === Object.keys( bRecord ).length &&
			aKeys.every(
				( key ) =>
					key in bRecord &&
					isDeepEqual( aRecord[ key ], bRecord[ key ] )
			)
		);
	}
	return false;
}
