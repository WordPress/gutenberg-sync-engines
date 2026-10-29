// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useIsInsideReviewSurface } from '../components/review-surface';
import { useTypingHold } from '../typing-hold';
import ConflictBlock from '../components/conflict-block';
import SequesteredBlock from '../components/sequestered-block';
import { useBlockConflictsOfKind } from '../components/review-data';

/**
 * Replace the edit UI of a block under review with its card, the way
 * block recovery replaces an invalid block. A merge conflict gets the
 * conflict card; a block held for security review (a `sequestration`
 * record, the kind every engine maps a wp_kses rejection to) gets the
 * held card, and wins when a block has both. The block's content is
 * read-only until the record is reviewed, since its editable UI is not
 * rendered at all. A record covering several blocks presents on its
 * first block, whose card shows the whole span; the other blocks are
 * folded out of the canvas meanwhile (see span-blocks.jsx), so a
 * section reads as one conflicted block.
 *
 * @param {Component} BlockEdit Original component.
 *
 * @return {Component} Wrapped component.
 */
const withReviewCards = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const merges = useBlockConflictsOfKind( props.clientId, 'merge' );
		const holds = useBlockConflictsOfKind(
			props.clientId,
			'sequestration'
		);
		const conflicts = holds.length ? holds : merges;
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

		if ( holds.length ) {
			return <SequesteredBlock conflicts={ holds } />;
		}

		return (
			<ConflictBlock
				clientId={ props.clientId }
				blockName={ props.name }
				conflicts={ merges }
			/>
		);
	},
	'withReviewCards'
);

addFilter(
	'editor.BlockEdit',
	'gutenberg-sync-engines/review-cards',
	withReviewCards
);
