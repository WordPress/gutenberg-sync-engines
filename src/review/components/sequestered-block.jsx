// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { useBlockProps } from '@wordpress/block-editor';
import KsesReviewDialog from './kses-review-dialog';
import { canApproveUnfilteredHtml, useDecideConflict } from './review-data';

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
 * A security hold as the review card and dialog present it: the held
 * markup, and what it would replace. A record with no base content (a
 * block the base did not hold, or held nothing in) reads as a brand-new
 * proposal, and one with base content as an update to it.
 *
 * @param {Object} conflict The conflict record.
 * @return {Object} `{ kind, original, proposed }`.
 */
export function sequestrationOf( conflict ) {
	const original = conflict.base ?? '';
	const hasOriginal =
		'' !==
		original.replace( /<!--[\s\S]*?-->/g, ' ' ).replace( /\s+/g, '' );

	return {
		kind: hasOriginal ? 'update' : 'new',
		original,
		proposed: conflict.proposed,
	};
}

/**
 * The body of the in-place replacement for a block held for security
 * review, styled like block recovery: one warning box holding the message,
 * the "Review changes" action for users allowed to approve, and, below
 * them, the held content as inert text. NEVER live DOM, since the point of
 * the approval gate is that this markup has not been trusted.
 *
 * Position-independent so it can be unit-tested without the block editor.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The hold (see sequestrationOf).
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
 * here. Its modal renders outside the canvas.
 *
 * Both decisions go to the ENGINE (`resolveConflict`): Approve accepts
 * the reviewed markup as content, Remove block accepts empty content
 * (the contract's "remove"). The card never writes into the canvas
 * itself: a canvas write dispatched right before resolving is silently
 * lost to the sync push the resolution triggers.
 *
 * When several records hold the block, the card presents the first.
 * The next one takes its place once it is decided.
 *
 * @param {Object} props
 * @param {Array}  props.conflicts The block's held records.
 */
export default function SequesteredBlock( { conflicts } ) {
	const blockProps = useBlockProps();
	const decide = useDecideConflict();
	const [ isReviewing, setIsReviewing ] = useState( false );
	const [ conflict ] = conflicts;
	const sequestration = sequestrationOf( conflict );

	const accept = ( content ) => {
		decide( conflict, { action: 'accept', content } );
		setIsReviewing( false );
	};

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
