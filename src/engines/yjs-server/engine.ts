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
 * The CRDT document schema (and undo) live in the shared `engines/yjs/`
 * module, inherited from the retired yjs-relay engine — the wire documents
 * interoperate byte-for-byte with that lineage.
 */
import {
	CRDT_RECORD_MAP_KEY,
	CRDT_STATE_MAP_KEY,
	CRDT_STATE_MAP_SAVED_AT_KEY as SAVED_AT_KEY,
	CRDT_STATE_MAP_VERSION_KEY as VERSION_KEY,
} from '../yjs/constants';
import { createYjsDoc, markEntityAsSaved, serializeCrdtDoc } from '../yjs/doc';
import { docContainsSnapshot, encodeDocSnapshot } from '../yjs/snapshot';
import { createUndoManager } from '../yjs/undo';
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
 *   server writes for this engine, is the bootstrap marker).
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
			let pendingLocalChanges: Array< {
				changes: Parameters<
					typeof syncConfig.applyChangesToCRDTDoc
				>[ 1 ];
				origin: unknown;
				isSave: boolean;
			} > = [];

			const applyChanges = (
				changes: Parameters<
					typeof syncConfig.applyChangesToCRDTDoc
				>[ 1 ],
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
				for ( const entry of pending ) {
					applyChanges( entry.changes, entry.origin, entry.isSave );
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

				hydrate() {
					// Deliberately empty: the server's genesis snapshot is
					// the document's origin. Seeding from the loaded record
					// here would fork a duplicate universe of the same
					// content; persisted client-side docs are likewise
					// ignored in favor of the server's canonical state.
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
