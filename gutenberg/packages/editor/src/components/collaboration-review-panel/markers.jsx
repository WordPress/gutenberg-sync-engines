import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import {
	store as blockEditorStore,
	privateApis as blockEditorPrivateApis,
} from '@wordpress/block-editor';
import { unlock } from '../../lock-unlock';
import {
	canRestoreItems,
	groupByUnit,
	useReviewData,
	useResolveReviewItems,
} from './review-data';

const { PrivateBlockPopover: BlockPopover } = unlock( blockEditorPrivateApis );

/**
 * An inline card for a parked NEW-block proposal, anchored where the block
 * would land. It shows who proposed it and the proposed content as inert
 * text (NEVER live DOM — the point of the approval gate is that this markup
 * has not been trusted), with Approve/Discard. Approve is reserved for
 * users who may publish it; others see why and can only Discard.
 */
/**
 * The content of an inline approval card (position-independent, so it can
 * be unit-tested without the block popover).
 *
 * @param {Object}   props
 * @param {Object}   props.item      The parked insertion review item.
 * @param {Function} props.onResolve ( items, resolution ) => void.
 */
export function InsertionCardBody( { item, onResolve } ) {
	const { blockType, html } = item.proposedInsertion;
	const restorable = canRestoreItems( [ item ] );

	return (
		<div className="editor-collaboration-insertion-card__body">
			<p className="editor-collaboration-insertion-card__attribution">
				{ item.isLocal
					? __( 'You proposed adding content that needs approval.' )
					: __(
							'A collaborator proposed adding content that needs approval.'
					  ) }
			</p>
			{ blockType && (
				<p className="editor-collaboration-insertion-card__type">
					{ blockType }
				</p>
			) }
			{ html && (
				// Inert text, never live DOM: the whole point of the
				// approval gate is that this markup has not been trusted.
				<pre className="editor-collaboration-insertion-card__preview">
					{ html }
				</pre>
			) }
			<div className="editor-collaboration-insertion-card__actions">
				{ restorable ? (
					<Button
						__next40pxDefaultSize
						size="compact"
						variant="primary"
						onClick={ () => onResolve( [ item ], 'restored' ) }
					>
						{ __( 'Approve' ) }
					</Button>
				) : (
					<span className="editor-collaboration-insertion-card__hint">
						{ __(
							'Only someone allowed to publish unfiltered HTML can approve this.'
						) }
					</span>
				) }
				<Button
					__next40pxDefaultSize
					size="compact"
					variant="tertiary"
					isDestructive
					onClick={ () => onResolve( [ item ], 'dismissed' ) }
				>
					{ __( 'Discard' ) }
				</Button>
			</div>
		</div>
	);
}

function InsertionCard( { clientId, placement, item, onResolve, contentRef } ) {
	return (
		<BlockPopover
			clientId={ clientId }
			placement={ placement }
			focusOnMount={ false }
			className="editor-collaboration-insertion-card"
			__unstableContentRef={ contentRef }
		>
			<InsertionCardBody item={ item } onResolve={ onResolve } />
		</BlockPopover>
	);
}

/**
 * In-canvas review surface for parked NEW-block proposals: an inline
 * approval card anchored where each proposed block would land. Conflicts
 * on EXISTING blocks are not marked here; those blocks render in place as
 * the conflict card (see the collaboration-conflict-block editor hook).
 * The document-sidebar panel remains a summary-only index over the same
 * items; only conflicts whose block or anchor no longer exists resolve
 * there.
 *
 * @param {Object} props
 * @param {Object} props.contentRef Ref to the editor content element, for
 *                                  popover scroll coupling.
 */
export default function CollaborationConflictMarkers( { contentRef } ) {
	const { postType, postId, items, clientIdByTarget } = useReviewData();
	const onResolve = useResolveReviewItems( postType, postId );
	const firstRootClientId = useSelect(
		( select ) => select( blockEditorStore ).getBlockOrder()[ 0 ] ?? null,
		[]
	);

	if ( ! items.length ) {
		return null;
	}

	// Parked insertions get their own inline card, positioned relative to
	// their anchor sibling (or the top of the canvas).
	const insertions = [];
	for ( const group of groupByUnit( items ) ) {
		const [ first ] = group;

		if ( ! first.proposedInsertion ) {
			continue;
		}

		const anchorId =
			clientIdByTarget[ first.proposedInsertion.afterSiblingId ];
		if ( anchorId ) {
			insertions.push( {
				clientId: anchorId,
				placement: 'bottom-start',
				item: first,
			} );
		} else if (
			! first.proposedInsertion.afterSiblingId &&
			firstRootClientId
		) {
			// Insert-at-top with a non-empty canvas.
			insertions.push( {
				clientId: firstRootClientId,
				placement: 'top-start',
				item: first,
			} );
		}
		// Anchor gone (or empty canvas): the sidebar panel covers it.
	}

	return (
		<>
			{ insertions.map( ( insertion ) => (
				<InsertionCard
					key={ insertion.item.id }
					clientId={ insertion.clientId }
					placement={ insertion.placement }
					item={ insertion.item }
					onResolve={ onResolve }
					contentRef={ contentRef }
				/>
			) ) }
		</>
	);
}
