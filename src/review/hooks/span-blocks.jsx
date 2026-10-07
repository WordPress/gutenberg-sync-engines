// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useDispatch } from '@wordpress/data';
import { useEffect } from '@wordpress/element';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { useIsInsideReviewSurface } from '../components/review-surface';
import { useTypingHold } from '../typing-hold';
import { useConflictContinuation } from '../components/review-data';

/**
 * Fold the rest of a record's span into its card. A record covering
 * several sibling blocks presents its card on the first block, and the
 * card shows the whole span: the preview, the dialog, and the decision
 * all cover every block of it. The blocks after the first are left out
 * of the canvas while the card is up, so the span reads as ONE
 * conflicted block, and none of its blocks can be edited, moved, or
 * removed on its own while a decision is pending. Example: a peer split
 * "Text.Here." while the author typed "Some " into it. The card is on
 * "Text." and shows both halves; "Here." is not drawn. The blocks are
 * still in the document (the list view shows them) and come back when
 * the record closes or the first block leaves the document.
 *
 * While the card waits for the author's typing, the blocks stay, so the
 * two appear together. Inside a review dialog's editors nothing is
 * folded: they show the record's sides, which carry the same ids.
 *
 * A folded block's editing mode is set to `disabled` for as long as it
 * is folded, so keyboard navigation and the list view cannot select a
 * block that has nothing to select in the canvas.
 *
 * @param {Component} BlockListBlock Original component.
 *
 * @return {Component} Wrapped component.
 */
export const withSpanBlocksFolded = createHigherOrderComponent(
	( BlockListBlock ) => ( props ) => {
		const continuation = useConflictContinuation( props.clientId );
		const isInsideReview = useIsInsideReviewSurface();
		const isHeld = useTypingHold(
			continuation?.firstClientId ?? props.clientId,
			! isInsideReview && true === continuation?.conflict.followsTyping
		);
		const isFolded = !! continuation && ! isInsideReview && ! isHeld;
		const {
			setBlockEditingMode,
			unsetBlockEditingMode,
			__unstableMarkNextChangeAsNotPersistent,
		} = useDispatch( blockEditorStore );

		useEffect( () => {
			if ( ! isFolded ) {
				return undefined;
			}
			__unstableMarkNextChangeAsNotPersistent();
			setBlockEditingMode( props.clientId, 'disabled' );
			return () => {
				__unstableMarkNextChangeAsNotPersistent();
				unsetBlockEditingMode( props.clientId );
			};
		}, [
			isFolded,
			props.clientId,
			setBlockEditingMode,
			unsetBlockEditingMode,
			__unstableMarkNextChangeAsNotPersistent,
		] );

		if ( isFolded ) {
			return null;
		}

		return <BlockListBlock { ...props } />;
	},
	'withSpanBlocksFolded'
);

addFilter(
	'editor.BlockListBlock',
	'gutenberg-sync-engines/span-blocks',
	withSpanBlocksFolded
);
