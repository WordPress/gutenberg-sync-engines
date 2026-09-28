/**
 * Internal dependencies
 */
import { getBlock, locateBlock } from './intent-log/document.js';
import { mintSyncId } from './intent-log/sync-id.js';
import type {
	EngineBlock,
	EngineDocument,
	IntentEnvelope,
} from './intent-log/engine-types';
import type { IntentLogSession } from './intent-log-session';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncUndoManager, SyncUndoStackState } from '@wordpress/sync';

/*
 * Collaborative undo for the intent log: INVERSE INTENTS.
 *
 * Design (see also SPEC.md "removedText/inversion payloads"):
 *
 * - The undo stack tracks UNITS — the intent batches the manager authors
 *   from one capture (a typing burst coalesced by CAPTURE_SYNC_DELAY) or
 *   one property push. Tracking is purely client-side (no txnId stamping,
 *   so server unit-escalation semantics are untouched).
 * - A unit becomes undoable once SETTLED: every member acked, and every
 *   accepted member's authoritative (transformed) row absorbed into the
 *   replica's log with its landing seq. Inverses derive from ACCEPTED
 *   rows and documents at their seqs — never from outbox originals, whose
 *   offsets and removedText the transforms do not update.
 * - undo() derives each accepted member's inverse against the document
 *   BEFORE that row (session.getDocumentAt) and authors it, members in
 *   reverse log order, each based at the frame right after ITS row
 *   (`observe: false` — the editor's observed frame is not disturbed).
 *   Correctness of those base frames: the planner transforms each
 *   inverse over the PEER rows after its member (escalating genuine
 *   conflicts into the review lane — parked, never lost), while own
 *   rows above it are either later members of the same unit — canceled
 *   by the inverses authored just before it in the same flush — or
 *   canceling undo/redo pairs above the popped unit; the same-actor
 *   transform skip is exactly right for both.
 * - redo() is the same machinery over the inverse unit. New local edits
 *   clear the redo stack.
 * - Retention: the session's undo pin keeps the replica's log sliceable
 *   from the oldest tracked row so derivation stays possible; a horizon
 *   reset (server compaction beyond our cursor) clears both stacks.
 *
 * The manager exposes this object as `SyncManager.undoManager`, which
 * routes core-data's undo/redo/hasUndo/hasRedo through it (the store's
 * default undo manager is bypassed). `undo()`/`redo()` return an empty
 * array — the same contract as the Yjs undo manager: content changes
 * flow back through the normal remote-change pipeline, not the record.
 */

interface UndoUnitMember {
	intentId: string;
	status?: 'applied' | 'escalated' | 'voided';
	seq?: number;
	entry?: IntentEnvelope;
}

interface UndoUnit {
	session: IntentLogSession;
	members: UndoUnitMember[];
	/** Timestamp of the last batch merged into this unit (capture chain). */
	lastAuthoredAt: number;
	/** Set by stopCapturing(): the next batch starts a fresh unit. */
	closed?: boolean;
}

/** Maximum retained undo units (matches typical editor stacks). */
const MAX_UNITS = 20;

/**
 * Consecutive authored batches closer together than this merge into ONE
 * undo unit. The intent-log capture lane authors per editor update — a
 * keystroke each — so without coalescing, undo would revert one character
 * at a time. Same role (and default) as the Yjs undo manager's
 * captureTimeout.
 */
const DEFAULT_CAPTURE_TIMEOUT = 500;

export interface IntentLogUndoManager extends SyncUndoManager {
	/** Wires a session's row/ack/reset streams into the stack. */
	attachSession: ( session: IntentLogSession ) => void;

	/**
	 * Records a user-authored batch (a capture or property push) as one
	 * undo unit. Clears the redo stack — a new edit forks history.
	 */
	noteAuthored: (
		session: IntentLogSession,
		envelopes: IntentEnvelope[]
	) => void;

	/** Drops all state (manager unloadAll). */
	reset: () => void;
}

/**
 * Derives the inverse of an ACCEPTED intent against the document state the
 * row applied to.
 *
 * Exact inverses where the row plus that document determine one; best
 * effort for merge_blocks (the absorbed block's other fields were dropped
 * by the merge) and format_text (spans are unnormalized); null where no
 * sensible inverse exists (the member is skipped).
 *
 * @param entry      The accepted (transformed) intent row.
 * @param docBefore  Document at the row's landing seq (before it applied).
 * @param currentDoc The session's current optimistic document (register
 *                   versions for map/entity writes are read at authoring
 *                   time, the restore-proposal precedent).
 * @return The inverse intent, or null.
 */
export function deriveInverse(
	entry: IntentEnvelope,
	docBefore: EngineDocument,
	currentDoc: EngineDocument | null
): { type: string; payload: Record< string, unknown > } | null {
	const payload = entry.payload as Record< string, any >;
	const blockBefore = ( id: string ): EngineBlock | null =>
		getBlock( docBefore, id );
	const textBefore = ( id: string, field: string ): string =>
		( blockBefore( id )?.fields?.[ field ]?.text as string ) ?? '';
	const attrVersionNow = ( id: string, key: string ): number => {
		const current = currentDoc
			? ( getBlock( currentDoc, id ) as EngineBlock | null )
			: null;
		if ( current ) {
			return ( current.attrVersions?.[ key ] as number ) ?? 0;
		}
		return (
			( ( blockBefore( id )?.attrVersions?.[ key ] as number ) ?? 0 ) + 1
		);
	};
	const propVersionNow = ( name: string ): number =>
		( currentDoc?.propVersions?.[ name ] as number ) ??
		( ( docBefore.propVersions?.[ name ] as number ) ?? 0 ) + 1;
	/**
	 * Deep-copies a document block into an insert_block spec.
	 * @param block
	 */
	const toSpec = ( block: EngineBlock ): Record< string, unknown > => ( {
		syncId: block.syncId,
		blockType: block.blockType,
		attrs: { ...( block.attrs ?? {} ) },
		attrVersions: { ...( block.attrVersions ?? {} ) },
		fields: Object.fromEntries(
			Object.entries( block.fields ?? {} ).map( ( [ name, field ] ) => [
				name,
				{
					text: field.text,
					formats: ( field.formats ?? [] ).map( ( span ) => ( {
						...span,
					} ) ),
				},
			] )
		),
		children: ( block.children ?? [] ).map( toSpec ),
	} );

	switch ( entry.type ) {
		case 'insert_text':
			return {
				type: 'delete_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					start: payload.offset,
					end: payload.offset + payload.text.length,
					removedText: payload.text,
				},
			};

		case 'delete_text':
			return {
				type: 'insert_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					offset: payload.start,
					// The doc-derived text, NOT the carried removedText —
					// transforms do not update the carried copy.
					text: textBefore( payload.syncId, payload.field ).slice(
						payload.start,
						payload.end
					),
				},
			};

		case 'replace_text': {
			const prior = textBefore( payload.syncId, payload.field ).slice(
				payload.start,
				payload.end
			);
			return {
				type: 'replace_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					start: payload.start,
					end: payload.start + payload.text.length,
					removedText: payload.text,
					text: prior,
				},
			};
		}

		case 'format_text':
			// Approximate: spans are unnormalized, so toggling off need not
			// restore pre-existing overlapping spans exactly.
			return {
				type: 'format_text',
				payload: { ...payload, on: ! payload.on },
			};

		case 'set_attr': {
			const block = blockBefore( payload.syncId );
			if ( ! block ) {
				return null;
			}
			const hadKey =
				undefined !== ( block.attrs ?? {} )[ payload.key as string ];
			if ( ! hadKey ) {
				return {
					type: 'remove_attr',
					payload: {
						syncId: payload.syncId,
						key: payload.key,
						observedVersion: attrVersionNow(
							payload.syncId,
							payload.key
						),
					},
				};
			}
			return {
				type: 'set_attr',
				payload: {
					syncId: payload.syncId,
					key: payload.key,
					value: block.attrs[ payload.key as string ],
					observedVersion: attrVersionNow(
						payload.syncId,
						payload.key
					),
				},
			};
		}

		case 'remove_attr': {
			const block = blockBefore( payload.syncId );
			if (
				! block ||
				undefined === ( block.attrs ?? {} )[ payload.key as string ]
			) {
				return null;
			}
			return {
				type: 'set_attr',
				payload: {
					syncId: payload.syncId,
					key: payload.key,
					value: block.attrs[ payload.key as string ],
					observedVersion: attrVersionNow(
						payload.syncId,
						payload.key
					),
				},
			};
		}

		case 'set_property': {
			const prior = ( docBefore.props ?? {} )[ payload.name as string ];
			if ( undefined === prior ) {
				return null; // First write: nothing to restore it to.
			}
			return {
				type: 'set_property',
				payload: {
					name: payload.name,
					value: prior,
					observedVersion: propVersionNow( payload.name ),
				},
			};
		}

		case 'insert_block':
			return {
				type: 'remove_block',
				payload: { syncId: payload.block.syncId },
			};

		case 'remove_block': {
			const location = locateBlock( docBefore, payload.syncId );
			if ( ! location ) {
				return null;
			}
			// Original identities re-insert: every id in the removed subtree
			// left the document with the removal, so duplicate-id cannot
			// trip, and peers' anchors to those ids resurrect with it.
			return {
				type: 'insert_block',
				payload: {
					block: toSpec( location.block ),
					parentId: location.parentId,
					afterSiblingId:
						location.index > 0
							? location.siblings[ location.index - 1 ].syncId
							: null,
				},
			};
		}

		case 'move_block': {
			const location = locateBlock( docBefore, payload.syncId );
			if ( ! location ) {
				return null;
			}
			return {
				type: 'move_block',
				payload: {
					syncId: payload.syncId,
					newParentId: location.parentId,
					afterSiblingId:
						location.index > 0
							? location.siblings[ location.index - 1 ].syncId
							: null,
				},
			};
		}

		case 'split_block':
			return {
				type: 'merge_blocks',
				payload: {
					survivorId: payload.syncId,
					absorbedId: payload.newSyncId,
					field: payload.field,
					joinOffset: payload.offset,
				},
			};

		case 'merge_blocks': {
			const survivor = blockBefore( payload.survivorId );
			if ( ! survivor ) {
				return null;
			}
			// Best effort: re-split at the join point. The absorbed block's
			// OTHER fields were dropped by the merge (documented editor
			// semantics) and its id is tombstoned, so the tail comes back
			// under a fresh identity with the joined field only.
			return {
				type: 'split_block',
				payload: {
					syncId: payload.survivorId,
					field: payload.field,
					offset:
						survivor.fields?.[ payload.field as string ]?.text
							?.length ?? 0,
					newSyncId: mintSyncId(),
				},
			};
		}

		case 'transform_block': {
			const block = blockBefore( payload.syncId );
			if ( ! block ) {
				return null;
			}
			return {
				type: 'transform_block',
				payload: {
					syncId: payload.syncId,
					newBlockType: block.blockType,
				},
			};
		}

		case 'replace_attr_content': {
			const prior = textBefore( payload.syncId, payload.field );
			return {
				type: 'replace_attr_content',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					newText: prior,
					observedVersion: attrVersionNow(
						payload.syncId,
						`field:${ payload.field }`
					),
				},
			};
		}

		default:
			return null;
	}
}

/**
 * Creates the intent-log collaborative undo manager.
 *
 * @param options                Options.
 * @param options.onStackChange  Called with { hasUndo, hasRedo } on every
 *                               stack mutation (drives core-data's
 *                               syncUndoManagerState).
 * @param options.captureTimeout Batch-coalescing window in ms (see
 *                               DEFAULT_CAPTURE_TIMEOUT); 0 keeps every
 *                               batch its own unit (tests).
 * @return The undo manager.
 */
export function createIntentLogUndoManager(
	options: {
		onStackChange?: ( state: SyncUndoStackState ) => void;
		captureTimeout?: number;
	} = {}
): IntentLogUndoManager {
	const captureTimeout = options.captureTimeout ?? DEFAULT_CAPTURE_TIMEOUT;
	const undoStack: UndoUnit[] = [];
	const redoStack: UndoUnit[] = [];
	const byIntentId = new Map<
		string,
		{ unit: UndoUnit; member: UndoUnitMember }
	>();
	const attachedSessions = new Set< IntentLogSession >();

	const isSettled = ( unit: UndoUnit ): boolean =>
		unit.members.every(
			( member ) =>
				member.status && ( 'applied' !== member.status || member.entry )
		);

	/**
	 * Every member still unacked: the whole unit is cancelable — undo
	 * inside the settle window cancels the pending intents instead of
	 * being a silent no-op.
	 *
	 * @param unit The undo unit to test.
	 * @return Whether none of the unit's members have reached the server.
	 */
	const isFullyPending = ( unit: UndoUnit ): boolean =>
		unit.members.every(
			( member ) =>
				undefined === member.status && undefined === member.seq
		);

	/** Units canceled pre-settle, awaiting server confirmation. */
	const canceledUnits = new Set< UndoUnit >();

	const topUndoable = (): UndoUnit | null => {
		const top = undoStack.at( -1 );
		return top && ( isSettled( top ) || isFullyPending( top ) )
			? top
			: null;
	};
	const topRedoable = (): UndoUnit | null => {
		const top = redoStack.at( -1 );
		return top && isSettled( top ) ? top : null;
	};

	const stackState = (): SyncUndoStackState => ( {
		hasUndo: null !== topUndoable(),
		hasRedo: null !== topRedoable(),
	} );

	let lastNotified: SyncUndoStackState = { hasUndo: false, hasRedo: false };
	const notify = () => {
		const state = stackState();
		if (
			state.hasUndo !== lastNotified.hasUndo ||
			state.hasRedo !== lastNotified.hasRedo
		) {
			lastNotified = state;
			options.onStackChange?.( state );
		}
		recomputeRetention();
	};

	const dropUnit = ( unit: UndoUnit ) => {
		for ( const member of unit.members ) {
			byIntentId.delete( member.intentId );
		}
	};

	const recomputeRetention = () => {
		const pins = new Map< IntentLogSession, number >();
		for ( const unit of [ ...undoStack, ...redoStack ] ) {
			for ( const member of unit.members ) {
				if ( undefined === member.seq ) {
					continue;
				}
				const current = pins.get( unit.session );
				if ( undefined === current || member.seq < current ) {
					pins.set( unit.session, member.seq );
				}
			}
		}
		for ( const session of attachedSessions ) {
			session.setUndoRetainSeq( pins.get( session ) ?? null );
		}
	};

	const trackUnit = ( unit: UndoUnit, stack: UndoUnit[] ) => {
		stack.push( unit );
		for ( const member of unit.members ) {
			byIntentId.set( member.intentId, { unit, member } );
		}
		while ( undoStack.length > MAX_UNITS ) {
			dropUnit( undoStack.shift()! );
		}
		notify();
	};

	/**
	 * Pops a settled unit and authors the inverse batch of its accepted
	 * members; the resulting unit lands on the opposite stack.
	 *
	 * @param from Stack to pop.
	 * @param to   Stack the inverse unit lands on.
	 * @return Whether a step ran.
	 */
	const step = ( from: UndoUnit[], to: UndoUnit[] ): boolean => {
		const unit = from.at( -1 );
		if ( ! unit ) {
			return false;
		}
		if ( ! isSettled( unit ) ) {
			/*
			 * Pre-settle undo: a unit whose members are ALL still
			 * unacked cancels in place — the intents leave the outbox (a
			 * cancel row chases any copies already queued on the wire), the
			 * optimistic document replans, and the canvas reverts. No
			 * inverse is authored; nothing accepted exists to invert.
			 * Members stay registered so a too-late ack (the cancel lost
			 * the race) resurrects the unit as a normal settled candidate.
			 * Undo direction only: redo units are settled inverses.
			 */
			if (
				from === undoStack &&
				isFullyPending( unit ) &&
				unit.session.cancelPendingIntents(
					unit.members.map( ( member ) => member.intentId )
				)
			) {
				from.pop();
				canceledUnits.add( unit );
				notify();
				return true;
			}
			return false;
		}
		from.pop();
		dropUnit( unit );

		const accepted = unit.members
			.filter(
				( member ) =>
					'applied' === member.status &&
					member.entry &&
					undefined !== member.seq
			)
			.sort( ( a, b ) => b.seq! - a.seq! );
		if ( 0 === accepted.length ) {
			notify();
			// Nothing applied (all escalated/voided): walk further back.
			return step( from, to );
		}

		const session = unit.session;
		const currentDoc = session.getDocument();
		const envelopes: IntentEnvelope[] = [];
		for ( const member of accepted ) {
			const docBefore = session.getDocumentAt( member.seq! );
			if ( ! docBefore ) {
				continue; // Below the retained floor: not derivable.
			}
			const inverse = deriveInverse(
				member.entry!,
				docBefore,
				currentDoc
			);
			if ( ! inverse ) {
				continue;
			}
			// Each inverse authors at ITS member's frame: a merged unit's
			// rows need not be contiguous (peer rows can interleave between
			// a burst's per-keystroke batches), and only the per-member
			// frame lets the planner transform over exactly the peer rows
			// after that member.
			envelopes.push(
				...session.authorBatch( [ inverse ], {
					baseSeq: member.seq! + 1,
					observe: false,
				} )
			);
		}
		if ( 0 === envelopes.length ) {
			notify();
			return true; // The step consumed the unit; nothing to author.
		}

		trackUnit(
			{
				session,
				members: envelopes.map( ( envelope ) => ( {
					intentId: envelope.intentId,
				} ) ),
				lastAuthoredAt: Date.now(),
				closed: true,
			},
			to
		);
		notify();
		return true;
	};

	return {
		attachSession( session ) {
			if ( attachedSessions.has( session ) ) {
				return;
			}
			attachedSessions.add( session );
			session.onAcceptedRows( ( rows ) => {
				let changed = false;
				for ( const { seq, entry } of rows ) {
					const tracked = byIntentId.get( entry.intentId );
					if ( ! tracked ) {
						continue;
					}
					tracked.member.status = 'applied';
					tracked.member.seq = seq;
					tracked.member.entry = entry;
					changed = true;
				}
				if ( changed ) {
					notify();
				}
			} );
			session.onDisposition( ( settled ) => {
				const tracked = byIntentId.get( settled.intentId );
				if ( ! tracked ) {
					return;
				}
				if ( 'escalated' === settled.status ) {
					tracked.member.status = 'escalated';
				} else if ( 'voided' === settled.status ) {
					tracked.member.status = 'voided';
				} else if ( ! tracked.member.status ) {
					tracked.member.status = 'applied';
				}
				if ( canceledUnits.has( tracked.unit ) ) {
					if (
						'voided' === settled.status &&
						'canceled' === ( settled as any ).reason
					) {
						// The server confirmed the cancellation; once every
						// member is confirmed the unit is gone for good.
						if (
							tracked.unit.members.every(
								( member ) => 'voided' === member.status
							)
						) {
							canceledUnits.delete( tracked.unit );
							dropUnit( tracked.unit );
						}
					} else {
						// The cancel lost the race to the wire: the intent
						// was ingested and its effect will resurrect on the
						// canvas via the accepted row. Restore the unit so
						// a second undo inverts it once settled.
						canceledUnits.delete( tracked.unit );
						undoStack.push( tracked.unit );
					}
				}
				notify();
			} );
			session.onReset( () => {
				// The server compacted history this replica never observed:
				// documents below the checkpoint are gone, so nothing older
				// remains derivable.
				undoStack.splice( 0 );
				redoStack.splice( 0 );
				byIntentId.clear();
				notify();
			} );
		},

		noteAuthored( session, envelopes ) {
			if ( 0 === envelopes.length ) {
				return;
			}
			// A new edit forks history: redo becomes unreachable.
			while ( redoStack.length ) {
				dropUnit( redoStack.pop()! );
			}
			const now = Date.now();
			const top = undoStack.at( -1 );
			if (
				top &&
				top.session === session &&
				! top.closed &&
				captureTimeout > 0 &&
				now - top.lastAuthoredAt <= captureTimeout
			) {
				// Continue the capture chain: a typing burst's per-keystroke
				// batches form ONE undo unit.
				top.lastAuthoredAt = now;
				for ( const envelope of envelopes ) {
					const member: UndoUnitMember = {
						intentId: envelope.intentId,
					};
					top.members.push( member );
					byIntentId.set( envelope.intentId, { unit: top, member } );
				}
				notify();
				return;
			}
			trackUnit(
				{
					session,
					members: envelopes.map( ( envelope ) => ( {
						intentId: envelope.intentId,
					} ) ),
					lastAuthoredAt: now,
				},
				undoStack
			);
		},

		reset() {
			undoStack.splice( 0 );
			redoStack.splice( 0 );
			byIntentId.clear();
			for ( const session of attachedSessions ) {
				session.setUndoRetainSeq( null );
			}
			attachedSessions.clear();
			lastNotified = { hasUndo: false, hasRedo: false };
		},

		undo() {
			step( undoStack, redoStack );
			// The Yjs undo manager's contract: content flows back through
			// the normal remote-change pipeline, not the returned record.
			return [];
		},

		redo() {
			step( redoStack, undoStack );
			return [];
		},

		hasUndo: () => null !== topUndoable(),
		hasRedo: () => null !== topRedoable(),

		// The WPUndoManager surface the framework never routes to an
		// engine undo manager (records flow through the engine).
		addRecord() {},

		// Ends the current capture chain: the next authored batch starts a
		// fresh undo unit (wired from SyncManagerUpdateOptions'
		// isNewUndoLevel, the same signal the framework manager forwards).
		stopCapturing() {
			const top = undoStack.at( -1 );
			if ( top ) {
				top.closed = true;
			}
		},

		// Y-typed scope registration is the framework createSyncManager
		// path, which the bespoke intent-log manager bypasses.
		addToScope() {},
	};
}
