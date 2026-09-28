import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import SequesteredBlock, {
	useBlockSequestrations,
	useIsNewBlockProposal,
} from '../components/collaboration-review-panel/sequestered-block';
import {
	MOCK_KSES_NEW,
	MOCK_KSES_UPDATE,
} from '../components/collaboration-review-panel/mock-kses';

/**
 * Replace the edit UI of a block held for security review with the
 * in-place sequestered card, the way block recovery replaces an invalid
 * block. A block is held when an engine parked review items on it with
 * the `requires-approval` reason, the reason every engine maps a wp_kses
 * rejection to; other reasons present as the conflict card instead. The
 * block's content is read-only while held, since its editable UI is not
 * rendered at all.
 *
 * PROTOTYPE: the hold itself is real engine state, but the contents shown
 * are the fabricated mock scenarios (see mock-kses), picked by context: a
 * held block with no remaining content presents as a NEW-block proposal,
 * one that kept prior content as an UPDATE.
 *
 * @param {Component} BlockEdit Original component.
 *
 * @return {Component} Wrapped component.
 */
const withKsesSequestration = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const items = useBlockSequestrations( props.clientId );
		const isNewProposal = useIsNewBlockProposal( props.clientId );

		if ( ! items.length ) {
			return <BlockEdit { ...props } />;
		}

		return (
			<SequesteredBlock
				clientId={ props.clientId }
				items={ items }
				sequestration={
					isNewProposal ? MOCK_KSES_NEW : MOCK_KSES_UPDATE
				}
			/>
		);
	},
	'withKsesSequestration'
);

addFilter(
	'editor.BlockEdit',
	'core/editor/collaboration-sequestered-block',
	withKsesSequestration
);
