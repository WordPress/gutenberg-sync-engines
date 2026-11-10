/**
 * WordPress dependencies
 */
import { useDispatch } from '@wordpress/data';
import { __, _n, sprintf } from '@wordpress/i18n';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-block-editor script.
import { store as blockEditorStore } from '@wordpress/block-editor';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-editor script.
import { PluginDocumentSettingPanel } from '@wordpress/editor';

/**
 * Internal dependencies
 */
import ReviewGroup from './review-group';
import { groupByUnit, itemAnchorClientId } from './items';
import { useReviewData, useResolveReviewItems } from './review-data';

/** The panel's name in the document settings (and its preference key). */
export const PANEL_NAME = 'gutenberg-sync-engines-review';

/**
 * A summary-only index of edits that were set aside for review after a
 * sync conflict (open proposals), in the document settings. Resolution
 * happens at the inline block card in the canvas — an anchored conflict
 * here is a link that navigates to its block. Only conflicts whose block
 * no longer exists carry their Adopt/Reject verbs in the panel, since they
 * have no card to resolve at. Absent while nothing is set aside.
 */
export default function CollaborationReviewPanel() {
	const { objectType, objectId, items, clientIdByTarget } = useReviewData();
	const onResolve = useResolveReviewItems( objectType, objectId );
	const { selectBlock, flashBlock } = useDispatch( blockEditorStore );

	if ( ! items.length ) {
		return null;
	}

	const groups = groupByUnit( items );

	return (
		<PluginDocumentSettingPanel
			name={ PANEL_NAME }
			title={ sprintf(
				/* translators: %d: number of conflicting edits awaiting review. */
				__( 'Collaboration conflicts (%d)', 'gutenberg-sync-engines' ),
				items.length
			) }
			className="gse-review-panel"
		>
			<p className="gse-review-panel__description">
				{ _n(
					'This edit conflicted with a collaborator’s changes and was set aside. Review it at its block.',
					'These edits conflicted with collaborators’ changes and were set aside. Review them at their blocks.',
					items.length,
					'gutenberg-sync-engines'
				) }
			</p>
			{ groups.map( ( groupItems ) => {
				const clientId = itemAnchorClientId( groupItems[ 0 ], {
					clientIdByTarget,
				} );
				return (
					<ReviewGroup
						key={ groupItems[ 0 ].unitId }
						items={ groupItems }
						onResolve={ onResolve }
						summaryOnly={ !! clientId }
						onNavigate={
							clientId
								? () => {
										// Selection scrolls the canvas to
										// the block; the flash points at it.
										selectBlock( clientId );
										flashBlock( clientId, 500 );
								  }
								: undefined
						}
					/>
				);
			} ) }
		</PluginDocumentSettingPanel>
	);
}
