// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { diffWords } from 'diff';
import { useMemo, useState } from '@wordpress/element';
import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import {
	store as blockEditorStore,
	useBlockProps,
} from '@wordpress/block-editor';
import { useOpenConflicts, useResolveConflict } from '../conflicts';
import { getSyncConflictView } from '../views';
import DiffText from './diff-text';
import CollaborationMergeDialog from './merge-dialog';
import { conflictsTargetingBlock, useCurrentPost } from './review-data';

const EMPTY_CONFLICTS = [];

/*
 * The replacement renders inside the editor canvas, where the admin
 * stylesheet carrying the dialog styles does not load (the block-recovery
 * Warning styles do), so it brings its own styles for the preview and the
 * diff highlighting.
 */
const CANVAS_CSS = `
	.gse-review-conflict-block__preview {
		background: #f0f0f0;
		border-radius: 2px;
		box-sizing: border-box;
		margin-top: 12px;
		padding: 8px;
		white-space: pre-wrap;
		width: 100%;
		word-break: break-word;
	}
	.gse-review-diff__added {
		background: rgba(74, 184, 102, 0.25);
		text-decoration: none;
	}
	.gse-review-diff__removed {
		background: rgba(204, 24, 24, 0.2);
		text-decoration: line-through;
	}
	.gse-review-table-diff__wrapper {
		overflow-x: auto;
		width: 100%;
	}
	.gse-review-table-diff {
		border-collapse: collapse;
		width: 100%;
	}
	.gse-review-table-diff__cell {
		border: 1px solid #ccc;
		padding: 4px 8px;
		text-align: left;
		vertical-align: top;
	}
	.gse-review-table-diff--compact .gse-review-table-diff__cell {
		font-size: 12px;
		padding: 2px 6px;
	}
	.gse-review-table-diff__cell--added,
	.gse-review-table-diff__cell--changed {
		background: rgba(74, 184, 102, 0.25);
	}
	.gse-review-table-diff__cell--contested {
		background: rgba(240, 184, 73, 0.4);
	}
`;

/**
 * A side's readable text, for the card preview: block delimiters and tags
 * stripped, whitespace collapsed.
 *
 * @param {?string} content Serialized block content.
 * @return {string} The plain text.
 */
export function plainText( content ) {
	return String( content ?? '' )
		.replace( /<!--[\s\S]*?-->/g, ' ' )
		.replace( /<[^>]+>/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim();
}

/**
 * The open MERGE conflicts targeting one block. One record is one
 * conflict (the engine publishes the edits it set aside together as one
 * record, and never two records over the same block by one author), and
 * a record covering several blocks targets its first block, so a section
 * presents once. Security holds (kind `sequestration`) are excluded:
 * those present as the sequestered-block card instead (see the
 * sequestered-block editor hook).
 *
 * @param {string} clientId The block's client id.
 * @return {Array} The block's open merge conflicts.
 */
export function useBlockConflicts( clientId ) {
	const { postType, postId } = useCurrentPost();
	const open = useOpenConflicts( postType, postId );

	return useSelect(
		( select ) => {
			if ( ! open.length ) {
				return EMPTY_CONFLICTS;
			}

			const matches = conflictsTargetingBlock(
				select,
				open,
				clientId
			).filter( ( conflict ) => 'merge' === conflict.kind );

			if ( ! matches.length ) {
				return EMPTY_CONFLICTS;
			}

			return matches;
		},
		[ clientId, open ]
	);
}

/**
 * The body of the in-place conflict replacement, styled like block
 * recovery: one warning box holding the message, the "Review conflict"
 * action, and, below them, a preview of the conflict. The preview is the
 * word diff from the current version to the proposed one, unless the
 * block type registered its own (a table previews as a compact table
 * showing both sides' changes).
 *
 * The preview diff is deliberately whitespace-INSENSITIVE and runs
 * version to version: against the base, two versions of one sentence
 * degrade into an unreadable word-by-word interleave. The dialog's panes
 * diff each version against the shared base instead.
 *
 * The block-recovery Warning component keeps everything but its actions
 * inside the message paragraph, so the box is rendered directly with the
 * same class names; the canvas's recovery styles apply to it either way,
 * and the preview can sit inside the box as its own full-width row.
 *
 * Position-independent so it can be unit-tested without the block editor.
 *
 * @param {Object}   props
 * @param {Object}   props.conflict  The conflict record.
 * @param {string}   props.blockName The conflicted block's name.
 * @param {boolean}  props.isSection Whether the record covers a section
 *                                   (several blocks, or a container).
 * @param {Function} props.onReview  Open the merge dialog.
 */
export function ConflictBlockBody( {
	conflict,
	blockName,
	isSection,
	onReview,
} ) {
	const view = isSection
		? undefined
		: getSyncConflictView( blockName, 'merge' );
	const parts = useMemo(
		() =>
			diffWords(
				plainText( conflict.current ),
				plainText( conflict.proposed )
			),
		[ conflict ]
	);

	let message = __( 'This block has conflicting edits.' );
	if ( isSection ) {
		message = __( 'This section has conflicting edits.' );
	} else if ( 'core/table' === blockName ) {
		message = __( 'This table has conflicting edits.' );
	}

	let preview = <DiffText parts={ parts } />;
	if ( view?.renderPreview ) {
		const Preview = view.renderPreview;
		preview = <Preview conflict={ conflict } />;
	}

	return (
		<>
			<style>{ CANVAS_CSS }</style>
			<div className="block-editor-warning">
				<div className="block-editor-warning__contents">
					<p className="block-editor-warning__message">{ message }</p>
					<div className="block-editor-warning__actions">
						<span className="block-editor-warning__action">
							<Button
								__next40pxDefaultSize
								variant="primary"
								onClick={ onReview }
							>
								{ __( 'Review conflict' ) }
							</Button>
						</span>
					</div>
				</div>
				<div className="gse-review-conflict-block__preview">
					{ preview }
				</div>
			</div>
		</>
	);
}

/**
 * The in-place replacement for a conflicted block: rendered INSTEAD of the
 * block's edit UI (see the conflict-block editor hook), so the content is
 * read-only until the conflict is reviewed. The dialog opens from here;
 * its modal renders outside the canvas. A single block whose type
 * registered a review view (a table) opens that view; everything else
 * opens the built-in dialog, with its structure unlocked when the record
 * covers a section.
 *
 * The reviewer's decision goes to the ENGINE as content
 * (`resolveConflict` with `accept` plus serialized blocks): the engine
 * applies the replacement as an ordinary edit and closes the record in
 * the same round. The card never writes into the canvas itself: a canvas
 * write dispatched right before resolving is silently lost to the sync
 * push the resolution triggers (see AGENTS.md on pushes from inside
 * update()).
 *
 * When several records target the block (parked edits by different
 * authors), the card presents the first; the next one takes its place
 * once it is decided.
 *
 * @param {Object} props
 * @param {string} props.clientId  The block's client id.
 * @param {string} props.blockName The block's name.
 * @param {Array}  props.conflicts The block's open merge conflicts.
 */
export default function ConflictBlock( { clientId, blockName, conflicts } ) {
	const blockProps = useBlockProps();
	const { postType, postId } = useCurrentPost();
	const resolve = useResolveConflict( postType, postId );
	const [ isReviewing, setIsReviewing ] = useState( false );
	const [ conflict ] = conflicts;
	const isContainer = useSelect(
		( select ) => select( blockEditorStore ).getBlockCount( clientId ) > 0,
		[ clientId ]
	);
	const isSection =
		isContainer ||
		( 'blocks' === conflict.target.type && conflict.target.count > 1 );
	const view = isSection
		? undefined
		: getSyncConflictView( blockName, 'merge' );

	const onClose = () => setIsReviewing( false );
	const onDecide = ( decision ) => {
		resolve( conflict.id, decision );
		setIsReviewing( false );
	};

	let dialog = null;
	if ( isReviewing && view ) {
		const View = view.render;
		dialog = (
			<View
				conflict={ conflict }
				onDecide={ onDecide }
				onClose={ onClose }
			/>
		);
	} else if ( isReviewing ) {
		dialog = (
			<CollaborationMergeDialog
				conflict={ conflict }
				isSection={ isSection }
				onDecide={ onDecide }
				onClose={ onClose }
			/>
		);
	}

	return (
		<div { ...blockProps }>
			<ConflictBlockBody
				conflict={ conflict }
				blockName={ blockName }
				isSection={ isSection }
				onReview={ () => setIsReviewing( true ) }
			/>
			{ dialog }
		</div>
	);
}
