import { useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { createBlock } from '@wordpress/blocks';
import TableDiffGrid from './table-diff-grid';
import MergedResultEditor from './merged-result-editor';
import {
	gridToTableAttributes,
	mergedGridFromModel,
	mergeTableGrids,
} from './merge-table-grids';
import { MOCK_TABLE_CONFLICT } from './mock-table-conflict';

/**
 * The merged result as blocks, seeded from a grid.
 *
 * @param {Object} grid The grid to seed from.
 * @return {Array} A single table block holding the grid.
 */
function mergedBlocksFromGrid( grid ) {
	return [ createBlock( 'core/table', gridToTableAttributes( grid ) ) ];
}

/**
 * One version pane: a heading, this version rendered as a table with its
 * OWN changes against the shared base highlighted (added rows and
 * columns, edited cells), and a button copying this version into the
 * merged result.
 *
 * @param {Object}   props
 * @param {string}   props.label     Pane heading.
 * @param {Object}   props.grid      This version's grid.
 * @param {Object}   props.baseGrid  The shared base grid.
 * @param {Function} props.onRestore Copy this version into the merged
 *                                   result.
 */
function GridPane( { label, grid, baseGrid, onRestore } ) {
	return (
		<div className="editor-collaboration-merge-dialog__pane">
			<h3 className="editor-collaboration-merge-dialog__pane-label">
				{ label }
			</h3>
			<div className="editor-collaboration-merge-dialog__pane-content">
				<TableDiffGrid
					grid={ grid }
					baseGrid={ baseGrid }
					label={ label }
				/>
			</div>
			<Button
				__next40pxDefaultSize
				size="compact"
				variant="secondary"
				onClick={ onRestore }
			>
				{ __( 'Restore this version' ) }
			</Button>
		</div>
	);
}

/**
 * The table merge dialog's content: your version and the current version
 * side by side as read-only tables, each highlighting only its own
 * changes against the shared base, and below them the merged result as a
 * real table block in the mini block editor, pre-seeded with the
 * SUGGESTED merge (all clean changes from both sides applied; a cell
 * both sides changed differently holds the current version's value) and
 * hand-editable. Genuinely contested cells are resolved by editing the
 * merged table directly; the panes show what each side wanted. Accept
 * hands the merged table's head and body attributes back; Cancel closes
 * without changing anything.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {Object}   props.base     The grid both versions started from.
 * @param {Object}   props.yours    The author's version of the grid.
 * @param {Object}   props.current  The document's current version.
 * @param {Function} props.onAccept ( { head, body } ) => void.
 * @param {Function} props.onCancel Close without resolving.
 */
export function TableMergeDialogBody( {
	base,
	yours,
	current,
	onAccept,
	onCancel,
} ) {
	const model = useMemo(
		() => mergeTableGrids( base, yours, current ),
		[ base, yours, current ]
	);
	// The merged result starts as the suggested merge. Restores reseed it
	// wholly, and it stays hand-editable in the merged block editor below
	// the panes.
	const [ merged, setMerged ] = useState( () =>
		mergedBlocksFromGrid( mergedGridFromModel( model ) )
	);

	const restoreGrid = ( grid ) => {
		setMerged( mergedBlocksFromGrid( grid ) );
	};

	return (
		<div className="editor-collaboration-merge-dialog__body">
			<p className="editor-collaboration-merge-dialog__description">
				{ __(
					'These edits could not be merged automatically. Compare the versions and choose what to keep.'
				) }
			</p>
			<div className="editor-collaboration-merge-dialog__panes">
				<GridPane
					label={ __( 'Your version' ) }
					grid={ yours }
					baseGrid={ base }
					onRestore={ () => restoreGrid( yours ) }
				/>
				<GridPane
					label={ __( 'Current version' ) }
					grid={ current }
					baseGrid={ base }
					onRestore={ () => restoreGrid( current ) }
				/>
			</div>
			<div className="editor-collaboration-merge-dialog__merged">
				<h3 className="editor-collaboration-merge-dialog__pane-label">
					{ __( 'Merged result' ) }
				</h3>
				<MergedResultEditor blocks={ merged } onChange={ setMerged } />
				<p className="editor-collaboration-merge-dialog__help">
					{ __(
						'This table replaces the conflicted content when you accept.'
					) }
				</p>
			</div>
			<div className="editor-collaboration-merge-dialog__actions">
				<Button
					__next40pxDefaultSize
					variant="tertiary"
					onClick={ onCancel }
				>
					{ __( 'Cancel' ) }
				</Button>
				<Button
					__next40pxDefaultSize
					variant="primary"
					onClick={ () => {
						const { head, body } = merged[ 0 ].attributes;
						onAccept( { head, body } );
					} }
				>
					{ __( 'Accept' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The collaboration table merge dialog, opened from a conflicted table
 * block's "Review conflict" card. PROTOTYPE: the compared grids are the
 * fabricated mock table conflict, not the block's real cells; real
 * conflicts open it, but its contents are pre-set while the UI design
 * settles.
 *
 * @param {Object}   props
 * @param {Function} props.onAccept ( { head, body } ) => void.
 * @param {Function} props.onClose  Close without resolving.
 */
export default function CollaborationTableMergeDialog( { onAccept, onClose } ) {
	return (
		<Modal
			title={ __( 'Review conflicting edits' ) }
			onRequestClose={ onClose }
			className="editor-collaboration-merge-dialog editor-collaboration-merge-dialog--table"
			size="large"
		>
			<TableMergeDialogBody
				base={ MOCK_TABLE_CONFLICT.base }
				yours={ MOCK_TABLE_CONFLICT.yours }
				current={ MOCK_TABLE_CONFLICT.current }
				onAccept={ onAccept }
				onCancel={ onClose }
			/>
		</Modal>
	);
}
