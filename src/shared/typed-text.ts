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
 * A version of the room's document with the person's edits on top: the
 * blocks the edits leave alone are the version's own blocks, unchanged.
 * Null when the held tree carries no edit.
 *
 * At each level the saved and held blocks share a run at the start and a
 * run at the end; the blocks between them are the changed region. Within
 * it, saved and held blocks pair up by position: a pair of the same type
 * keeps the version's block with only the attributes the person changed
 * (and recurses into its inner blocks); any other held block is new, and
 * any unpaired saved block is gone. The result differs from the version
 * only in that region, so a merge that skips equal blocks at the start
 * and the end of a list touches nothing else.
 *
 * @param saved   The saved post (parseSavedPost).
 * @param held    The editor's tree: the saved post plus the edits.
 * @param version A version that shows the saved post (showsSavedPost).
 */
export function rebaseHeldTree(
	saved: EditorBlock[],
	held: EditorBlock[],
	version: EditorBlock[]
): EditorBlock[] | null {
	if (
		saved.length === held.length &&
		saved.every( ( block, i ) => sameBlock( block, held[ i ] ) )
	) {
		return null;
	}
	return rebaseLevel( saved, held, version );
}

/**
 * One level of rebaseHeldTree.
 *
 * @param saved   Saved blocks at this level.
 * @param held    Held blocks at this level.
 * @param version Version blocks at this level (pairs with `saved`).
 */
function rebaseLevel(
	saved: EditorBlock[],
	held: EditorBlock[],
	version: EditorBlock[]
): EditorBlock[] {
	const max = Math.min( saved.length, held.length );
	let start = 0;
	while ( start < max && sameBlock( saved[ start ], held[ start ] ) ) {
		start++;
	}
	let end = 0;
	while (
		end < max - start &&
		sameBlock(
			saved[ saved.length - 1 - end ],
			held[ held.length - 1 - end ]
		)
	) {
		end++;
	}
	const region: EditorBlock[] = [];
	const savedCount = saved.length - start - end;
	const heldCount = held.length - start - end;
	for ( let i = 0; i < heldCount; i++ ) {
		const before = saved[ start + i ];
		const after = held[ start + i ];
		if ( i >= savedCount || before.name !== after.name ) {
			region.push( after );
			continue;
		}
		const base = version[ start + i ];
		const attributes = { ...base.attributes };
		const names = new Set( [
			...Object.keys( before.attributes ?? {} ),
			...Object.keys( after.attributes ?? {} ),
		] );
		for ( const name of names ) {
			const oldValue = before.attributes?.[ name ];
			const newValue = after.attributes?.[ name ];
			if (
				isRichText( after.name, name )
					? richTextToString( oldValue ) !==
					  richTextToString( newValue )
					: ! isDeepEqual( oldValue, newValue )
			) {
				if ( undefined === newValue ) {
					delete attributes[ name ];
				} else {
					attributes[ name ] = isRichText( after.name, name )
						? richTextToString( newValue )
						: newValue;
				}
			}
		}
		region.push( {
			...base,
			attributes,
			innerBlocks: rebaseLevel(
				before.innerBlocks ?? [],
				after.innerBlocks ?? [],
				base.innerBlocks ?? []
			),
		} );
	}
	return [
		...version.slice( 0, start ),
		...region,
		...version.slice( version.length - end ),
	];
}

/**
 * Whether two blocks from the same parser are the same: type, attributes
 * (rich text as strings) and inner blocks.
 *
 * @param a A block.
 * @param b Another block.
 */
function sameBlock( a: EditorBlock, b: EditorBlock ): boolean {
	if ( a.name !== b.name ) {
		return false;
	}
	const names = new Set( [
		...Object.keys( a.attributes ?? {} ),
		...Object.keys( b.attributes ?? {} ),
	] );
	for ( const name of names ) {
		const aValue = a.attributes?.[ name ];
		const bValue = b.attributes?.[ name ];
		if (
			isRichText( a.name, name )
				? richTextToString( aValue ) !== richTextToString( bValue )
				: ! isDeepEqual( aValue, bValue )
		) {
			return false;
		}
	}
	const aInner = a.innerBlocks ?? [];
	const bInner = b.innerBlocks ?? [];
	return (
		aInner.length === bInner.length &&
		aInner.every( ( block, i ) => sameBlock( block, bInner[ i ] ) )
	);
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
 */
export interface TypedTextEdit {
	path: number[];
	attribute: string;
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
					edits.push( {
						path: [ ...path, i ],
						attribute: name,
						...diffText( oldText, newText ),
					} );
				}
			} else if ( ! isDeepEqual( oldValue, newValue ) ) {
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
