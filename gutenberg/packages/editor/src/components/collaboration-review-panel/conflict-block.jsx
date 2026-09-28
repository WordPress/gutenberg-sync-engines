import { useMemo, useState } from '@wordpress/element';
import { useSelect, useDispatch, useRegistry } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { cloneBlock, parse } from '@wordpress/blocks';
import { store as coreStore } from '@wordpress/core-data';
import {
	store as blockEditorStore,
	useBlockProps,
} from '@wordpress/block-editor';
import { store as editorStore } from '../../store';
import { unlock } from '../../lock-unlock';
import DiffText from './diff-text';
import { mockConflictParts } from './mock-conflict';
import { mockSectionConflictParts } from './mock-section-conflict';
import CollaborationMergeDialog from './merge-dialog';
import CollaborationSectionMergeDialog from './section-merge-dialog';
import CollaborationTableMergeDialog from './table-merge-dialog';
import TableDiffGrid from './table-diff-grid';
import { mergeTableGrids } from './merge-table-grids';
import { MOCK_TABLE_CONFLICT } from './mock-table-conflict';
import { itemsTargetingBlock, useResolveReviewItems } from './review-data';

const EMPTY_ITEMS = [];

// Stable empty result for useConflictGroup, so unconflicted blocks (the
// overwhelmingly common case) never re-render from a fresh object.
const NO_GROUP = {
	items: EMPTY_ITEMS,
	isPresenter: false,
	sectionClientId: null,
};

/*
 * The replacement renders inside the editor canvas, where the admin
 * stylesheet carrying the review panel's styles does not load (the
 * block-recovery Warning styles do), so it brings its own styles for the
 * preview and the diff highlighting.
 */
const CANVAS_CSS = `
	.editor-collaboration-conflict-block__preview {
		background: #f0f0f0;
		border-radius: 2px;
		box-sizing: border-box;
		margin-top: 12px;
		padding: 8px;
		white-space: pre-wrap;
		width: 100%;
		word-break: break-word;
	}
	.editor-collaboration-diff__added {
		background: rgba(74, 184, 102, 0.25);
		text-decoration: none;
	}
	.editor-collaboration-diff__removed {
		background: rgba(204, 24, 24, 0.2);
		text-decoration: line-through;
	}
	.editor-collaboration-table-diff__wrapper {
		overflow-x: auto;
		width: 100%;
	}
	.editor-collaboration-table-diff {
		border-collapse: collapse;
		width: 100%;
	}
	.editor-collaboration-table-diff__cell {
		border: 1px solid #ccc;
		padding: 4px 8px;
		text-align: left;
		vertical-align: top;
	}
	.editor-collaboration-table-diff--compact .editor-collaboration-table-diff__cell {
		font-size: 12px;
		padding: 2px 6px;
	}
	.editor-collaboration-table-diff__cell--added,
	.editor-collaboration-table-diff__cell--changed {
		background: rgba(74, 184, 102, 0.25);
	}
	.editor-collaboration-table-diff__cell--contested {
		background: rgba(240, 184, 73, 0.4);
	}
`;

/**
 * The open CONFLICT review items targeting one block, with the security
 * holds (`requires-approval`) excluded: those present as the
 * sequestered-block card instead (see the collaboration-sequestered-block
 * editor hook).
 *
 * @param {Function} select   Registry select.
 * @param {Array}    items    The entity's open review items.
 * @param {string}   clientId The block's client id.
 * @return {Array} The block's open conflict review items.
 */
function blockConflicts( select, items, clientId ) {
	return itemsTargetingBlock( select, items, clientId ).filter(
		( item ) => 'requires-approval' !== item.reason
	);
}

/**
 * The conflict GROUP a block belongs to, and whether this block is the
 * group's PRESENTER (the one block that renders the card and dialog).
 *
 * The principled grouping signal is the engines' atomic unit (a review
 * item's `unitId`: an intent-log txn, a de-rtc proposal; a de-rtc
 * proposal already spans several blocks in ONE item). intent-log does
 * not stamp txns onto captured intents yet, so each escalated intent
 * arrives as its own single-block unit; until it does, this hook
 * applies the DEMO stand-in on top: all conflict items landing inside
 * one SECTION (the block itself when it is a group, else its nearest
 * group ancestor) combine into one group, presented once and resolved
 * together. A block outside any group keeps the one-block-one-conflict
 * behavior, so the paragraph and table demos are unaffected.
 *
 * The presenter is the section's first conflicted block in document
 * order (the section block itself first, then its descendants). Other
 * conflicted blocks in the section render their NORMAL edit UI, so the
 * section reads as a single conflict rather than a wall of cards.
 *
 * @param {string} clientId The block's client id.
 * @return {Object} { items, isPresenter, sectionClientId }: the group's
 *                  open conflict items (empty when the block presents
 *                  nothing), whether this block presents the group, and
 *                  the section block's client id (null outside a
 *                  group).
 */
export function useConflictGroup( clientId ) {
	return useSelect(
		( select ) => {
			const { getCurrentPostType, getCurrentPostId } =
				select( editorStore );
			const postType = getCurrentPostType();
			const postId = getCurrentPostId();

			if ( ! postType || ! postId ) {
				return NO_GROUP;
			}

			const items = unlock( select( coreStore ) ).getSyncReviewItems(
				'postType',
				postType,
				postId
			);

			if ( ! items.length ) {
				return NO_GROUP;
			}

			const { getBlockName, getBlockParents, getClientIdsOfDescendants } =
				select( blockEditorStore );

			// The block's section: itself when it is a group (de-rtc
			// parks by top-level index, so a conflict anywhere inside a
			// group lands on the group), else the nearest group ancestor
			// (intent-log parks on the inner block whose syncId the
			// escalated edit targeted). Ascending order, root first; the
			// nearest group wins.
			let sectionClientId = null;
			if ( 'core/group' === getBlockName( clientId ) ) {
				sectionClientId = clientId;
			} else {
				const parents = getBlockParents( clientId );
				for ( let i = parents.length - 1; i >= 0; i-- ) {
					if ( 'core/group' === getBlockName( parents[ i ] ) ) {
						sectionClientId = parents[ i ];
						break;
					}
				}
			}

			if ( ! sectionClientId ) {
				const matches = blockConflicts( select, items, clientId );
				if ( ! matches.length ) {
					return NO_GROUP;
				}

				return {
					items: matches,
					isPresenter: true,
					sectionClientId: null,
				};
			}

			// Gather the section's whole group in document order; the
			// first conflicted block presents. De-duplicate by item id:
			// an item carrying both a syncId and a top-level index could
			// match two candidates.
			const candidates = [
				sectionClientId,
				...getClientIdsOfDescendants( sectionClientId ),
			];
			const group = [];
			const seen = new Set();
			let presenter = null;
			for ( const candidate of candidates ) {
				const matches = blockConflicts( select, items, candidate );
				if ( ! matches.length ) {
					continue;
				}

				if ( ! presenter ) {
					presenter = candidate;
				}

				for ( const item of matches ) {
					if ( ! seen.has( item.id ) ) {
						seen.add( item.id );
						group.push( item );
					}
				}
			}

			if ( ! group.length ) {
				return NO_GROUP;
			}

			return {
				items: group,
				isPresenter: presenter === clientId,
				sectionClientId,
			};
		},
		[ clientId ]
	);
}

/**
 * Builds the section's replacement inner blocks so the sync engine sees
 * MINIMAL edits. A merged block matching a live block by position and
 * name becomes a clone of the LIVE block with only the merged content
 * applied: the clone keeps the live block's identity (metadata.syncId)
 * and its exact attributes, so an untouched block derives nothing and
 * an edited one derives a clean text edit. Only unmatched blocks (a
 * split's second half) enter as genuinely new blocks.
 *
 * Handing the engine freshly parsed blocks instead loses on both
 * counts: without the identities the replacement reconciles into
 * duplicated blocks, and parsing materializes DEFAULT attributes
 * (heading level, paragraph dropCap) that derive as attribute writes on
 * live blocks and escalate as conflicts. Positional matching is a
 * prototype heuristic; real engine-backed resolution replaces it.
 *
 * @param {Array} liveBlocks   The section's current inner blocks.
 * @param {Array} mergedBlocks The parsed replacement blocks.
 * @return {Array} The blocks to hand replaceInnerBlocks.
 */
function minimalReplacementBlocks( liveBlocks, mergedBlocks ) {
	return mergedBlocks.map( ( block, index ) => {
		const live = liveBlocks[ index ];
		if (
			live?.name === block.name &&
			live.attributes?.content !== undefined &&
			block.attributes?.content !== undefined
		) {
			return cloneBlock( live, {
				content: block.attributes.content,
			} );
		}

		return block;
	} );
}

/**
 * The body of the in-place conflict replacement, styled like block
 * recovery: one warning box holding the message, the "Review conflict"
 * action, and, below them, a preview of the conflict. For most blocks the
 * preview is the word diff with add/remove highlighting; for a table
 * block it is a compact table showing both sides' changes, contested
 * cells marked; for a block in a group section it is the word diff of
 * the whole section's text. A table's presentation wins over the
 * section's: the table preview is the more specific view of the block
 * that actually conflicted. PROTOTYPE: the preview shows the fabricated
 * mock conflict, not the block's real contents.
 *
 * The block-recovery Warning component keeps everything but its actions
 * inside the message paragraph, so the box is rendered directly with the
 * same class names; the canvas's recovery styles apply to it either way,
 * and the preview can sit inside the box as its own full-width row.
 *
 * Position-independent so it can be unit-tested without the block editor.
 *
 * @param {Object}   props
 * @param {string}   props.blockName The conflicted block's name.
 * @param {boolean}  props.isSection Whether the block is, or sits
 *                                   inside, a group section.
 * @param {Function} props.onReview  Open the merge dialog.
 */
export function ConflictBlockBody( { blockName, isSection, onReview } ) {
	const isTable = 'core/table' === blockName;
	const tableModel = useMemo( () => {
		if ( ! isTable ) {
			return null;
		}

		return mergeTableGrids(
			MOCK_TABLE_CONFLICT.base,
			MOCK_TABLE_CONFLICT.yours,
			MOCK_TABLE_CONFLICT.current
		);
	}, [ isTable ] );

	let message = __( 'This block has conflicting edits.' );
	let preview = <DiffText parts={ mockConflictParts() } />;
	if ( isTable ) {
		message = __( 'This table has conflicting edits.' );
		preview = <TableDiffGrid model={ tableModel } compact />;
	} else if ( isSection ) {
		message = __( 'This section has conflicting edits.' );
		preview = <DiffText parts={ mockSectionConflictParts() } />;
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
				<div className="editor-collaboration-conflict-block__preview">
					{ preview }
				</div>
			</div>
		</>
	);
}

/**
 * The in-place replacement for a conflicted block: rendered INSTEAD of the
 * block's edit UI (see the collaboration-conflict-block editor hook), so
 * the content is read-only until the conflict is reviewed. The merge
 * dialog opens from here; its modal renders outside the canvas. A table
 * block opens the table-shaped dialog; a block that is, or sits inside,
 * a group opens the section dialog, which compares and resolves the
 * whole section (needed for conflicts with no per-block answer, like a
 * paragraph split on one side and edited on the other); every other
 * block opens the paragraph one.
 *
 * @param {Object}  props
 * @param {string}  props.clientId        The block's client id.
 * @param {string}  props.blockName       The block's name.
 * @param {Array}   props.items           The conflict group's open review
 *                                        items (the whole section's when
 *                                        the block presents a section).
 * @param {?string} props.sectionClientId The section block's client id,
 *                                        or null outside a group (from
 *                                        useConflictGroup).
 */
export default function ConflictBlock( {
	clientId,
	blockName,
	items,
	sectionClientId,
} ) {
	const blockProps = useBlockProps();
	const { postType, postId } = useSelect( ( select ) => {
		const { getCurrentPostType, getCurrentPostId } = select( editorStore );

		return {
			postType: getCurrentPostType(),
			postId: getCurrentPostId(),
		};
	}, [] );
	const registry = useRegistry();
	const onResolve = useResolveReviewItems( postType, postId );
	const { updateBlockAttributes, replaceInnerBlocks } =
		useDispatch( blockEditorStore );
	const [ isReviewing, setIsReviewing ] = useState( false );

	let dialog = null;
	if ( isReviewing && 'core/table' === blockName ) {
		dialog = (
			<CollaborationTableMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ ( { head, body } ) => {
					// PROTOTYPE resolution: write the merged table into
					// the block's head and body attributes as an ordinary
					// edit (other attributes like the caption keep their
					// live values) and clear the parked items. Real
					// engine-backed resolution replaces this.
					updateBlockAttributes( clientId, { head, body } );
					onResolve( items, 'dismissed' );
					setIsReviewing( false );
				} }
			/>
		);
	} else if ( isReviewing && sectionClientId ) {
		dialog = (
			<CollaborationSectionMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ ( mergedContent ) => {
					// PROTOTYPE resolution: replace the section's inner
					// blocks with the merged result as an ordinary edit,
					// built as minimal edits over the live blocks (see
					// minimalReplacementBlocks), and clear the parked
					// items. Real engine-backed resolution replaces
					// this. Resolve only after the capture delay (1.2 s)
					// has folded the replacement into the outbox:
					// resolving immediately triggers a sync push that
					// rebuilds the canvas from the canonical document
					// before the capture picks the replacement up (the
					// same race the security-hold card's Remove block
					// works around).
					replaceInnerBlocks(
						sectionClientId,
						minimalReplacementBlocks(
							registry
								.select( blockEditorStore )
								.getBlocks( sectionClientId ),
							parse( mergedContent )
						)
					);
					// Deliberately NOT cancelled on unmount: replacing the
					// inner blocks can unmount this card immediately, and
					// the deferred resolution must still run.
					// eslint-disable-next-line @wordpress/react-no-unsafe-timeout
					setTimeout( () => onResolve( items, 'dismissed' ), 2500 );
					setIsReviewing( false );
				} }
			/>
		);
	} else if ( isReviewing ) {
		dialog = (
			<CollaborationMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ ( mergedText ) => {
					// PROTOTYPE resolution: write the merged text into
					// the block as an ordinary edit (assumes a
					// paragraph-shaped block) and clear the parked
					// items. Real engine-backed resolution replaces
					// this.
					updateBlockAttributes( clientId, {
						content: mergedText,
					} );
					onResolve( items, 'dismissed' );
					setIsReviewing( false );
				} }
			/>
		);
	}

	return (
		<div { ...blockProps }>
			<ConflictBlockBody
				blockName={ blockName }
				isSection={ !! sectionClientId }
				onReview={ () => setIsReviewing( true ) }
			/>
			{ dialog }
		</div>
	);
}
