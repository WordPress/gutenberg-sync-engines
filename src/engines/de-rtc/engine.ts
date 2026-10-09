/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type {
	EngineCollection,
	EngineEntity,
	SyncEngine,
	SyncReviewSource,
} from '@wordpress/sync';

/**
 * Internal dependencies
 *
 * The entity keeps a plain record that mirrors the editor (record.ts), not
 * a Y.Doc: the sync substrate is de-rtc's proposal wire, and the server's
 * canonical document is a serialized-block string, never a CRDT.
 */
import {
	createDeRtcRecord,
	editorChangesFromRecord,
	recordChangesFromEditor,
	sameBlocks,
} from './record';
import { createDeRtcAuthorship, type DeRtcBlockAuthorship } from './authorship';
import {
	createDeRtcRevertUndoManager,
	createDeRtcUndoFeed,
	type DeRtcRevertUndoManager,
} from './revert-undo';
import { createDeRtcCommitAdapter } from './commit';
import { registerSaveBaseVersion } from './save-base-version';
import {
	applyServerAwarenessStates,
	createAwarenessDoc,
} from '../../shared/awareness-sync';
import { registerAwareness } from '../../awareness/registry';
import {
	createDeRtcDocBridge,
	DE_RTC_REMOTE_ORIGIN,
	DE_RTC_RESTORE_ORIGIN,
	parseCanonicalBlocks,
	replaceBlockBySyncId,
	stabilizeClientIds,
	syncIdOf,
	unflattenProperties,
	type DeRtcContestKey,
} from './doc-bridge';
import {
	createDeRtcReviewState,
	type DeRtcParkedProposal,
	type DeRtcReviewState,
} from './review';
import {
	createDeRtcSessionCodec,
	DE_RTC_ENGINE_PROTOCOL,
	DE_RTC_ENGINE_SLUG,
	DE_RTC_SNAPSHOT_TYPE,
} from './session';

/**
 * The de-rtc engine's server reasons, normalized to the framework review
 * vocabulary the panel understands: `requires-approval` gates restore on
 * the reviewer's unfiltered_html capability (restore IS the approval),
 * and `frame-conflict` carries the "conflicted with a collaborator's
 * change" label. Raw reasons stay on the wire; only review items map.
 */
const REVIEW_REASON_MAP: Record< string, string > = {
	'requires-unfiltered-html': 'requires-approval',
	'manual-conflict-required': 'frame-conflict',
	'property-conflict': 'frame-conflict',
};

/**
 * An awareness-only codec for de-rtc collection rooms: presence flows,
 * rows are ignored, nothing is ever proposed.
 *
 * @param clientId  The collection's transport client id.
 * @param awareness Optional awareness instance.
 * @return The transport-facing session codec.
 */
function createInertDeRtcCollectionCodec(
	clientId: number,
	awareness?: import('y-protocols/awareness').Awareness
): ReturnType< typeof createDeRtcSessionCodec > {
	const noopUpdate = () => ( {
		data: JSON.stringify( { inert: true } ),
		type: DE_RTC_SNAPSHOT_TYPE,
	} );
	return {
		applyRemoteAwareness( state ) {
			if ( awareness ) {
				applyServerAwarenessStates(
					state,
					awareness,
					DE_RTC_REMOTE_ORIGIN
				);
			}
		},
		/*
		 * Exempt from the transport's solo hold: commits ride the autosave
		 * lane and the undo stack is the session's own accepted rows, so
		 * the advisory rows this codec queues (fetches, review decisions)
		 * must flow while alone too.
		 */
		sendsWhileAlone: true,
		clientId,
		engineSlug: DE_RTC_ENGINE_SLUG,
		engineProtocol: DE_RTC_ENGINE_PROTOCOL,
		// Never sent: this codec has no local updates whose outcome could
		// need recovery (and the optional compaction members are omitted —
		// the server compacts by itself).
		createRecoveryUpdate: noopUpdate,
		destroy() {},
		getInitialUpdates: () => [],
		getLocalAwareness: () => awareness?.getLocalState() ?? {},
		onLocalUpdate() {},
		receiveUpdate() {},
		// Collections never commit; nothing to settle or hold.
		prepareForSave: async () => () => {},
	};
}

/**
 * The DE-RTC engine, client half.
 *
 * Distributed Editing's client obligations are deliberately small: it
 * never merges. The editor's edits land in the local record; the session
 * codec proposes the record's content against the version it last
 * incorporated; the SERVER three-way-merges every proposal and announces
 * each new version; the canonical content this entity folds back into
 * the record (and so into the editor) arrives as fetched snapshots. Like the
 * yjs-server engine:
 *
 * - `hydrate` is a no-op: the server's genesis snapshot row is the
 *   document's origin (seeding from the loaded record would fork a
 *   duplicate universe).
 * - Local changes made before that snapshot arrives are BUFFERED and
 *   replayed once it does.
 * - `getEditorChanges` reports nothing until bootstrap, so an empty
 *   pre-sync document can never be dispatched into the editor as a
 *   mass deletion.
 * - No CRDT snapshots or persisted CRDT document: the server holds the
 *   canonical content, so `encodeSnapshot`/`serialize` return '' (the
 *   save adds nothing) and `containsSnapshot` returns false (the editor
 *   fails open on autosave checks) — the intent-log precedent.
 * - No shared carets: core-data places collaborators' carets with Yjs
 *   relative positions, which a stub awareness doc cannot resolve.
 *
 * Undo is DE-RTC's revert-edit model (see revert-undo.ts): undo never
 * undoes — it derives a revert from the client's own accepted canonical
 * rows and applies it as an ordinary dirty edit, so the revert travels
 * as an ordinary proposal in the shared history.
 *
 * Conflict review: a proposal the server escalates parks as a durable
 * `parked` row; the entity's review registry presents it
 * through the framework's review surface (panel, notices) via the
 * engine's `review` source (createSyncManager drives the handlers and
 * the resolution verbs from it), and a reviewer restores (overlaying
 * the parked blocks as an ordinary local edit under their own
 * capability, which re-proposes) or dismisses it.
 *
 * Entity properties (title, scalars, taxonomies, meta) ride the
 * proposal wire beside the content as a full flattened register map;
 * the server three-way-merges them per property and canonical rows
 * carry the merged map back (see the doc bridge's property surfaces).
 *
 * @return The de-rtc engine, carrying its review source.
 */
export function createDeRtcEngine(): SyncEngine & {
	review: SyncReviewSource;
	authorship: {
		getBlockAuthorship: (
			objectType: string,
			objectId: unknown
		) => Array< DeRtcBlockAuthorship | null >;
		/** By block identity, at any depth (empty without identity). */
		getBlockAuthorshipById: (
			objectType: string,
			objectId: unknown
		) => Record< string, DeRtcBlockAuthorship >;
	};
} {
	interface EntityReviewHandle {
		review: DeRtcReviewState;
		getItems: () => ReturnType< SyncReviewSource[ 'getOpenItems' ] >;
		restore: ( proposalId: string ) => void;
		/** Adopt a contested block's latest canonical form. */
		adoptContested: ( key: DeRtcContestKey ) => boolean;
		/** Reject a contest, keeping the local block. */
		rejectContested: ( key: DeRtcContestKey ) => boolean;
	}

	/**
	 * The contested-item id convention on the review surface: the
	 * prefix plus the contest key — the block's syncId, or its top-level
	 * index for documents without identity.
	 */
	const CONTESTED_PREFIX = 'contested-';
	const contestedKeyOf = ( proposalId: string ): DeRtcContestKey | null => {
		if ( ! proposalId.startsWith( CONTESTED_PREFIX ) ) {
			return null;
		}
		const key = proposalId.slice( CONTESTED_PREFIX.length );
		return /^\d+$/.test( key ) ? Number( key ) : key;
	};
	const entityReviews = new Map< string, EntityReviewHandle >();
	// Per-entity authorship trackers: block-grain "who last
	// touched this", derived from the canonical row feed.
	const entityAuthorship = new Map<
		string,
		{
			byIndex: () => Array< DeRtcBlockAuthorship | null >;
			byId: () => Record< string, DeRtcBlockAuthorship >;
		}
	>();
	const reviewKey = ( objectType: string, objectId: unknown ) =>
		`${ objectType }:${ String( objectId ) }`;

	/*
	 * Review-source subscriptions are keyed at the ENGINE level, not the
	 * entity: the framework manager subscribes while the entity is still
	 * being created (createSyncManager wires the review source BEFORE it
	 * asks the engine for the entity), so a subscription must be valid
	 * before — and survive across — the entity's lifetime. Each entity's
	 * ledger notifies its key's listeners.
	 */
	const keyListeners = new Map< string, Set< () => void > >();
	const notifyKey = ( key: string ) =>
		keyListeners.get( key )?.forEach( ( listener ) => listener() );

	const reviewSource: SyncReviewSource = {
		getOpenItems: ( objectType, objectId ) =>
			entityReviews
				.get( reviewKey( objectType, objectId ) )
				?.getItems() ?? [],
		subscribe: ( objectType, objectId, listener ) => {
			const key = reviewKey( objectType, objectId );
			if ( ! keyListeners.has( key ) ) {
				keyListeners.set( key, new Set() );
			}
			keyListeners.get( key )!.add( listener );
			return () => keyListeners.get( key )?.delete( listener );
		},
		resolveProposal: ( objectType, objectId, proposalId, resolution ) => {
			const handle = entityReviews.get(
				reviewKey( objectType, objectId )
			);
			const contestKey = contestedKeyOf( proposalId );
			if ( null !== contestKey ) {
				// Any resolution of a contested item that is not an
				// adoption is a REJECT: keep the local block.
				handle?.rejectContested( contestKey );
				return;
			}
			handle?.review.resolve( proposalId, resolution );
		},
		restoreProposal: ( objectType, objectId, proposalId ) => {
			const handle = entityReviews.get(
				reviewKey( objectType, objectId )
			);
			const contestKey = contestedKeyOf( proposalId );
			if ( null !== contestKey ) {
				// Restore of a contested item is the ADOPT verb.
				handle?.adoptContested( contestKey );
				return;
			}
			handle?.restore( proposalId );
		},
	};

	return {
		slug: DE_RTC_ENGINE_SLUG,
		protocolVersion: DE_RTC_ENGINE_PROTOCOL,
		// The revert-edit undo: undo never undoes, it applies
		// revert edits derived from the client's own accepted canonical
		// rows, proposed like any other change.
		createUndoManager: createDeRtcRevertUndoManager,
		review: reviewSource,
		authorship: {
			getBlockAuthorship: ( objectType, objectId ) =>
				entityAuthorship
					.get( reviewKey( objectType, objectId ) )
					?.byIndex() ?? [],
			getBlockAuthorshipById: ( objectType, objectId ) =>
				entityAuthorship
					.get( reviewKey( objectType, objectId ) )
					?.byId() ?? {},
		},
		createEntity( { syncConfig, objectType, objectId } ): EngineEntity {
			const record = createDeRtcRecord();
			// The typed Awareness only reads `clientID` (and a destroy
			// listener) from its doc argument, so a stub serves; carets
			// that need a real Y.Doc stay off (see the docblock).
			const awareness = syncConfig.createAwareness?.(
				createAwarenessDoc( record.clientId ) as never
			);
			registerAwareness( objectType, objectId, awareness );
			const bridge = createDeRtcDocBridge( record );
			const review = createDeRtcReviewState();
			// The REST review lane (B5): resolutions are mutations, so they
			// POST to the plugin's authenticated route — for EVERY entity
			// type; the transport's resolution-row lane is gone and the
			// server rejects client-sent resolved rows. The room string
			// mirrors the providers' convention.
			review.setRestResolver( ( proposalId, resolution ) =>
				apiFetch( {
					data: {
						client_id: record.clientId,
						proposalId,
						resolution,
						room: objectId
							? `${ objectType }:${ objectId }`
							: objectType,
					},
					method: 'POST',
					path: '/wp-sync/v1/de-rtc/resolve',
				} )
			);
			const undoFeed = createDeRtcUndoFeed();
			const authorship = createDeRtcAuthorship( undoFeed );
			// Save-through-the-room: this post's REST saves carry
			// base_version while the session lives. `prepareForSave` is
			// attached when the session comes up (the save settles +
			// holds the commit lane so it cannot self-conflict with the
			// session's own in-flight commit).
			const saveControl: import('./save-base-version').DeRtcSaveControl =
				{
					lastVersion: bridge.lastVersion,
				};
			const unregisterSaveBaseVersion = registerSaveBaseVersion(
				objectType,
				objectId,
				saveControl
			);
			entityAuthorship.set( reviewKey( objectType, objectId ), {
				byIndex: authorship.getBlockAuthorship,
				byId: authorship.getBlockAuthorshipById,
			} );

			// Editor edits made before the server snapshot arrives, replayed
			// in order once it does (after the genesis properties, so the
			// post's taxonomy fields are known when the edits are filtered).
			let pendingLocalChanges: Array< {
				changes: Record< string, unknown >;
				origin: unknown;
			} > = [];

			/*
			 * The block tree the editor lane last stored. The editor's
			 * trees are immutable, so while the record still holds this
			 * one a new tree is a change by definition. Once a canonical
			 * row has replaced it, the record holds the room's parsed
			 * blocks and the editor's next tree is compared by content:
			 * the trees the editor emits around a bootstrap (the id
			 * stamper's passes over the loaded post, the buffered copies
			 * replayed after genesis) say exactly what the room says, and
			 * storing them would mark the doc dirty and commit a version
			 * that changes nothing.
			 */
			let editorTree: unknown = null;

			// Editor edits: kept per the framework's field rules.
			const applyEditorChanges = (
				changes: Record< string, unknown >,
				origin: unknown
			) => {
				const next = recordChangesFromEditor(
					changes,
					record,
					objectType
				);
				if (
					Array.isArray( next.blocks ) &&
					record.blocks() !== editorTree &&
					sameBlocks( record.blocks(), next.blocks )
				) {
					delete next.blocks;
				}
				record.apply( next, origin );
				if ( Array.isArray( next.blocks ) ) {
					editorTree = next.blocks;
				}
			};

			// Restores and reverts: already record-shaped. Parsed blocks
			// keep the clientIds of the blocks they replace, so the canvas
			// does not remount them.
			const applyRestore = ( changes: Record< string, unknown > ) => {
				if ( Array.isArray( changes.blocks ) ) {
					stabilizeClientIds( changes.blocks, record.blocks() );
				}
				record.apply( changes, DE_RTC_RESTORE_ORIGIN );
			};

			bridge.onBootstrap( () => {
				const pending = pendingLocalChanges;
				pendingLocalChanges = [];
				for ( const entry of pending ) {
					applyEditorChanges( entry.changes, entry.origin );
				}
			} );

			const localBlocks = (): any[] => record.blocks();

			/**
			 * Overlays a parked proposal's changed blocks into the doc as an
			 * ordinary local edit under the restorer's capability: a changed
			 * block replaces the local block at its recorded index when the
			 * block name still matches, and appends at the end otherwise
			 * (the intent-log restore's degraded-anchor rule). The restore
			 * origin reaches the editor like a remote change AND marks the
			 * doc dirty so the restored state re-proposes.
			 *
			 * @param parked The parked proposal.
			 */
			const overlayParkedBlocks = ( parked: DeRtcParkedProposal ) => {
				// A parked PROPERTY register restores by re-applying the
				// losing value as a local edit — the next proposal carries
				// it and wins the three-way merge (canonical now agrees
				// with the base for that property).
				if ( parked.property?.name ) {
					applyRestore(
						unflattenProperties( {
							[ parked.property.name ]: parked.property.value,
						} )
					);
					return;
				}
				const next = localBlocks().slice();
				for ( const changed of parked.changedBlocks ?? [] ) {
					const parsed = parseCanonicalBlocks(
						String( changed?.html ?? '' )
					);
					parsed.forEach( ( block, offset ) => {
						// By identity first: the parked block replaces the
						// block carrying its syncId wherever it sits (a
						// nested leaf restores into its container). Then
						// by recorded index; a block with no place appends.
						const syncId =
							0 === offset && 'string' === typeof changed.syncId
								? changed.syncId
								: syncIdOf( block );
						if (
							syncId &&
							replaceBlockBySyncId( next, syncId, block )
						) {
							return;
						}
						const index = Number( changed.index ) + offset;
						if (
							next[ index ] &&
							next[ index ].name === block.name
						) {
							next[ index ] = block;
						} else {
							next.push( block );
						}
					} );
				}
				applyRestore( { blocks: next } );
			};

			const key = reviewKey( objectType, objectId );
			review.onChange( () => notifyKey( key ) );

			/*
			 * Contested-block pending items: one item per block,
			 * refreshed in place by the bridge's merge-not-stack contest
			 * events. Presented through the same review surface as parked
			 * conflicts; the verbs route by the `contested-` id prefix
			 * (Adopt = restore, Reject = dismiss).
			 */
			const contested = new Map<
				DeRtcContestKey,
				{ version: string; html: string; edits: number; index: number }
			>();
			bridge.onContested( ( event ) => {
				const existing = contested.get( event.key );
				contested.set( event.key, {
					version: event.version,
					html: event.html,
					edits: ( existing?.edits ?? 0 ) + 1,
					index: event.index,
				} );
				notifyKey( key );
			} );
			bridge.onContestResolved( ( contestKey ) => {
				if ( contested.delete( contestKey ) ) {
					notifyKey( key );
				}
			} );
			const contestedExcerpt = ( item: {
				html: string;
				edits: number;
			} ): string => {
				const text = item.html
					.replace( /<[^>]*>/g, ' ' )
					.replace( /\s+/g, ' ' )
					.trim()
					.slice( 0, 80 );
				return 1 < item.edits
					? `${ text } (${ item.edits } edits)`
					: text;
			};

			entityReviews.set( key, {
				review,
				adoptContested: ( contestKey ) =>
					bridge.adoptContestedBlock( contestKey ),
				rejectContested: ( contestKey ) =>
					bridge.rejectContestedBlock( contestKey ),
				getItems: () => [
					...review.getOpen().map( ( parked ) => ( {
						id: parked.proposalId,
						unitId: parked.proposalId,
						isLocal: parked.authorClientId === record.clientId,
						actorId: `u${ parked.author ?? 0 }c${
							parked.authorClientId
						}`,
						reason:
							REVIEW_REASON_MAP[ parked.reason ] ?? parked.reason,
						intentType: 'proposal',
						summary:
							( parked.excerpt || undefined ) &&
							( parked.revisions ?? 1 ) > 1
								? `${ parked.excerpt } (${ parked.revisions } revisions)`
								: parked.excerpt || undefined,
						// The first changed block anchors the inline card:
						// by identity (a nested block anchors to itself),
						// with its top-level index as the fallback.
						...( 'string' ===
						typeof parked.changedBlocks?.[ 0 ]?.syncId
							? { targetId: parked.changedBlocks[ 0 ].syncId }
							: {} ),
						targetIndex: parked.changedBlocks?.[ 0 ]?.index,
					} ) ),
					...Array.from( contested.entries() ).map(
						( [ contestKey, item ] ) => ( {
							id: `contested-${ contestKey }`,
							unitId: `contested-${ contestKey }`,
							isLocal: false,
							actorId: '',
							reason: 'frame-conflict',
							intentType: 'proposal',
							summary: contestedExcerpt( item ),
							...( 'string' === typeof contestKey
								? { targetId: contestKey }
								: {} ),
							targetIndex: item.index,
						} )
					),
				],
				restore: ( proposalId ) => {
					const parked = review
						.getOpen()
						.find(
							( candidate ) => candidate.proposalId === proposalId
						);
					if ( ! parked ) {
						return;
					}
					if ( bridge.isBootstrapped() ) {
						overlayParkedBlocks( parked );
					}
					review.resolve( proposalId, 'restored' );
				},
			} );

			let unsubscribeObservers: ( () => void ) | null = null;

			return {
				awareness,

				createSession: () => {
					const codec = createDeRtcSessionCodec( {
						awareness,
						bridge,
						review,
						undoFeed,
						// The Save/Sync inversion, stage 2:
						// commits ride the autosave endpoint; the
						// transport stays advisory. Null for types
						// without a commit route (transport fallback).
						commit:
							createDeRtcCommitAdapter(
								objectType,
								objectId,
								record.clientId
							) ?? undefined,
					} );
					saveControl.prepareForSave = codec.prepareForSave;
					return codec;
				},

				hydrate() {
					// Deliberately empty: the server's genesis snapshot is
					// the document's origin (see the engine docblock).
				},

				applyLocalChanges( changes, origin ) {
					if ( ! bridge.isBootstrapped() ) {
						pendingLocalChanges.push( { changes, origin } );
						return;
					}
					applyEditorChanges( changes, origin );
				},

				getEditorChanges: ( editedRecord ) =>
					bridge.isBootstrapped()
						? editorChangesFromRecord(
								record,
								editedRecord,
								objectType
						  )
						: {},

				// No CRDT snapshot or persisted CRDT document (see the
				// engine docblock): empty values add nothing to saves.
				encodeSnapshot: () => '',

				containsSnapshot: () => false,

				serialize: () => '',

				observe( observers ) {
					unsubscribeObservers?.();
					unsubscribeObservers = record.subscribe( ( origin ) => {
						// Canonical applications (remote origin), undo
						// reverts, and proposal restores (restore origin)
						// must reach the editor; the editor's own edits
						// must not echo back into it.
						if (
							DE_RTC_REMOTE_ORIGIN === origin ||
							DE_RTC_RESTORE_ORIGIN === origin
						) {
							observers.onRemoteChange();
						}
					} );
				},

				addToUndoScope( undoManager, meta ) {
					// The revert-edit manager needs the entity context —
					// bridge (current content), row feed, and the apply
					// lane — before the meta handlers scope in. The restore
					// origin both reaches the editor like a remote change
					// and marks the doc dirty, so a revert re-proposes.
					const revertUndo =
						undoManager as unknown as DeRtcRevertUndoManager;
					revertUndo.attachEntity?.( {
						key: record,
						bridge,
						feed: undoFeed,
						applyRevert: ( blocks ) => applyRestore( { blocks } ),
					} );
					revertUndo.addToScope( record, meta );
				},

				destroy() {
					unsubscribeObservers?.();
					unsubscribeObservers = null;
					if ( entityReviews.get( key )?.review === review ) {
						entityReviews.delete( key );
					}
					review.setRestResolver( null );
					unregisterSaveBaseVersion();
				},
			};
		},

		createCollection( { syncConfig } ): EngineCollection {
			// Collections are INERT under de-rtc (the intent-log precedent):
			// proposals are serialized post content, which collection rooms
			// do not have. Awareness still flows so presence works; the
			// server's collection rooms simply hold an empty canonical whose
			// rows this codec ignores.
			const record = createDeRtcRecord();
			const awareness = syncConfig.createAwareness?.(
				createAwarenessDoc( record.clientId ) as never
			);

			return {
				awareness,

				createSession: () =>
					createInertDeRtcCollectionCodec(
						record.clientId,
						awareness
					),

				initialize: () => {},

				observe() {},

				markSaved() {},

				destroy() {},
			};
		},
	};
}
