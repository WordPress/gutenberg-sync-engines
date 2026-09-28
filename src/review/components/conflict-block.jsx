// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { useMemo, useState } from '@wordpress/element';
import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { createBlock, serialize } from '@wordpress/blocks';
import {
	store as blockEditorStore,
	useBlockProps,
} from '@wordpress/block-editor';
import { useOpenConflicts, useResolveConflict } from '../conflicts';
import DiffText from './diff-text';
import { mockConflictParts } from './mock-conflict';
import { mockSectionConflictParts } from './mock-section-conflict';
import CollaborationMergeDialog from './merge-dialog';
import CollaborationSectionMergeDialog from './section-merge-dialog';
import CollaborationTableMergeDialog from './table-merge-dialog';
import TableDiffGrid from './table-diff-grid';
import { mergeTableGrids } from './merge-table-grids';
import { MOCK_TABLE_CONFLICT } from './mock-table-conflict';
import { conflictsTargetingBlock, useCurrentPost } from './review-data';

const EMPTY_CONFLICTS = [];

// Stable empty result for useConflictGroup, so unconflicted blocks (the
// overwhelmingly common case) never re-render from a fresh object.
const NO_GROUP = {
	conflicts: EMPTY_CONFLICTS,
	isPresenter: false,
	sectionClientId: null,
};

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
 * The open MERGE conflicts targeting one block. Security holds (kind
 * `sequestration`) are excluded: those present as the sequestered-block
 * card instead (see the sequestered-block editor hook).
 *
 * @param {Function} select    Registry select.
 * @param {Array}    conflicts The entity's open conflict records.
 * @param {string}   clientId  The block's client id.
 * @return {Array} The block's open merge conflicts.
 */
function blockConflicts( select, conflicts, clientId ) {
	return conflictsTargetingBlock( select, conflicts, clientId ).filter(
		( conflict ) => 'merge' === conflict.kind
	);
}

/**
 * The conflict GROUP a block belongs to, and whether this block is the
 * group's PRESENTER (the one block that renders the card and dialog).
 *
 * The principled grouping signal is the contract's "one record per parked
 * unit": an engine publishes the edits it set aside together as ONE
 * record whose target is their union. intent-log does not stamp txns onto
 * captured intents yet, so each escalated intent arrives as its own
 * single-block record; until it does (plan Phase 3), this hook applies
 * the DEMO stand-in on top: all merge conflicts landing inside one
 * SECTION (the block itself when it is a group, else its nearest group
 * ancestor) combine into one group, presented once and resolved together.
 * A block outside any group keeps the one-block-one-conflict behavior, so
 * the paragraph and table demos are unaffected.
 *
 * The presenter is the section's first conflicted block in document
 * order (the section block itself first, then its descendants). Other
 * conflicted blocks in the section render their NORMAL edit UI, so the
 * section reads as a single conflict rather than a wall of cards.
 *
 * @param {string} clientId The block's client id.
 * @return {Object} { conflicts, isPresenter, sectionClientId }: the
 *                  group's open merge conflicts (empty when the block
 *                  presents nothing), whether this block presents the
 *                  group, and the section block's client id (null
 *                  outside a group).
 */
export function useConflictGroup( clientId ) {
	const { postType, postId } = useCurrentPost();
	const open = useOpenConflicts( postType, postId );

	return useSelect(
		( select ) => {
			if ( ! open.length ) {
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
				const matches = blockConflicts( select, open, clientId );
				if ( ! matches.length ) {
					return NO_GROUP;
				}

				return {
					conflicts: matches,
					isPresenter: true,
					sectionClientId: null,
				};
			}

			// Gather the section's whole group in document order; the
			// first conflicted block presents. De-duplicate by record id:
			// a record carrying both ids and a position could match two
			// candidates.
			const candidates = [
				sectionClientId,
				...getClientIdsOfDescendants( sectionClientId ),
			];
			const group = [];
			const seen = new Set();
			let presenter = null;
			for ( const candidate of candidates ) {
				const matches = blockConflicts( select, open, candidate );
				if ( ! matches.length ) {
					continue;
				}

				if ( ! presenter ) {
					presenter = candidate;
				}

				for ( const conflict of matches ) {
					if ( ! seen.has( conflict.id ) ) {
						seen.add( conflict.id );
						group.push( conflict );
					}
				}
			}

			if ( ! group.length ) {
				return NO_GROUP;
			}

			return {
				conflicts: group,
				isPresenter: presenter === clientId,
				sectionClientId,
			};
		},
		[ clientId, open ]
	);
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
 * read-only until the conflict is reviewed. The merge dialog opens from
 * here; its modal renders outside the canvas. A table block opens the
 * table-shaped dialog; a block that is, or sits inside, a group opens the
 * section dialog, which compares and resolves the whole section (needed
 * for conflicts with no per-block answer, like a paragraph split on one
 * side and edited on the other); every other block opens the paragraph
 * one.
 *
 * The reviewer's decision goes to the ENGINE as content
 * (`resolveConflict` with `accept` plus serialized blocks): the engine
 * applies the replacement as an ordinary edit and closes the record in
 * the same round. The card never writes into the canvas itself: a canvas
 * write dispatched right before resolving is silently lost to the sync
 * push the resolution triggers (see AGENTS.md on pushes from inside
 * update()).
 *
 * @param {Object}  props
 * @param {string}  props.clientId        The block's client id.
 * @param {string}  props.blockName       The block's name.
 * @param {Array}   props.conflicts       The conflict group's open records
 *                                        (the whole section's when the
 *                                        block presents a section).
 * @param {?string} props.sectionClientId The section block's client id,
 *                                        or null outside a group (from
 *                                        useConflictGroup).
 */
export default function ConflictBlock( {
	clientId,
	blockName,
	conflicts,
	sectionClientId,
} ) {
	const blockProps = useBlockProps();
	const { postType, postId } = useCurrentPost();
	const resolve = useResolveConflict( postType, postId );
	const [ isReviewing, setIsReviewing ] = useState( false );

	// Accept: every record in the group takes the same replacement (the
	// group is one conflict to the reviewer), as serialized blocks.
	const accept = ( content ) => {
		for ( const conflict of conflicts ) {
			resolve( conflict.id, { action: 'accept', content } );
		}
		setIsReviewing( false );
	};

	let dialog = null;
	if ( isReviewing && 'core/table' === blockName ) {
		dialog = (
			<CollaborationTableMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ ( { head, body } ) =>
					accept(
						serialize( [
							createBlock( 'core/table', { head, body } ),
						] )
					)
				}
			/>
		);
	} else if ( isReviewing && sectionClientId ) {
		dialog = (
			<CollaborationSectionMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ accept }
			/>
		);
	} else if ( isReviewing ) {
		dialog = (
			<CollaborationMergeDialog
				onClose={ () => setIsReviewing( false ) }
				onAccept={ ( mergedText ) =>
					accept(
						serialize( [
							createBlock( 'core/paragraph', {
								content: mergedText,
							} ),
						] )
					)
				}
			/>
		);
	}

	// The clientId is the card's anchor for the engine-supplied contents
	// (plan Phase 3); it keeps the prop surface stable until then.
	void clientId;

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
