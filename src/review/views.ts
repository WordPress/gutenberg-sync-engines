/**
 * Block-type overrides for the conflict review dialog. A block type whose
 * conflicts merge better in a bespoke view (a table as a grid rather than
 * as text) registers one here; the built-in dialog handles every other
 * target. A view applies when the target is a single block of that type;
 * multi-block spans keep the built-in section dialog.
 *
 * The view receives the record and hands back a SyncConflictDecision. It
 * decides only how the sides look and how the merged result is edited;
 * it never touches the document (the engine applies the decision).
 */

/**
 * Internal dependencies
 */
import type { SyncConflict, SyncConflictDecision } from './types';

export interface SyncConflictViewProps {
	conflict: SyncConflict;
	onDecide: ( decision: SyncConflictDecision ) => void;
	onClose: () => void;
}

export interface SyncConflictView {
	/** The block type the view applies to. */
	blockName: string;
	/** Which conflicts of that block type it presents. */
	kind: SyncConflict[ 'kind' ];
	/** The dialog component. */
	render: ( props: SyncConflictViewProps ) => JSX.Element | null;
	/** The in-card preview, when the word diff of the sides is not it. */
	renderPreview?: ( props: { conflict: SyncConflict } ) => JSX.Element | null;
}

const views = new Map< string, SyncConflictView >();

const viewKey = ( blockName: string, kind: SyncConflict[ 'kind' ] ) =>
	`${ kind }:${ blockName }`;

/**
 * Registers a block type's review view. A later registration for the
 * same block type and kind replaces the earlier one.
 *
 * @param view The view.
 */
export function registerSyncConflictView( view: SyncConflictView ): void {
	views.set( viewKey( view.blockName, view.kind ), view );
}

/**
 * The registered view for a block type and conflict kind, if any.
 *
 * @param blockName The block type.
 * @param kind      The conflict kind.
 * @return The view, or undefined for the built-in dialog.
 */
export function getSyncConflictView(
	blockName: string,
	kind: SyncConflict[ 'kind' ]
): SyncConflictView | undefined {
	return views.get( viewKey( blockName, kind ) );
}

/**
 * Test support: forget every registered view.
 */
export function resetSyncConflictViewsForTesting(): void {
	views.clear();
}
