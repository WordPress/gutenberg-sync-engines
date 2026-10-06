// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useIsInsideReviewSurface } from '../components/review-surface';
import { useTypingHold } from '../typing-hold';
import ConflictBlock, { useBlockConflicts } from '../components/conflict-block';

/**
 * Replace the edit UI of a conflicted block with the in-place conflict
 * card, the way block recovery replaces an invalid block. The block's
 * content is read-only until the conflict is reviewed, since its editable
 * UI is not rendered at all. A record covering several blocks presents on
 * its first block. The others keep their normal edit UI, so a section
 * reads as a single conflict rather than a wall of cards.
 *
 * @param {Component} BlockEdit Original component.
 *
 * @return {Component} Wrapped component.
 */
const withConflictReview = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const conflicts = useBlockConflicts( props.clientId );
		// The dialogs' own editors show the record's sides, never cards.
		const isInsideReview = useIsInsideReviewSurface();
		// The card waits while the person is still typing in the block,
		// when the engine keeps the record up with that typing.
		const isHeld = useTypingHold(
			props.clientId,
			! isInsideReview && true === conflicts[ 0 ]?.followsTyping
		);

		if ( ! conflicts.length || isInsideReview || isHeld ) {
			return <BlockEdit { ...props } />;
		}

		return (
			<ConflictBlock
				clientId={ props.clientId }
				blockName={ props.name }
				conflicts={ conflicts }
			/>
		);
	},
	'withConflictReview'
);

addFilter(
	'editor.BlockEdit',
	'gutenberg-sync-engines/conflict-block',
	withConflictReview
);
