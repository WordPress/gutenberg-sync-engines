import { useState } from '@wordpress/element';
import { useSelect, useDispatch } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { getBlockContent } from '@wordpress/blocks';
import { store as coreStore } from '@wordpress/core-data';
import {
	store as blockEditorStore,
	useBlockProps,
} from '@wordpress/block-editor';
import { store as editorStore } from '../../store';
import { unlock } from '../../lock-unlock';
import KsesReviewDialog from './kses-review-dialog';
import {
	canApproveUnfilteredHtml,
	itemsTargetingBlock,
	useResolveReviewItems,
} from './review-data';

const EMPTY_ITEMS = [];

/*
 * The replacement renders inside the editor canvas, where the admin
 * stylesheet carrying the review panel's styles does not load (the
 * block-recovery Warning styles do), so it brings its own styles for the
 * held-content preview.
 */
const CANVAS_CSS = `
	.editor-collaboration-sequestered-block__preview {
		background: #f0f0f0;
		border-radius: 2px;
		box-sizing: border-box;
		font-size: 13px;
		margin: 12px 0 0;
		max-height: 12em;
		overflow: auto;
		padding: 8px;
		white-space: pre-wrap;
		width: 100%;
		word-break: break-word;
	}
`;

/**
 * The open SECURITY-HOLD review items targeting a block: the items parked
 * with the `requires-approval` reason, the reason every engine maps a
 * wp_kses rejection to. Empty for an ordinary block. Other reasons present
 * as the conflict card instead (see useConflictGroup).
 *
 * @param {string} clientId The block's client id.
 * @return {Array} The block's open security-hold review items.
 */
export function useBlockSequestrations( clientId ) {
	return useSelect(
		( select ) => {
			const { getCurrentPostType, getCurrentPostId } =
				select( editorStore );
			const postType = getCurrentPostType();
			const postId = getCurrentPostId();

			if ( ! postType || ! postId ) {
				return EMPTY_ITEMS;
			}

			const items = unlock( select( coreStore ) ).getSyncReviewItems(
				'postType',
				postType,
				postId
			);

			if ( ! items.length ) {
				return EMPTY_ITEMS;
			}

			const matches = itemsTargetingBlock(
				select,
				items,
				clientId
			).filter( ( item ) => 'requires-approval' === item.reason );

			if ( ! matches.length ) {
				return EMPTY_ITEMS;
			}

			return matches;
		},
		[ clientId ]
	);
}

/**
 * Whether a held block reads as a brand-new proposal rather than an
 * update to prior content. The engines park the risky markup and leave
 * the block at its last approved state, so a held block with no remaining
 * content has no meaningful original to compare against: present it as a
 * new proposal. A held block that kept prior content presents as an
 * update.
 *
 * Content is judged from the `content` attribute when the block has one
 * (paragraphs, legacy core/html), and from the block's inner markup
 * otherwise (raw-content blocks like core/html keep their markup in
 * innerContent, not in an attribute). Markup tags and the sync engines'
 * object placeholder character do not count as content.
 *
 * @param {string} clientId The block's client id.
 * @return {boolean} Whether to present the new-proposal scenario.
 */
export function useIsNewBlockProposal( clientId ) {
	return useSelect(
		( select ) => {
			const block = select( blockEditorStore ).getBlock( clientId );

			if ( ! block ) {
				return true;
			}

			if ( undefined !== block.attributes?.content ) {
				return ! String( block.attributes.content ).trim();
			}

			let inner = '';
			try {
				inner = getBlockContent( block );
			} catch {
				inner = '';
			}

			return ! inner
				.replace( /<[^>]*>/g, ' ' )
				.replace( /￼/g, '' )
				.trim();
		},
		[ clientId ]
	);
}

/**
 * The body of the in-place replacement for a block held for security
 * review, styled like block recovery: one warning box holding the message,
 * the "Review changes" action for users allowed to approve, and, below
 * them, the held content as inert text. NEVER live DOM, since the point of
 * the approval gate is that this markup has not been trusted. PROTOTYPE:
 * the content shown is the fabricated mock scenario, not the block's real
 * held markup.
 *
 * Position-independent so it can be unit-tested without the block editor.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The held scenario (see mock-kses).
 * @param {boolean}  props.canReview     Whether the user may review it.
 * @param {Function} props.onReview      Open the review dialog.
 */
export function SequesteredBlockBody( { sequestration, canReview, onReview } ) {
	return (
		<>
			<style>{ CANVAS_CSS }</style>
			<div className="block-editor-warning">
				<div className="block-editor-warning__contents">
					<p className="block-editor-warning__message">
						{ __( 'This block requires elevated permissions.' ) }
					</p>
					{ canReview && (
						<div className="block-editor-warning__actions">
							<span className="block-editor-warning__action">
								<Button
									__next40pxDefaultSize
									variant="primary"
									onClick={ onReview }
								>
									{ __( 'Review changes' ) }
								</Button>
							</span>
						</div>
					) }
				</div>
				<pre className="editor-collaboration-sequestered-block__preview">
					{ sequestration.proposed }
				</pre>
			</div>
		</>
	);
}

/**
 * The in-place replacement for a block held for security review: rendered
 * INSTEAD of the block's edit UI (see the collaboration-sequestered-block
 * editor hook), so the content is read-only while held. The review dialog
 * opens from here; its modal renders outside the canvas.
 *
 * @param {Object} props
 * @param {string} props.clientId      The block's client id.
 * @param {Array}  props.items         The block's held review items.
 * @param {Object} props.sequestration The held scenario (see mock-kses).
 */
export default function SequesteredBlock( { clientId, items, sequestration } ) {
	const blockProps = useBlockProps();
	const { postType, postId } = useSelect( ( select ) => {
		const { getCurrentPostType, getCurrentPostId } = select( editorStore );

		return {
			postType: getCurrentPostType(),
			postId: getCurrentPostId(),
		};
	}, [] );
	const onResolve = useResolveReviewItems( postType, postId );
	const { removeBlock } = useDispatch( blockEditorStore );
	const [ isReviewing, setIsReviewing ] = useState( false );

	return (
		<div { ...blockProps }>
			<SequesteredBlockBody
				sequestration={ sequestration }
				canReview={ canApproveUnfilteredHtml() }
				onReview={ () => setIsReviewing( true ) }
			/>
			{ isReviewing && (
				<KsesReviewDialog
					sequestration={ sequestration }
					onClose={ () => setIsReviewing( false ) }
					onApprove={ () => {
						// Approving goes through the engine's restore lane:
						// each parked item re-authors its REAL held markup
						// as an ordinary edit under the approver's account,
						// so the content lands for every collaborator.
						// Writing markup into the canvas here instead does
						// NOT work: resolving triggers a sync push that
						// rebuilds the canvas from the canonical document
						// before the capture delay picks the write up, and
						// the write is silently lost. For the same reason
						// the dialog's hand-edited markup is display-only
						// for now; honoring it needs an engine verb.
						onResolve( items, 'restored' );
						setIsReviewing( false );
					} }
					onRemove={ () => {
						// Remove the block first and resolve only after the
						// capture delay (1.2 s) has folded the removal into
						// the outbox. Resolving immediately triggers a sync
						// push that rebuilds the canvas from the canonical
						// document, which still holds the block, and a
						// pre-capture removal would be silently undone.
						removeBlock( clientId );
						// Deliberately NOT cancelled on unmount: removing
						// the block unmounts this card immediately, and the
						// deferred resolution must still run.
						// eslint-disable-next-line @wordpress/react-no-unsafe-timeout
						setTimeout(
							() => onResolve( items, 'dismissed' ),
							2500
						);
						setIsReviewing( false );
					} }
				/>
			) }
		</div>
	);
}
