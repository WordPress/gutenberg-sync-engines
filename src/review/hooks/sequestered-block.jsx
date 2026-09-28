// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import SequesteredBlock, {
	useBlockSequestrations,
	useIsNewBlockProposal,
} from '../components/sequestered-block';
import { MOCK_KSES_NEW, MOCK_KSES_UPDATE } from '../components/mock-kses';

/**
 * Replace the edit UI of a block held for security review with the
 * in-place sequestered card, the way block recovery replaces an invalid
 * block. A block is held when an engine published a `sequestration`
 * conflict targeting it, the kind every engine maps a wp_kses rejection
 * to; merge conflicts present as the conflict card instead. The block's
 * content is read-only while held, since its editable UI is not rendered
 * at all.
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
		const conflicts = useBlockSequestrations( props.clientId );
		const isNewProposal = useIsNewBlockProposal( props.clientId );

		if ( ! conflicts.length ) {
			return <BlockEdit { ...props } />;
		}

		return (
			<SequesteredBlock
				clientId={ props.clientId }
				conflicts={ conflicts }
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
	'gutenberg-sync-engines/sequestered-block',
	withKsesSequestration
);
