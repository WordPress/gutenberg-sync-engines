// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useIsInsideReviewSurface } from '../components/review-surface';
import { useTypingHold } from '../typing-hold';
import SequesteredBlock, {
	useBlockSequestrations,
} from '../components/sequestered-block';

/**
 * Replace the edit UI of a block held for security review with the
 * in-place sequestered card, the way block recovery replaces an invalid
 * block. A block is held when an engine published a `sequestration`
 * conflict targeting it, the kind every engine maps a wp_kses rejection
 * to. Merge conflicts present as the conflict card instead. The block's
 * content is read-only while held, since its editable UI is not rendered
 * at all.
 *
 * @param {Component} BlockEdit Original component.
 *
 * @return {Component} Wrapped component.
 */
const withKsesSequestration = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const conflicts = useBlockSequestrations( props.clientId );
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

		return <SequesteredBlock conflicts={ conflicts } />;
	},
	'withKsesSequestration'
);

addFilter(
	'editor.BlockEdit',
	'gutenberg-sync-engines/sequestered-block',
	withKsesSequestration
);
