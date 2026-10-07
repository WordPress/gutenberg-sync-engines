/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * WordPress dependencies
 */
import { getBlockType, parse } from '@wordpress/blocks';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type {
	EngineCollection,
	EngineEntity,
	ObjectData,
	SyncEngine,
} from '@wordpress/sync';

/**
 * Internal dependencies
 *
 * The CRDT document schema (and undo) live beside this file (`constants`,
 * `doc`, `snapshot`, `undo`), inherited from the retired yjs-relay engine —
 * the wire documents interoperate byte-for-byte with that lineage.
 */
import {
	CRDT_RECORD_MAP_KEY,
	CRDT_STATE_MAP_KEY,
	CRDT_STATE_MAP_SAVED_AT_KEY as SAVED_AT_KEY,
	CRDT_STATE_MAP_VERSION_KEY as VERSION_KEY,
} from './constants';
import { createYjsDoc, markEntityAsSaved, serializeCrdtDoc } from './doc';
import { docContainsSnapshot, encodeDocSnapshot } from './snapshot';
import { createUndoManager } from './undo';
import { registerAwareness } from '../../awareness/registry';
import {
	createYjsServerSessionCodec,
	YJS_SERVER_ENGINE_PROTOCOL,
	YJS_SERVER_ENGINE_SLUG,
} from './session';

/**
 * The server-authoritative Yjs engine, client half.
 *
 * The same CRDT machinery as the relay engine with one inversion: the
 * SERVER owns the canonical document and its genesis. The client therefore
 * never seeds the document from the loaded editor record (the relay's
 * "initialization problem" workaround) — doing so would author a second,
 * duplicate universe of the same content. Instead:
 *
 * - `hydrate` is a no-op: the document starts empty and the server's
 *   genesis snapshot row populates it on first sync.
 * - Local changes made before that snapshot arrives are BUFFERED and
 *   merged once it does (the state map's `version` key, which only the
 *   server writes for this engine, is the bootstrap marker). A buffered
 *   edit that carries the block tree is not merged as is: the editor's
 *   tree is the SAVED post plus the person's keystrokes, and the
 *   server's document may be older or newer than the saved post, so a
 *   verbatim merge would count every difference as the person's edit
 *   (issue #57). Instead only the TEXT the person typed is applied to
 *   the document (see `replayTypedText`).
 * - `getEditorChanges` reports nothing until bootstrap, so an empty
 *   pre-sync document can never be dispatched into the editor as a
 *   mass deletion.
 * - After bootstrap, the dirtying `content` edit is withheld while the
 *   document still serializes byte-identical to the loaded record, so
 *   merely opening a post does not mark the editor dirty.
 *
 * After bootstrap the editor's blocks originate from this document's own
 * JSON, so steady-state diffs (`mergeCrdtBlocks`) are no-ops for
 * untouched blocks — schema equality with the server's genesis build is
 * not load-bearing beyond content fidelity.
 *
 * @return {SyncEngine} The yjs-server engine.
 */
export function createYjsServerEngine(): SyncEngine {
	return {
		slug: YJS_SERVER_ENGINE_SLUG,
		protocolVersion: YJS_SERVER_ENGINE_PROTOCOL,
		// Same per-peer Yjs undo as the relay: undo is client-local
		// machinery, orthogonal to where the canonical merge happens.
		createUndoManager,
		createEntity( { syncConfig, objectType, objectId } ): EngineEntity {
			const ydoc = createYjsDoc( { objectType } );
			const recordMap = ydoc.getMap( CRDT_RECORD_MAP_KEY );
			const stateMap = ydoc.getMap( CRDT_STATE_MAP_KEY );
			const now = Date.now();

			const awareness = syncConfig.createAwareness?.( ydoc );
			registerAwareness( objectType, objectId, awareness );

			const isBootstrapped = () =>
				undefined !== stateMap.get( VERSION_KEY );

			// Because hydrate() is a no-op, the server's genesis snapshot
			// arrives as a REMOTE change whose content typically matches the
			// loaded record byte-for-byte. The post sync config still reports
			// it: its `blocks` case cannot compare document blocks to editor
			// blocks (the two sides mint different block identities), so it
			// reports `blocks` on every remote change and injects a fresh
			// `content` serializer alongside. `blocks` is a transient edit,
			// but `content` is not, so merely opening a post marked the
			// editor dirty, activated the Save button, and scheduled
			// autosaves of unchanged content. Until the document and the
			// record first genuinely diverge, withhold that `content` edit
			// whenever the reported blocks serialize byte-identical to the
			// record's raw content. The `blocks` edit still dispatches so the
			// editor adopts the document's block identities at bootstrap.
			let docMayStillMatchRecord = true;

			// Edits made before the server snapshot arrives, replayed in
			// order once it does.
			type LocalChanges = Parameters<
				typeof syncConfig.applyChangesToCRDTDoc
			>[ 1 ];
			interface PendingLocalChange {
				changes: LocalChanges;
				origin: unknown;
				isSave: boolean;
			}
			let pendingLocalChanges: PendingLocalChange[] = [];

			// The loaded record's raw content: what the editor parsed into
			// the tree a pre-bootstrap keystroke carries.
			let savedContent: string | undefined;

			const applyChanges = (
				changes: LocalChanges,
				origin: unknown,
				isSave: boolean
			) => {
				ydoc.transact( () => {
					syncConfig.applyChangesToCRDTDoc( ydoc, changes );
					if ( isSave ) {
						markEntityAsSaved( ydoc );
					}
				}, origin );
			};

			/**
			 * Applies what a person TYPED before the snapshot landed, and
			 * nothing else. The buffered tree is compared with the saved post
			 * as the editor parsed it; when the two differ only in rich text,
			 * each difference is applied to the document's own text at the
			 * same block position (see `findTypedTextEdits`). Any other
			 * difference (a block added or removed, a non-text attribute) is
			 * dropped, as is a tree with no saved content to compare against:
			 * the window is one join round trip, and dropping such an edit
			 * costs far less than merging a stale tree would.
			 *
			 * One exception: a document that holds no blocks yet (an empty
			 * post) has nothing a tree could collide with, so the buffered
			 * edit is merged as it is. That keeps the first paragraph typed
			 * into a new post, which the comparison above would drop (the
			 * saved post parses to no blocks, the tree holds one).
			 *
			 * @param entry The last buffered edit that carried the tree.
			 */
			const replayTypedText = ( entry: PendingLocalChange ) => {
				const yblocks = recordMap.get( 'blocks' );
				if (
					! ( yblocks instanceof Y.Array ) ||
					0 === yblocks.length
				) {
					applyChanges( entry.changes, entry.origin, entry.isSave );
					return;
				}
				const after = entry.changes.blocks;
				if (
					! Array.isArray( after ) ||
					'string' !== typeof savedContent
				) {
					return;
				}
				let edits: TypedTextEdit[] | null;
				try {
					edits = findTypedTextEdits(
						parse( savedContent ) as EditorBlock[],
						after as EditorBlock[]
					);
				} catch {
					return;
				}
				if ( ! edits || ( 0 === edits.length && ! entry.isSave ) ) {
					return;
				}
				ydoc.transact( () => {
					for ( const edit of edits ) {
						applyTypedTextEdit( yblocks, edit );
					}
					if ( entry.isSave ) {
						markEntityAsSaved( ydoc );
					}
				}, entry.origin );
			};

			const onBootstrap = ( event: Y.YMapEvent< unknown > ) => {
				if (
					! event.keysChanged.has( VERSION_KEY ) ||
					! isBootstrapped()
				) {
					return;
				}
				stateMap.unobserve( onBootstrap );
				const pending = pendingLocalChanges;
				pendingLocalChanges = [];
				let lastTreeEntry: PendingLocalChange | undefined;
				for ( const entry of pending ) {
					if ( carriesBlockTree( entry.changes ) ) {
						lastTreeEntry = entry;
						continue;
					}
					applyChanges( entry.changes, entry.origin, entry.isSave );
				}
				if ( lastTreeEntry ) {
					replayTypedText( lastTreeEntry );
				}
			};
			stateMap.observe( onBootstrap );

			let observersAttached = false;
			let onRecordUpdate:
				| ( (
						events: Y.YEvent< any >[],
						transaction: Y.Transaction
				  ) => void )
				| undefined;
			let onStateMapUpdate:
				| ( (
						event: Y.YMapEvent< unknown >,
						transaction: Y.Transaction
				  ) => void )
				| undefined;

			return {
				awareness,

				createSession: () =>
					createYjsServerSessionCodec( { awareness, doc: ydoc } ),

				hydrate( record ) {
					// Deliberately no seeding: the server's genesis snapshot
					// is the document's origin. Seeding from the loaded
					// record here would fork a duplicate universe of the
					// same content; persisted client-side docs are likewise
					// ignored in favor of the server's canonical state. The
					// record's content is kept only as the base a buffered
					// pre-bootstrap edit was made on.
					savedContent = getRawContentString( record?.content );
				},

				applyLocalChanges( changes, origin, options ) {
					if ( ! isBootstrapped() ) {
						pendingLocalChanges.push( {
							changes,
							origin,
							isSave: Boolean( options.isSave ),
						} );
						return;
					}
					applyChanges( changes, origin, Boolean( options.isSave ) );
				},

				getEditorChanges: ( editedRecord ) => {
					if ( ! isBootstrapped() ) {
						return {};
					}

					const changes = syncConfig.getChangesFromCRDTDoc(
						ydoc,
						editedRecord
					);

					if ( ! docMayStillMatchRecord ) {
						return changes;
					}

					// An empty change set neither confirms nor refutes a
					// match; leave the guard armed for the next dispatch.
					if ( 0 === Object.keys( changes ).length ) {
						return changes;
					}

					if (
						isRedundantBootstrapDispatch( changes, editedRecord )
					) {
						const nonDirtyingChanges = { ...changes };
						delete nonDirtyingChanges.content;
						return nonDirtyingChanges;
					}

					docMayStillMatchRecord = false;
					return changes;
				},

				encodeSnapshot: () => encodeDocSnapshot( ydoc ),

				containsSnapshot: ( encoded ) =>
					docContainsSnapshot( ydoc, encoded ),

				serialize: () => serializeCrdtDoc( ydoc ),

				observe( observers ) {
					onRecordUpdate = ( _events, transaction ) => {
						if (
							transaction.local &&
							! ( transaction.origin instanceof Y.UndoManager )
						) {
							return;
						}
						observers.onRemoteChange();
					};

					onStateMapUpdate = ( event, transaction ) => {
						if ( transaction.local ) {
							return;
						}
						event.keysChanged.forEach( ( key ) => {
							if ( SAVED_AT_KEY === key ) {
								const savedAt = stateMap.get( SAVED_AT_KEY );
								if (
									'number' === typeof savedAt &&
									savedAt > now
								) {
									observers.onPeerSave();
								}
							}
						} );
					};

					recordMap.observeDeep( onRecordUpdate );
					stateMap.observe( onStateMapUpdate );
					observersAttached = true;
				},

				addToUndoScope( undoManager, meta ) {
					undoManager.addToScope( recordMap, meta );
				},

				destroy() {
					stateMap.unobserve( onBootstrap );
					if ( observersAttached ) {
						if ( onRecordUpdate ) {
							recordMap.unobserveDeep( onRecordUpdate );
						}
						if ( onStateMapUpdate ) {
							stateMap.unobserve( onStateMapUpdate );
						}
					}
					ydoc.destroy();
				},
			};
		},

		createCollection( { syncConfig, objectType } ): EngineCollection {
			const ydoc = createYjsDoc( { collection: true, objectType } );
			const stateMap = ydoc.getMap( CRDT_STATE_MAP_KEY );
			const now = Date.now();

			const awareness = syncConfig.createAwareness?.( ydoc );

			let observersAttached = false;
			let onStateMapUpdate:
				| ( (
						event: Y.YMapEvent< unknown >,
						transaction: Y.Transaction
				  ) => void )
				| undefined;

			return {
				awareness,

				createSession: () =>
					createYjsServerSessionCodec( { awareness, doc: ydoc } ),

				// The server's genesis writes the schema version; a local
				// write here would race it pointlessly.
				initialize: () => {},

				observe( observers ) {
					onStateMapUpdate = ( event, transaction ) => {
						if ( transaction.local ) {
							return;
						}
						event.keysChanged.forEach( ( key ) => {
							if ( SAVED_AT_KEY === key ) {
								const newValue = stateMap.get( SAVED_AT_KEY );
								if (
									'number' === typeof newValue &&
									newValue > now
								) {
									observers.onPeerSave();
								}
							}
						} );
					};

					stateMap.observe( onStateMapUpdate );
					observersAttached = true;
				},

				markSaved( origin ) {
					ydoc.transact( () => markEntityAsSaved( ydoc ), origin );
				},

				destroy() {
					if ( observersAttached && onStateMapUpdate ) {
						stateMap.unobserve( onStateMapUpdate );
					}
					ydoc.destroy();
				},
			};
		},
	};
}

/**
 * Whether a change set carries the editor's block tree: a `blocks` edit, or
 * a raw `content` string the tree is re-parsed from (the code editor's
 * per-keystroke dispatch). A lazy `content` serializer alone does not.
 *
 * @param changes A change set handed to applyLocalChanges.
 */
function carriesBlockTree( changes: Partial< ObjectData > ): boolean {
	if ( 'blocks' in changes ) {
		return true;
	}
	const content = changes.content;
	return undefined !== content && 'function' !== typeof content;
}

/** A block as the editor holds it, as far as this engine reads it. */
interface EditorBlock {
	name: string;
	attributes: Record< string, unknown >;
	innerBlocks?: EditorBlock[];
}

/**
 * One change to one rich-text attribute: at `path` (block indexes, outer
 * to inner), `attribute` had `removed` replaced by `inserted` at `offset`.
 */
interface TypedTextEdit {
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
function findTypedTextEdits(
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
 * Applies one typed change to the document's own text for that block. The
 * removed characters come out only when the document still holds them at
 * that offset; the inserted ones go in at that offset, or at the end when
 * the document's text is shorter. A block or attribute the document does
 * not have at that position is left alone.
 *
 * @param yblocks The document's top-level blocks.
 * @param edit    The change to apply.
 */
function applyTypedTextEdit(
	yblocks: Y.Array< unknown >,
	edit: TypedTextEdit
) {
	let blocks: unknown = yblocks;
	let yblock: unknown;
	for ( const index of edit.path ) {
		if ( ! ( blocks instanceof Y.Array ) ) {
			return;
		}
		yblock = blocks.get( index );
		blocks = yblock instanceof Y.Map ? yblock.get( 'innerBlocks' ) : null;
	}
	if ( ! ( yblock instanceof Y.Map ) ) {
		return;
	}
	const attributes = yblock.get( 'attributes' );
	if ( ! ( attributes instanceof Y.Map ) ) {
		return;
	}
	const text = attributes.get( edit.attribute );
	if ( ! ( text instanceof Y.Text ) ) {
		return;
	}
	const at = Math.min( edit.offset, text.length );
	if (
		edit.removed.length > 0 &&
		text.toString().startsWith( edit.removed, at )
	) {
		text.delete( at, edit.removed.length );
	}
	if ( edit.inserted.length > 0 ) {
		text.insert( at, edit.inserted );
	}
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

/**
 * Change-set keys that may appear in a redundant bootstrap dispatch. `blocks`
 * and `selection` are transient (non-dirtying) entity edits; `content` is the
 * injected serializer the bootstrap guard withholds. Any other key means the
 * document genuinely diverges from the record.
 */
const REDUNDANT_DISPATCH_KEYS = new Set( [ 'blocks', 'content', 'selection' ] );

/**
 * Extract the raw content string from an edited record's `content` property,
 * which is represented either as a plain string or as an object with a `raw`
 * property. Returns undefined for any other shape, notably the lazy serializer
 * function that replaces it once the editor has registered its own content
 * edit.
 *
 * @param value The edited record's `content` property.
 */
function getRawContentString( value: unknown ): string | undefined {
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

/**
 * Determine whether a reported change set merely re-states what the editor
 * already shows: the document's blocks serialize byte-identical to the
 * record's raw content, and nothing besides blocks, the injected content
 * serializer, and selection is reported. Such a dispatch carries no
 * information the editor lacks except the document's block identities, which
 * ride on the transient `blocks` edit alone.
 *
 * @param changes      Changes reported by the sync config.
 * @param editedRecord The edited record the changes were computed against.
 */
function isRedundantBootstrapDispatch(
	changes: ObjectData,
	editedRecord: ObjectData
): boolean {
	const contentEdit = changes.content;
	const recordContent = getRawContentString( editedRecord.content );

	if (
		! changes.blocks ||
		'function' !== typeof contentEdit ||
		'string' !== typeof recordContent
	) {
		return false;
	}

	const hasOnlyRedundantKeys = Object.keys( changes ).every( ( key ) =>
		REDUNDANT_DISPATCH_KEYS.has( key )
	);

	if ( ! hasOnlyRedundantKeys ) {
		return false;
	}

	// The injected serializer captures the reported blocks; invoking it here
	// trades one serialization for the comparison the sync config cannot make
	// itself (the document and the editor mint different block identities).
	// The trim mirrors the sync config's own persisted-document comparison.
	const serializedDocContent = contentEdit();

	return (
		'string' === typeof serializedDocContent &&
		serializedDocContent.trim() === recordContent
	);
}
