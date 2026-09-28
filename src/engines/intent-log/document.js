/**
 * Minimal block document model. See SPEC.md ("Known simplifications").
 *
 * A document is a tree of blocks. Each block carries: syncId, blockType,
 * per-key attrs with per-key versions (the sync-map registers), named
 * rich-text fields (each text + format spans — real blocks have several
 * rich-text attributes, e.g. quote value + citation), and children.
 *
 * The model favors clarity over performance: lookups walk the tree, and the
 * reducer clones the document before mutating. Documents in the simulator
 * are small; the production representation is a separate concern.
 */

/** @typedef {import('./engine-types').EngineBlock} EngineBlock */
/** @typedef {import('./engine-types').EngineDocument} EngineDocument */
/** @typedef {import('./engine-types').EngineField} EngineField */
/** @typedef {import('./engine-types').FormatSpan} FormatSpan */

/**
 * Loose input shape of one rich-text field, as accepted by block specs.
 *
 * @typedef {Object} FieldSpec
 * @property {string}       [text]    Plain text (default: empty).
 * @property {FormatSpan[]} [formats] Format spans (default: none).
 */

/**
 * Loose input shape of a block, as accepted by makeBlock and createDocument
 * (the bridge builds these from editor blocks; intents carry them in
 * insert_block payloads). Everything but identity and type is optional;
 * `text`/`formats` are shorthand for the default `content` field.
 *
 * @typedef {Object} BlockSpec
 * @property {string}                    syncId         Block identity.
 * @property {string}                    blockType      Block type name.
 * @property {Record<string, unknown>}   [attrs]        Attribute registers.
 * @property {Record<string, number>}    [attrVersions] Per-attribute versions.
 * @property {Record<string, FieldSpec>} [fields]       Named rich-text fields.
 * @property {string}                    [text]         Default-field text.
 * @property {FormatSpan[]}              [formats]      Default-field spans.
 * @property {BlockSpec[]}               [children]     Nested block specs.
 * @property {string|null}               [syncParent]   Split-lineage parent.
 */

/**
 * Where a block was found in a document: the node, the sibling array that
 * holds it, its index there, and the parent's id (null at the root).
 *
 * @typedef {Object} BlockLocation
 * @property {EngineBlock}   block    The block node.
 * @property {EngineBlock[]} siblings The array containing it (live, mutable).
 * @property {number}        index    Its index within `siblings`.
 * @property {string|null}   parentId Parent block id, or null at the root.
 */

/**
 * The field name used when a block spec or intent does not name one. Mirrors
 * the common case of a single rich-text attribute (`content`).
 */
export const DEFAULT_FIELD = 'content';

/**
 * Creates a field node from a loose spec.
 *
 * @param {FieldSpec} [spec] Field spec.
 * @return {EngineField} Field node.
 */
function makeField( spec = {} ) {
	return {
		text: spec.text ?? '',
		formats: ( spec.formats ?? [] ).map( ( span ) => ( { ...span } ) ),
	};
}

/**
 * Creates a block node.
 *
 * @param {BlockSpec} spec Block spec: syncId, blockType, and optionally
 *                         attrs, fields (name → { text, formats }),
 *                         text/formats (shorthand for the default `content`
 *                         field), children, syncParent.
 * @return {EngineBlock} Block node.
 */
export function makeBlock( spec ) {
	/** @type {Record<string, EngineField>} */
	const fields = {};
	for ( const [ name, field ] of Object.entries( spec.fields ?? {} ) ) {
		fields[ name ] = makeField( field );
	}
	if ( ! ( DEFAULT_FIELD in fields ) ) {
		fields[ DEFAULT_FIELD ] = makeField( {
			text: spec.text,
			formats: spec.formats,
		} );
	}
	return {
		syncId: spec.syncId,
		blockType: spec.blockType,
		attrs: { ...( spec.attrs ?? {} ) },
		attrVersions: { ...( spec.attrVersions ?? {} ) },
		fields,
		syncParent: spec.syncParent ?? null,
		children: ( spec.children ?? [] ).map( makeBlock ),
	};
}

/**
 * Returns a block's named field, creating an empty one on first write-style
 * access. The reducer is forgiving: writing to a field the block does not
 * have yet creates it rather than crashing a replay.
 *
 * @param {EngineBlock} block Block node (mutated if the field is missing).
 * @param {string}      name  Field name.
 * @return {EngineField} { text, formats }.
 */
export function ensureField( block, name ) {
	if ( ! block.fields[ name ] ) {
		block.fields[ name ] = makeField();
	}
	return block.fields[ name ];
}

/**
 * Creates a document from root block specs and optional entity properties.
 *
 * @param {BlockSpec[]}             [blocks] Root block specs.
 * @param {Record<string, unknown>} [props]  Entity properties (name → value).
 * @return {EngineDocument} Document.
 */
export function createDocument( blocks = [], props = {} ) {
	/** @type {EngineDocument} */
	const doc = { root: blocks.map( makeBlock ) };
	if ( Object.keys( props ).length ) {
		doc.props = { ...props };
		doc.propVersions = {};
	}
	return doc;
}

/**
 * Ensures a document has entity property maps, creating them on first
 * write-style access — documents predating the entity family (or created
 * without properties) lack them.
 *
 * @param {EngineDocument} doc Document (mutated if the maps are missing).
 * @return {{ props: Record<string, unknown>, propVersions: Record<string, number> }}
 *         The document's { props, propVersions }.
 */
export function ensureProps( doc ) {
	if ( ! doc.props ) {
		doc.props = {};
	}
	if ( ! doc.propVersions ) {
		doc.propVersions = {};
	}
	return { props: doc.props, propVersions: doc.propVersions };
}

/**
 * Deep-clones one plain-JSON value: objects made with `{}`, arrays,
 * strings, numbers, booleans, null, and nothing else.
 *
 * @param {*} value Plain-JSON value.
 * @return {*} Clone.
 */
function clonePlain( value ) {
	if ( null === value || 'object' !== typeof value ) {
		return value;
	}
	if ( Array.isArray( value ) ) {
		const length = value.length;
		const clone = new Array( length );
		for ( let index = 0; index < length; index++ ) {
			clone[ index ] = clonePlain( value[ index ] );
		}
		return clone;
	}
	/** @type {Record<string, unknown>} */
	const clone = {};
	for ( const key in value ) {
		if ( Object.prototype.hasOwnProperty.call( value, key ) ) {
			clone[ key ] = clonePlain( value[ key ] );
		}
	}
	return clone;
}

/**
 * Deep-clones a document.
 *
 * This is a hand-rolled walk instead of `structuredClone`, on purpose.
 * Documents are plain JSON data by contract — they cross the wire as JSON,
 * and the PHP twin holds the same document as nested arrays — so the
 * general clone algorithm is not needed. And in wp-admin the global
 * `structuredClone` is not the browser's fast built-in: WordPress's
 * `wp-polyfill` (core-js) replaces it everywhere with a slow script
 * implementation, because core-js judges every browser's error-cloning
 * behavior non-compliant. This function runs once per applied intent, so
 * with that replacement in place a fast typing burst froze the editor's
 * main thread for 15+ seconds (issue #37). The plain walk avoids the
 * global entirely and is faster than even the native function for this
 * data.
 *
 * WARNING: the walk only understands plain JSON shapes. A Map, Set, Date,
 * RegExp, typed array, or class instance inside a document would come back
 * as an empty or hollow `{}`, and a cyclic reference would recurse without
 * end. Keep every attr, field, and property value JSON-shaped; do not
 * introduce such types into documents.
 *
 * @param {EngineDocument} doc Document.
 * @return {EngineDocument} Clone.
 */
export function cloneDocument( doc ) {
	return clonePlain( doc );
}

/**
 * Depth-first walk over a sibling array and every descendant. The visitor
 * runs for each block before its children; the first defined value it
 * returns stops the walk and becomes the result.
 *
 * @template T
 * @param {EngineBlock[]}                                                                                        siblings Blocks to walk (with their subtrees).
 * @param {string|null}                                                                                          parentId Id of the block owning `siblings`, or
 *                                                                                                                        null at the root.
 * @param {( block: EngineBlock, siblings: EngineBlock[], index: number, parentId: string|null ) => T|undefined} visitor
 *                                                                                                                        Per-block callback.
 * @return {T|undefined} The visitor's first defined result, else undefined.
 */
function walk( siblings, parentId, visitor ) {
	for ( let index = 0; index < siblings.length; index++ ) {
		const block = siblings[ index ];
		const result =
			visitor( block, siblings, index, parentId ) ??
			walk( block.children, block.syncId, visitor );
		if ( result !== undefined ) {
			return result;
		}
	}
	return undefined;
}

/**
 * Finds a block and its location.
 *
 * @param {EngineDocument} doc    Document.
 * @param {string}         syncId Target block id.
 * @return {BlockLocation|null} { block, siblings, index, parentId } or null.
 */
export function locateBlock( doc, syncId ) {
	return (
		walk( doc.root, null, ( block, siblings, index, parentId ) =>
			block.syncId === syncId
				? { block, siblings, index, parentId }
				: undefined
		) ?? null
	);
}

/**
 * Returns the block node for a syncId, or null.
 *
 * @param {EngineDocument} doc    Document.
 * @param {string}         syncId Target block id.
 * @return {EngineBlock|null} Block node.
 */
export function getBlock( doc, syncId ) {
	return locateBlock( doc, syncId )?.block ?? null;
}

/**
 * Whether the subtree rooted at `rootBlock` contains `syncId` (including the
 * root itself). Used for move cycle checks.
 *
 * @param {EngineBlock} rootBlock Subtree root.
 * @param {string}      syncId    Candidate descendant id.
 * @return {boolean} Whether contained.
 */
export function subtreeContains( rootBlock, syncId ) {
	if ( rootBlock.syncId === syncId ) {
		return true;
	}
	return rootBlock.children.some( ( child ) =>
		subtreeContains( child, syncId )
	);
}

/**
 * All syncIds in the document, in depth-first order.
 *
 * @param {EngineDocument} doc Document.
 * @return {string[]} Ids.
 */
export function allSyncIds( doc ) {
	/** @type {string[]} */
	const ids = [];
	walk( doc.root, null, ( block ) => {
		ids.push( block.syncId );
		return undefined;
	} );
	return ids;
}

/**
 * A block with its attrs, versions, fields, and format spans in canonical
 * order (see canonicalJson).
 *
 * @param {EngineBlock} block Block node.
 * @return {EngineBlock} Canonically ordered copy.
 */
function canonicalBlock( block ) {
	/**
	 * Object entries sorted by key, values optionally mapped.
	 *
	 * @template V
	 * @template R
	 * @param {Record<string, V>}     obj        Source object.
	 * @param {( value: V ) => R | V} [mapValue] Value transform (default:
	 *                                           identity).
	 * @return {Record<string, R | V>} Sorted copy.
	 */
	const sortEntries = ( obj, mapValue = ( value ) => value ) =>
		Object.fromEntries(
			Object.entries( obj )
				.sort( ( [ a ], [ b ] ) => ( a < b ? -1 : 1 ) )
				.map( ( [ key, value ] ) => [ key, mapValue( value ) ] )
		);
	/**
	 * @param {EngineField} field Field node.
	 * @return {EngineField} Copy with spans in canonical order.
	 */
	const canonicalField = ( field ) => ( {
		text: field.text,
		formats: [ ...field.formats ].sort(
			( a, b ) =>
				a.start - b.start ||
				a.end - b.end ||
				( a.format < b.format ? -1 : 1 )
		),
	} );
	return {
		syncId: block.syncId,
		blockType: block.blockType,
		attrs: sortEntries( block.attrs ),
		attrVersions: sortEntries( block.attrVersions ),
		fields: sortEntries( block.fields, canonicalField ),
		syncParent: block.syncParent,
		children: block.children.map( canonicalBlock ),
	};
}

/**
 * Canonical JSON of a document — key- and span-order independent, so
 * incrementally maintained documents can be compared with fresh replays.
 *
 * Entity property maps are emitted ONLY when non-empty, so documents
 * predating the entity family canonicalize byte-identically to their
 * original form (the frozen cross-language vectors depend on this).
 *
 * @param {EngineDocument} doc Document.
 * @return {string} Canonical JSON.
 */
export function canonicalJson( doc ) {
	/**
	 * @template V
	 * @param {Record<string, V>} obj Source object.
	 * @return {Record<string, V>} Copy with entries sorted by key.
	 */
	const sortEntries = ( obj ) =>
		Object.fromEntries(
			Object.entries( obj ).sort( ( [ a ], [ b ] ) => ( a < b ? -1 : 1 ) )
		);
	/** @type {EngineDocument} */
	const canonical = { root: doc.root.map( canonicalBlock ) };
	if ( doc.props && Object.keys( doc.props ).length ) {
		canonical.props = sortEntries( doc.props );
	}
	if ( doc.propVersions && Object.keys( doc.propVersions ).length ) {
		canonical.propVersions = sortEntries( doc.propVersions );
	}
	return JSON.stringify( canonical );
}

/**
 * Structural equality via canonical JSON.
 *
 * @param {EngineDocument} a First document.
 * @param {EngineDocument} b Second document.
 * @return {boolean} Whether structurally equal.
 */
export function documentsEqual( a, b ) {
	return canonicalJson( a ) === canonicalJson( b );
}
