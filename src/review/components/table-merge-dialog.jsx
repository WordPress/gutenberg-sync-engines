// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { createBlock, parse, serialize } from '@wordpress/blocks';
import TableDiffGrid from './table-diff-grid';
import MergedResultEditor from './merged-result-editor';
import {
	gridFromTableAttributes,
	gridToTableAttributes,
	mergedGridFromModel,
	mergeTableGrids,
} from './merge-table-grids';
import {
	ChangedWhileReviewingNotice,
	MissingBaseNotice,
	useIsOwnProposal,
} from './merge-dialog';

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
		<div className="gse-review-merge-dialog__pane">
			<h3 className="gse-review-merge-dialog__pane-label">{ label }</h3>
			<div className="gse-review-merge-dialog__pane-content">
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
 * SUGGESTED merge (all clean changes from both sides applied, and a cell
 * both sides changed differently holds the current version's value) and
 * hand-editable. Genuinely contested cells are resolved by editing the
 * merged table directly. The panes show what each side wanted. Accept
 * hands the merged table's head, body, and foot attributes back. Cancel
 * closes without changing anything.
 *
 * The record can change while the dialog is open (a collaborator edits
 * the table, or the author types on). The panes always show the record
 * as it is. The merged table follows while it is still a plain copy of
 * the suggested merge or of the version that changed, and is left alone
 * once the reviewer has edited it by hand. A notice says which.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {Object}   props.base          The grid both versions started from.
 * @param {boolean}  props.isBaseMissing Whether the base grid is a stand-in
 *                                       (the record had no base).
 * @param {Object}   props.yours         The author's version of the grid.
 * @param {string}   props.proposedLabel The author's pane heading.
 * @param {Object}   props.current       The document's current version.
 * @param {Function} props.onAccept      ( { head, body, foot } ) => void.
 * @param {Function} props.onCancel      Close without resolving.
 */
export function TableMergeDialogBody( {
	base,
	isBaseMissing = false,
	yours,
	current,
	proposedLabel = __( 'Your version' ),
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
	// What the merged table is a plain copy of: 'suggested' (the merge of
	// the three grids), 'yours', 'current', or null once the reviewer has
	// edited it by hand.
	const [ seedSide, setSeedSide ] = useState( 'suggested' );
	// The grids as the dialog last showed them, and what it did with the
	// merged table when they last changed: 'updated', 'kept', or null.
	const [ shown, setShown ] = useState( { base, yours, current } );
	const [ changeHandling, setChangeHandling ] = useState( null );

	if (
		shown.base !== base ||
		shown.yours !== yours ||
		shown.current !== current
	) {
		setShown( { base, yours, current } );

		if ( 'suggested' === seedSide ) {
			setMerged( mergedBlocksFromGrid( mergedGridFromModel( model ) ) );
			setChangeHandling( 'updated' );
		} else if ( 'yours' === seedSide && shown.yours !== yours ) {
			setMerged( mergedBlocksFromGrid( yours ) );
			setChangeHandling( 'updated' );
		} else if ( 'current' === seedSide && shown.current !== current ) {
			setMerged( mergedBlocksFromGrid( current ) );
			setChangeHandling( 'updated' );
		} else {
			setChangeHandling( 'kept' );
		}
	}

	const restoreGrid = ( side, grid ) => {
		setMerged( mergedBlocksFromGrid( grid ) );
		setSeedSide( side );
	};
	const onEditMerged = ( blocks ) => {
		setMerged( blocks );
		setSeedSide( null );
	};

	return (
		<div className="gse-review-merge-dialog__body">
			<p className="gse-review-merge-dialog__description">
				{ __(
					'These edits could not be merged automatically. Compare the versions and choose what to keep.'
				) }
			</p>
			{ isBaseMissing && <MissingBaseNotice /> }
			{ 'updated' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'This table changed while you were reviewing it. The merged result now starts from the newer version.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			{ 'kept' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'This table changed while you were reviewing it. The merged result was not changed. Check it against the versions above before you accept.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			<div className="gse-review-merge-dialog__panes">
				<GridPane
					label={ proposedLabel }
					grid={ yours }
					baseGrid={ base }
					onRestore={ () => restoreGrid( 'yours', yours ) }
				/>
				<GridPane
					label={ __( 'Current version' ) }
					grid={ current }
					baseGrid={ base }
					onRestore={ () => restoreGrid( 'current', current ) }
				/>
			</div>
			<div className="gse-review-merge-dialog__merged">
				<h3 className="gse-review-merge-dialog__pane-label">
					{ __( 'Merged result' ) }
				</h3>
				<MergedResultEditor
					blocks={ merged }
					onChange={ onEditMerged }
				/>
				<p className="gse-review-merge-dialog__help">
					{ __(
						'This table replaces the conflicted content when you accept.'
					) }
				</p>
			</div>
			<div className="gse-review-merge-dialog__actions">
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
						const { head, body, foot } = merged[ 0 ].attributes;
						onAccept( { head, body, foot } );
					} }
				>
					{ __( 'Accept' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The first table block of a side, parsed.
 *
 * @param {?string} content A side, as serialized blocks.
 * @return {?Object} The table block, or null.
 */
function tableBlockOf( content ) {
	if ( ! content ) {
		return null;
	}

	return (
		parse( content ).find( ( block ) => 'core/table' === block.name ) ??
		null
	);
}

/**
 * A conflict record's three sides as table grids. Without a base (the
 * engine could no longer recover it) the current version stands in, so
 * the proposed side shows every difference and the current side none.
 *
 * @param {Object} conflict The conflict record.
 * @return {Object} `{ base, yours, current }` grids, and `isBaseMissing`
 *                  when the current version stands in for the base.
 */
export function tableGridsOf( conflict ) {
	const current = tableBlockOf( conflict.current );
	const ownBase = tableBlockOf( conflict.base );
	const base = ownBase ?? current;
	const proposed = tableBlockOf( conflict.proposed );

	return {
		isBaseMissing: ! ownBase,
		base: gridFromTableAttributes( base?.attributes ),
		yours: gridFromTableAttributes( proposed?.attributes ),
		current: gridFromTableAttributes( current?.attributes ),
	};
}

/**
 * The in-card preview of a table conflict: the compact union view of
 * both sides' changes, contested cells marked.
 *
 * @param {Object} props
 * @param {Object} props.conflict The conflict record.
 */
export function TableConflictPreview( { conflict } ) {
	const model = useMemo( () => {
		const { base, yours, current } = tableGridsOf( conflict );

		return mergeTableGrids( base, yours, current );
	}, [ conflict ] );

	return <TableDiffGrid model={ model } compact />;
}

/**
 * The table block's review view (see src/review/views.ts): the record's
 * sides as grids, the merged result as a table, and the decision handed
 * back as the serialized table. The merged table keeps the current
 * block's other attributes (the caption, the layout) and its identity.
 * Only the head, the body, and the foot come from the merge.
 *
 * @param {Object}   props
 * @param {Object}   props.conflict The conflict record.
 * @param {Function} props.onDecide ( decision ) => void.
 * @param {Function} props.onClose  Close without resolving.
 */
export function TableConflictView( { conflict, onDecide, onClose } ) {
	const isOwn = useIsOwnProposal( conflict.authorId );
	// The grids are rebuilt only when a side's content changes. The
	// record itself is a new object on every publish, and the dialog
	// reads a new grid as a changed table.
	const { base, proposed, current } = conflict;
	const grids = useMemo(
		() => tableGridsOf( { base, proposed, current } ),
		[ base, proposed, current ]
	);
	let proposedLabel = __( 'Proposed version' );
	if ( isOwn ) {
		proposedLabel = __( 'Your version' );
	}

	return (
		<Modal
			title={ __( 'Review conflicting edits' ) }
			onRequestClose={ onClose }
			className="gse-review-merge-dialog gse-review-merge-dialog--table"
			size="large"
		>
			<TableMergeDialogBody
				base={ grids.base }
				isBaseMissing={ grids.isBaseMissing }
				yours={ grids.yours }
				current={ grids.current }
				proposedLabel={ proposedLabel }
				onAccept={ ( { head, body, foot } ) => {
					const live =
						tableBlockOf( conflict.current ) ??
						tableBlockOf( conflict.proposed );
					onDecide( {
						action: 'accept',
						content: serialize( [
							createBlock( 'core/table', {
								...( live?.attributes ?? {} ),
								head,
								body,
								foot,
							} ),
						] ),
					} );
				} }
				onCancel={ onClose }
			/>
		</Modal>
	);
}
