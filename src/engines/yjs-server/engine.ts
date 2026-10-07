/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * WordPress dependencies
 */
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
	findTypedTextSinceSave,
	parseSavedPost,
	rebaseHeldTree,
	showsSavedPost,
	type EditorBlock,
	type TypedTextEdit,
} from '../../shared/typed-text';
import {
	createYjsServerSessionCodec,
	YJS_SERVER_ENGINE_PROTOCOL,
	YJS_SERVER_ENGINE_SLUG,
	YJS_SERVER_SESSION_ORIGIN,
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
 *   (issue #57). Instead the edit is applied to the version that shows
 *   the saved post, and the CRDT merges it with what landed since (see
 *   `replayHeldTree`, issue #100).
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
			 * Applies to `doc` what a person TYPED before the snapshot
			 * landed, and nothing else (issue #57): the fallback of
			 * replayHeldTree when no server row shows the saved post. The
			 * buffered tree is compared with the saved post as the editor
			 * parsed it; when the two differ only in rich text, each
			 * difference is applied to the document's own text at the same
			 * block position (see `findTypedTextSinceSave`). Any other
			 * difference is dropped: with no version to apply it to, a
			 * guess would cost a peer their work.
			 *
			 * @param doc  The document to edit.
			 * @param held The buffered tree.
			 */
			const applyTypedText = ( doc: Y.Doc, held: EditorBlock[] ) => {
				const yblocks = doc
					.getMap( CRDT_RECORD_MAP_KEY )
					.get( 'blocks' );
				const edits =
					'string' === typeof savedContent
						? findTypedTextSinceSave( savedContent, held )
						: null;
				if ( ! edits || ! ( yblocks instanceof Y.Array ) ) {
					return;
				}
				for ( const edit of edits ) {
					applyTypedTextEdit( yblocks, edit );
				}
			};

			/*
			 * The server's rows as this document applied them, kept until a
			 * buffered edit has been replayed: replayHeldTree rebuilds the
			 * document at each row to find the one that shows the saved
			 * post.
			 */
			const serverUpdates: Uint8Array[] = [];
			const recordServerUpdate = (
				update: Uint8Array,
				origin: unknown
			) => {
				if ( YJS_SERVER_SESSION_ORIGIN === origin ) {
					serverUpdates.push( update );
				}
			};
			ydoc.on( 'updateV2', recordServerUpdate );

			/**
			 * Applies what a person did before the snapshot landed (typing,
			 * a new or removed block) as an edit of the version they were
			 * looking at: the saved post (issue #100).
			 *
			 * Runs once the whole first response has landed (the snapshot
			 * row bootstraps the document, and the room's later rows follow
			 * it in the same response). The document is rebuilt at each
			 * server row, and the newest state that shows the saved post
			 * (showsSavedPost) takes the person's edits (rebaseHeldTree)
			 * through the ordinary local-change path. Only what that adds
			 * to the rebuilt state goes into the document, so the CRDT
			 * merges it with everything that landed since, as it would a
			 * peer's concurrent edit.
			 *
			 * A document still empty after the response (an empty post)
			 * takes the edit as it is. When no row shows the saved post (a
			 * checkpoint newer than the save), only the typed text carries
			 * over (applyTypedText, issue #57).
			 *
			 * @param entry The last buffered edit that carried the tree.
			 */
			const replayHeldTree = ( entry: PendingLocalChange ) => {
				ydoc.off( 'updateV2', recordServerUpdate );
				const updates = serverUpdates.splice( 0 );
				const held = entry.changes.blocks;
				const saved =
					'string' === typeof savedContent
						? parseSavedPost( savedContent )
						: null;
				const yblocks = recordMap.get( 'blocks' );
				const empty =
					! ( yblocks instanceof Y.Array ) || 0 === yblocks.length;

				/*
				 * The edit is made on a copy and only the difference goes into
				 * the document, as remote rows do. A local transaction here
				 * would never reach the editor, which already shows the
				 * document without the edit since the bootstrap; its next
				 * change would then remove the edit again.
				 */
				let copy: Y.Doc | null = null;
				let before: Uint8Array | null = null;
				if ( empty ) {
					copy = createYjsDoc( { objectType } );
					Y.applyUpdateV2( copy, Y.encodeStateAsUpdateV2( ydoc ) );
					before = Y.encodeStateVector( copy );
					const target = copy;
					// Without the selection: the merge would schedule a
					// delayed cursor write on a copy that is about to go.
					const { selection: _selection, ...changes } =
						entry.changes as LocalChanges & { selection?: unknown };
					target.transact( () =>
						syncConfig.applyChangesToCRDTDoc(
							target,
							changes as LocalChanges
						)
					);
				} else if ( Array.isArray( held ) && saved ) {
					// The newest server row that shows the saved post.
					const scratch = createYjsDoc( { objectType } );
					let matched: Uint8Array | null = null;
					for ( const update of updates ) {
						Y.applyUpdateV2( scratch, update );
						if (
							showsSavedPost( saved, documentBlocks( scratch ) )
						) {
							matched = Y.encodeStateAsUpdateV2( scratch );
						}
					}
					scratch.destroy();
					copy = createYjsDoc( { objectType } );
					Y.applyUpdateV2(
						copy,
						matched ?? Y.encodeStateAsUpdateV2( ydoc )
					);
					before = Y.encodeStateVector( copy );
					const target = copy;
					const edited = matched
						? rebaseHeldTree(
								saved,
								held as EditorBlock[],
								documentBlocks( target )
						  )
						: null;
					target.transact( () => {
						if ( edited ) {
							syncConfig.applyChangesToCRDTDoc( target, {
								blocks: edited,
							} as LocalChanges );
						} else if ( ! matched ) {
							applyTypedText( target, held as EditorBlock[] );
						}
					} );
				}
				if ( copy && before ) {
					const diff = Y.encodeStateAsUpdateV2( copy, before );
					copy.destroy();
					Y.applyUpdateV2( ydoc, diff, entry.origin );
				}
				if ( entry.isSave ) {
					ydoc.transact(
						() => markEntityAsSaved( ydoc ),
						entry.origin
					);
				}
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
					const entry = lastTreeEntry;
					setTimeout( () => replayHeldTree( entry ), 0 );
				} else {
					ydoc.off( 'updateV2', recordServerUpdate );
					serverUpdates.length = 0;
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
 * The block key of core-data's save-markup mirror (`CRDT_BLOCK_SAVE_KEY` in
 * the framework's crdt-blocks, which the editor runtime does not export).
 */
const BLOCK_SAVE_KEY = '_save';

/**
 * A document's blocks as editor blocks, without the save-markup mirror
 * (doc-side bookkeeping the block merge leaves out of its comparison).
 *
 * @param doc A document.
 */
function documentBlocks( doc: Y.Doc ): EditorBlock[] {
	const blocks = doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' );
	if ( ! ( blocks instanceof Y.Array ) ) {
		return [];
	}
	const strip = ( list: EditorBlock[] ): EditorBlock[] =>
		list.map( ( block ) => {
			const { [ BLOCK_SAVE_KEY ]: _save, ...rest } =
				block as EditorBlock & Record< string, unknown >;
			return {
				...rest,
				innerBlocks: strip( block.innerBlocks ?? [] ),
			} as EditorBlock;
		} );
	return strip( blocks.toJSON() as EditorBlock[] );
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
