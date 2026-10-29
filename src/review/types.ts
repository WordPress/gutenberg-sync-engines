/**
 * The engine-neutral conflict contract: what a sync engine publishes for
 * every edit it set aside for a person to decide, and how the reviewer's
 * decision goes back. The long note at the end of this file is the
 * contract's rationale. The registry that collects every engine's source
 * is src/review/conflicts.ts.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { ObjectID, ObjectType } from '@wordpress/sync';

/**
 * One parked edit, described for review.
 */
export interface SyncConflict {
	/** The engine's id for the parked edit. */
	id: string;
	/**
	 * Why a person has to decide.
	 *
	 * - `merge`: the engine could not combine the edit with a
	 *   collaborator's.
	 * - `sequestration`: the markup needs approval from someone allowed
	 *   to publish unfiltered HTML.
	 */
	kind: 'merge' | 'sequestration';
	/** The WordPress user id of whoever authored the proposed side. */
	authorId: number;
	/** What the three sides describe (block or property) */
	target: SyncConflictTarget;
	/**
	 * The target as the author started from it. Null when the engine can
	 * no longer recover it. The editor then compares proposed against
	 * current. Empty for a proposed insertion.
	 */
	base: string | null;
	/** The target as the author intended it, with the parked edit applied. */
	proposed: string;
	/**
	 * The target as this client's document has it now.
	 */
	current: string;
	/**
	 * Whether the record keeps up with an author who types on: the engine
	 * sets their later edits to the same blocks aside too and folds them
	 * into this record. The card then waits for a pause in the typing
	 * (see typing-hold.ts), so the record carries the whole sentence.
	 * Without it the card replaces the block at once, which stops the
	 * typing before the engine can misplace it.
	 */
	followsTyping?: boolean;
}

/**
 * A run of sibling blocks. `index` and `count` locate it among the
 * children of `parentId` (the top level when absent), as of the record's
 * latest publish. `ids` carries the covered blocks' durable ids when the
 * engine has them, and they win over the position. A `count` of 0 is a
 * proposed insertion: no block exists yet, and the card sits where the
 * block would land.
 */
export interface SyncConflictTargetBlocks {
	type: 'blocks';
	ids?: string[];
	parentId?: string;
	index: number;
	count: number;
}

/**
 * One entity property, such as the title. There is no block to anchor.
 * The editor shows the conflict on that field.
 */
export interface SyncConflictTargetProperty {
	type: 'property';
	name: string;
}

export type SyncConflictTarget =
	| SyncConflictTargetBlocks
	| SyncConflictTargetProperty;

/**
 * The reviewer's decision.
 *
 * - `accept`: replace the target with `content` as an ordinary edit
 *   under the reviewer's account, then close the parked edit. For
 *   blocks, empty content removes them (for an insertion, nothing is
 *   added). For a property, `content` is the new value in the same
 *   encoding as the sides.
 * - `dismiss`: close the parked edit and keep the document as it is.
 *
 * An `accept` also names the `current` side the reviewer decided
 * against. The engine refuses the decision when the target no longer
 * reads that way (a collaborator changed it in the meantime): nothing is
 * written, the record stays open with its new `current`, and the outcome
 * is `stale`. Without `current` the engine checks against the record as
 * it holds it.
 */
export type SyncConflictDecision =
	| { action: 'accept'; content: string; current?: string }
	| { action: 'dismiss' };

/**
 * What became of a decision.
 *
 * - `resolved`: the engine took it. An accepted result is still an
 *   ordinary edit, so the engine may merge it or set it aside again.
 * - `stale`: the target changed after the reviewer last saw it. Nothing
 *   was written and the record is still open.
 * - `failed`: the decision did not reach the server. The record is
 *   still open.
 */
export type SyncConflictOutcome = 'resolved' | 'stale' | 'failed';

/**
 * What an engine implements to take part in conflict review. Register
 * it with `registerConflictSource` (src/review/conflicts.ts) from the
 * engine's adapter module.
 */
export interface SyncConflictSource {
	getOpenConflicts: (
		objectType: ObjectType,
		objectId: ObjectID | null
	) => SyncConflict[];
	/**
	 * Called on every change to the open list: a record opened, closed,
	 * or was published again with a new `current`. Returns an
	 * unsubscribe.
	 */
	subscribe: (
		objectType: ObjectType,
		objectId: ObjectID | null,
		listener: () => void
	) => () => void;
	/**
	 * Applies a decision. Returns what became of it, at once or once the
	 * server has answered. Returning nothing reads as `resolved`.
	 */
	resolveConflict: (
		objectType: ObjectType,
		objectId: ObjectID | null,
		conflictId: string,
		decision: SyncConflictDecision
	) => void | SyncConflictOutcome | Promise< SyncConflictOutcome >;
}

/*
 * The engine-neutral conflict shape.
 *
 * A sync engine that sets edits aside for a person to decide publishes
 * them as a list of SyncConflict records. Each record is one card in the
 * canvas (or on a property field) and one review dialog. The editor
 * shows the two sides against the base they started from, lets the
 * reviewer edit a merged result, and hands the decision back to the
 * engine as content.
 *
 * Every block side is serialized block content (block comments plus
 * markup), whatever the block type. The editor picks the presentation
 * from the kind, the target, and the block name. The engine never says
 * how a conflict should look. The engine owns the replacement: it turns
 * the accepted content into the smallest edit against its own document
 * and closes the parked edit in the same round, so the two can never
 * race each other. A record is published again whenever one of its sides
 * changes, and an accepted decision names the `current` it was made
 * against: when the target has changed since, the engine refuses the
 * decision instead of writing over the change (see SyncConflictOutcome).
 *
 * Two rules keep one record equal to one card:
 *
 * - One record per parked unit. Edits the engine set aside together (one
 *   transaction, one proposal) form one record whose target is their
 *   union, never one record per keystroke.
 * - Open records never overlap. At most one open record covers any block
 *   or property. An engine that parks a further edit against a target
 *   already under review holds it back until the open record closes,
 *   then publishes it against the document as it is then.
 *
 * `current` always means this client's document, whichever side the
 * engine's own model treats as canonical.
 *
 * Example registration, from an engine adapter:
 *
 * ```ts
 * const conflicts: SyncConflictSource = {
 *     getOpenConflicts: ( objectType, objectId ) =>
 *         ledgerFor( objectType, objectId ).open(),
 *     subscribe: ( objectType, objectId, listener ) =>
 *         ledgerFor( objectType, objectId ).onChange( listener ),
 *     resolveConflict: ( objectType, objectId, conflictId, decision ) => {
 *         const ledger = ledgerFor( objectType, objectId );
 *         if ( 'accept' === decision.action ) {
 *             ledger.replaceWith( conflictId, decision.content );
 *         }
 *         ledger.close( conflictId );
 *     },
 * };
 *
 * registerConflictSource( conflicts );
 * ```
 *
 * A block type can replace the built-in dialog for its own conflicts
 * (src/review/views.ts). The editor hands a registered view the record
 * and takes back a SyncConflictDecision. The view decides only how the
 * sides look and how the merged result is edited, and never touches the
 * document itself. A view applies when the target is a single block of
 * that type. Other spans keep the built-in dialog. For a table block
 * whose cells merge better as a grid than as text:
 *
 * ```tsx
 * import { parse, serialize } from '@wordpress/blocks';
 *
 * function TableMergeView( { conflict, onDecide, onClose } ) {
 *     const [ base ] = conflict.base ? parse( conflict.base ) : [ null ];
 *     const [ proposed ] = parse( conflict.proposed );
 *     const [ current ] = parse( conflict.current );
 *     // Compare the three grids cell by cell, seed an editable table
 *     // with the clean changes from both sides, and hand the reviewer's
 *     // result back as content.
 *     return (
 *         <TableMergeDialog
 *             base={ base }
 *             proposed={ proposed }
 *             current={ current }
 *             onAccept={ ( merged ) =>
 *                 onDecide( {
 *                     action: 'accept',
 *                     content: serialize( [ merged ] ),
 *                 } )
 *             }
 *             onClose={ onClose }
 *         />
 *     );
 * }
 *
 * registerSyncConflictView( {
 *     blockName: 'core/table',
 *     kind: 'merge',
 *     render: TableMergeView,
 * } );
 * ```
 */
