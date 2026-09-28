import { addFilter } from '@wordpress/hooks';
import { createHigherOrderComponent } from '@wordpress/compose';
import ConflictBlock, {
	useConflictGroup,
} from '../components/collaboration-review-panel/conflict-block';

/**
 * Replace the edit UI of a conflict group's PRESENTER block with the
 * in-place conflict card, the way block recovery replaces an invalid
 * block. The presenter's content is read-only until the conflict is
 * reviewed, since its editable UI is not rendered at all. A block
 * outside any group presents its own conflicts; inside a group the
 * whole section's conflicts present once, on the section's first
 * conflicted block, and the section's other conflicted blocks keep
 * their normal edit UI (see useConflictGroup).
 *
 * @param {Component} BlockEdit Original component.
 *
 * @return {Component} Wrapped component.
 */
const withConflictReview = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const { items, isPresenter, sectionClientId } = useConflictGroup(
			props.clientId
		);

		if ( ! items.length || ! isPresenter ) {
			return <BlockEdit { ...props } />;
		}

		return (
			<ConflictBlock
				clientId={ props.clientId }
				blockName={ props.name }
				items={ items }
				sectionClientId={ sectionClientId }
			/>
		);
	},
	'withConflictReview'
);

addFilter(
	'editor.BlockEdit',
	'core/editor/collaboration-conflict-block',
	withConflictReview
);
