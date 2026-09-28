import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { RevisionsCodeDiff } from '../post-revisions-preview/revisions-code-diff';

/**
 * The dialog's content for reviewing a block held for security approval.
 *
 * The held markup shows as the revisions system's line-numbered code
 * diff. An UPDATE diffs from the original to the proposal in one unified
 * view (removed and added lines interleaved); a NEW-block proposal diffs
 * against nothing, so every line reads as added. Either shape offers
 * Approve, Remove block, and an Edit toggle opening the proposed markup
 * for plain-text editing below; the diff recomputes live while editing,
 * and Approve hands back the (possibly edited) markup.
 *
 * All held markup renders as inert text, never live DOM (the code diff
 * renders lines as text). The point of the approval gate is that this
 * markup has not been trusted.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The held scenario (see mock-kses).
 * @param {Function} props.onApprove     ( proposedHtml ) => void.
 * @param {Function} props.onRemove      Remove the held block.
 */
export function KsesReviewDialogBody( { sequestration, onApprove, onRemove } ) {
	const [ proposedHtml, setProposedHtml ] = useState(
		sequestration.proposed
	);
	const [ isEditing, setIsEditing ] = useState( false );
	const isUpdate = 'update' === sequestration.kind;

	return (
		<div className="editor-collaboration-kses-dialog__body">
			<p className="editor-collaboration-kses-dialog__description">
				{ isUpdate
					? __(
							'This edit contains content that needs approval from someone allowed to publish unfiltered HTML.'
					  )
					: __(
							'This proposed block contains content that needs approval from someone allowed to publish unfiltered HTML.'
					  ) }
			</p>
			<div className="editor-collaboration-kses-dialog__pane">
				<h3 className="editor-collaboration-kses-dialog__pane-label">
					{ isUpdate
						? __( 'Proposed changes' )
						: __( 'Proposed block' ) }
				</h3>
				<div className="editor-collaboration-kses-dialog__code-diff">
					<RevisionsCodeDiff
						revision={ { content: { raw: proposedHtml } } }
						previousRevision={
							isUpdate
								? {
										content: {
											raw: sequestration.original,
										},
								  }
								: null
						}
						showDiff
						isPreviousRevisionLoading={ false }
					/>
				</div>
			</div>
			{ isEditing && (
				<div className="editor-collaboration-kses-dialog__editor">
					<h3 className="editor-collaboration-kses-dialog__pane-label">
						{ __( 'Edit proposed block' ) }
					</h3>
					<textarea
						className="editor-collaboration-kses-dialog__editor-textarea"
						aria-label={ __( 'Proposed block HTML' ) }
						rows={ 6 }
						value={ proposedHtml }
						onChange={ ( event ) =>
							setProposedHtml( event.target.value )
						}
					/>
				</div>
			) }
			<div className="editor-collaboration-kses-dialog__actions">
				<Button
					__next40pxDefaultSize
					variant="secondary"
					isPressed={ isEditing }
					onClick={ () => setIsEditing( ! isEditing ) }
				>
					{ __( 'Edit' ) }
				</Button>
				<Button
					__next40pxDefaultSize
					variant="tertiary"
					isDestructive
					onClick={ onRemove }
				>
					{ __( 'Remove block' ) }
				</Button>
				<Button
					__next40pxDefaultSize
					variant="primary"
					onClick={ () => onApprove( proposedHtml ) }
				>
					{ __( 'Approve' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The security review dialog, opened from a held block's "Review changes"
 * card. PROTOTYPE: the reviewed contents are the fabricated mock scenario
 * carried by the card, not the block's real held markup.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The held scenario (see mock-kses).
 * @param {Function} props.onApprove     ( proposedHtml ) => void.
 * @param {Function} props.onRemove      Remove the held block.
 * @param {Function} props.onClose       Close without resolving.
 */
export default function KsesReviewDialog( {
	sequestration,
	onApprove,
	onRemove,
	onClose,
} ) {
	return (
		<Modal
			title={ __( 'Review proposed changes' ) }
			onRequestClose={ onClose }
			className="editor-collaboration-kses-dialog"
			size="large"
		>
			<KsesReviewDialogBody
				sequestration={ sequestration }
				onApprove={ onApprove }
				onRemove={ onRemove }
			/>
		</Modal>
	);
}
