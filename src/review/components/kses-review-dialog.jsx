// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { RevisionsCodeDiff, hasCodeDiff } from '../revisions-diff';
import { ChangedWhileReviewingNotice } from './merge-dialog';
import PlainTextDiff from './plain-text-diff';

/**
 * The dialog's content for reviewing a block held for security approval.
 *
 * The held markup shows as the revisions system's line-numbered code
 * diff. An UPDATE diffs from the original to the proposal in one unified
 * view (removed and added lines interleaved). A NEW-block proposal diffs
 * against nothing, so every line reads as added. Either shape offers
 * Approve, Remove block, and an Edit toggle opening the proposed markup
 * for plain-text editing below. The diff recomputes live while editing,
 * and Approve hands back the (possibly edited) markup.
 *
 * When the editor does not export that code diff (a standalone Gutenberg
 * without the bundled copy's addition), the same comparison shows as
 * plain text with the added and removed lines marked.
 *
 * The author can go on editing a held block while the dialog is open,
 * which changes the held markup. The dialog follows it while the reviewer
 * has not edited the markup themselves, and leaves their edit alone
 * otherwise. A notice says which: approving the older markup would drop
 * what the author wrote since.
 *
 * All held markup renders as inert text, never live DOM (the code diff
 * and its plain text stand-in both render lines as text). The point of
 * the approval gate is that this markup has not been trusted.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The hold (see sequestrationOf).
 * @param {Function} props.onApprove     ( proposedHtml ) => void.
 * @param {Function} props.onRemove      Remove the held block.
 */
export function KsesReviewDialogBody( { sequestration, onApprove, onRemove } ) {
	const [ proposedHtml, setProposedHtml ] = useState(
		sequestration.proposed
	);
	const [ isEditing, setIsEditing ] = useState( false );
	// Whether the reviewer has changed the markup by hand.
	const [ isEdited, setIsEdited ] = useState( false );
	// The held markup as the dialog last showed it, and what the dialog
	// did when it last changed: 'updated', 'kept', or null.
	const [ shownProposed, setShownProposed ] = useState(
		sequestration.proposed
	);
	const [ changeHandling, setChangeHandling ] = useState( null );
	const isUpdate = 'update' === sequestration.kind;

	if ( shownProposed !== sequestration.proposed ) {
		setShownProposed( sequestration.proposed );

		if ( isEdited ) {
			setChangeHandling( 'kept' );
		} else {
			setProposedHtml( sequestration.proposed );
			setChangeHandling( 'updated' );
		}
	}

	let original = null;
	if ( isUpdate ) {
		original = sequestration.original;
	}

	let codeDiff = (
		<PlainTextDiff isCode from={ original } to={ proposedHtml } />
	);
	if ( hasCodeDiff ) {
		let previousRevision = null;
		if ( isUpdate ) {
			previousRevision = { content: { raw: original } };
		}

		codeDiff = (
			<RevisionsCodeDiff
				revision={ { content: { raw: proposedHtml } } }
				previousRevision={ previousRevision }
				showDiff
				isPreviousRevisionLoading={ false }
			/>
		);
	}

	return (
		<div className="gse-review-kses-dialog__body">
			<p className="gse-review-kses-dialog__description">
				{ isUpdate
					? __(
							'This edit contains content that needs approval from someone allowed to publish unfiltered HTML.'
					  )
					: __(
							'This proposed block contains content that needs approval from someone allowed to publish unfiltered HTML.'
					  ) }
			</p>
			{ 'updated' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'The author changed this content while you were reviewing it. You now see the newer version.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			{ 'kept' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'The author changed this content while you were reviewing it. Your edit was kept, so it does not include their newer changes.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			<div className="gse-review-kses-dialog__pane">
				<h3 className="gse-review-kses-dialog__pane-label">
					{ isUpdate
						? __( 'Proposed changes' )
						: __( 'Proposed block' ) }
				</h3>
				<div className="gse-review-kses-dialog__code-diff">
					{ codeDiff }
				</div>
			</div>
			{ isEditing && (
				<div className="gse-review-kses-dialog__editor">
					<h3 className="gse-review-kses-dialog__pane-label">
						{ __( 'Edit proposed block' ) }
					</h3>
					<textarea
						className="gse-review-kses-dialog__editor-textarea"
						aria-label={ __( 'Proposed block HTML' ) }
						rows={ 6 }
						value={ proposedHtml }
						onChange={ ( event ) => {
							setProposedHtml( event.target.value );
							setIsEdited( true );
						} }
					/>
				</div>
			) }
			<div className="gse-review-kses-dialog__actions">
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
 * card. It shows the record's own held markup, and Approve hands back the
 * markup as reviewed (edited or not) for the engine to land.
 *
 * @param {Object}   props
 * @param {Object}   props.sequestration The hold (see sequestrationOf).
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
			className="gse-review-kses-dialog"
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
