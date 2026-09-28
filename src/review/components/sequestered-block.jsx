// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { useState } from '@wordpress/element';
import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { getBlockContent } from '@wordpress/blocks';
import {
	store as blockEditorStore,
	useBlockProps,
} from '@wordpress/block-editor';
import { useOpenConflicts, useResolveConflict } from '../conflicts';
import KsesReviewDialog from './kses-review-dialog';
import {
	canApproveUnfilteredHtml,
	conflictsTargetingBlock,
	useCurrentPost,
} from './review-data';

const EMPTY_CONFLICTS = [];

/*
 * The replacement renders inside the editor canvas, where the admin
 * stylesheet carrying the dialog styles does not load (the block-recovery
 * Warning styles do), so it brings its own styles for the held-content
 * preview.
 */
const CANVAS_CSS = `
	.gse-review-sequestered-block__preview {
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
 * The open SECURITY-HOLD conflicts targeting a block: the records of kind
 * `sequestration`, the kind every engine maps a wp_kses rejection to.
 * Empty for an ordinary block. Merge conflicts present as the conflict
 * card instead (see useConflictGroup).
 *
 * @param {string} clientId The block's client id.
 * @return {Array} The block's open security-hold records.
 */
export function useBlockSequestrations( clientId ) {
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
			).filter( ( conflict ) => 'sequestration' === conflict.kind );

			if ( ! matches.length ) {
				return EMPTY_CONFLICTS;
			}

			return matches;
		},
		[ clientId, open ]
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
				<pre className="gse-review-sequestered-block__preview">
					{ sequestration.proposed }
				</pre>
			</div>
		</>
	);
}

/**
 * The in-place replacement for a block held for security review: rendered
 * INSTEAD of the block's edit UI (see the sequestered-block editor hook),
 * so the content is read-only while held. The review dialog opens from
 * here; its modal renders outside the canvas.
 *
 * Both decisions go to the ENGINE (`resolveConflict`): Approve accepts
 * the reviewed markup as content, Remove block accepts empty content
 * (the contract's "remove"). The card never writes into the canvas
 * itself: a canvas write dispatched right before resolving is silently
 * lost to the sync push the resolution triggers.
 *
 * @param {Object} props
 * @param {string} props.clientId      The block's client id.
 * @param {Array}  props.conflicts     The block's held records.
 * @param {Object} props.sequestration The held scenario (see mock-kses).
 */
export default function SequesteredBlock( {
	clientId,
	conflicts,
	sequestration,
} ) {
	const blockProps = useBlockProps();
	const { postType, postId } = useCurrentPost();
	const resolve = useResolveConflict( postType, postId );
	const [ isReviewing, setIsReviewing ] = useState( false );

	const accept = ( content ) => {
		for ( const conflict of conflicts ) {
			resolve( conflict.id, { action: 'accept', content } );
		}
		setIsReviewing( false );
	};

	// The clientId is the card's anchor for the engine-supplied contents
	// (plan Phase 3); it keeps the prop surface stable until then.
	void clientId;

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
					onApprove={ accept }
					onRemove={ () => accept( '' ) }
				/>
			) }
		</div>
	);
}
