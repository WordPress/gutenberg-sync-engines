/**
 * The hooks the panel and the cards read the current post's review state
 * with, and resolve it through. The pure helpers are in `./items.ts`.
 */

/**
 * WordPress dependencies
 */
import { useCallback } from '@wordpress/element';
import { useSelect } from '@wordpress/data';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-block-editor script.
import { store as blockEditorStore } from '@wordpress/block-editor';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-editor script.
import { store as editorStore } from '@wordpress/editor';

/**
 * Internal dependencies
 */
import type { SyncReviewItem } from '../../sync';
import { resolveReviewProposals, type ReviewResolution } from '../resolver';
import { store as reviewStore } from '../store';
import type { ResolveReviewItems } from './items';

const EMPTY_CLIENT_IDS: Record< string, string > = {};

/**
 * The current post as the sync manager addresses it.
 *
 * @return The entity's `kind/name` and record id (null before the post has one).
 */
export function useCurrentPostEntity(): {
	objectType: string;
	objectId: string | null;
} {
	return useSelect( ( select ) => {
		const { getCurrentPostType, getCurrentPostId } = select( editorStore );
		const postId = getCurrentPostId();
		return {
			objectType: `postType/${ getCurrentPostType() }`,
			objectId:
				null === postId || undefined === postId
					? null
					: String( postId ),
		};
	}, [] );
}

/**
 * The current post's review state: open review items, and a map from
 * each item's target block identity (syncId) to the block's clientId in the
 * editor, for anchoring conflicts to canvas blocks. Targets whose block no
 * longer exists are absent from the map.
 *
 * @return The post entity, review items, and block ID map.
 */
export function useReviewData() {
	const { objectType, objectId } = useCurrentPostEntity();
	const items = useSelect(
		( select ) =>
			select( reviewStore ).getReviewItems( objectType, objectId ),
		[ objectType, objectId ]
	);
	const clientIdByTarget = useSelect(
		( select ) => {
			// Resolve both on-block conflict targets AND the anchor sibling
			// of parked insertions (so an inline approval card can position
			// itself where the proposed block would land).
			const targetIds = items
				.flatMap( ( item ) => [
					item.targetId,
					item.proposedInsertion?.afterSiblingId,
				] )
				.filter( ( id ): id is string => Boolean( id ) );
			if ( ! targetIds.length ) {
				return EMPTY_CLIENT_IDS;
			}
			const { getClientIdsWithDescendants, getBlockAttributes } =
				select( blockEditorStore );
			const wanted = new Set( targetIds );
			const map: Record< string, string > = {};
			for ( const clientId of getClientIdsWithDescendants() ) {
				const syncId = getBlockAttributes( clientId )?.metadata?.syncId;
				if ( typeof syncId === 'string' && wanted.has( syncId ) ) {
					map[ syncId ] = clientId;
				}
			}
			return map;
		},
		[ items ]
	);

	return { objectType, objectId, items, clientIdByTarget };
}

/**
 * Returns a callback resolving a group of review items through the
 * plugin's sync manager.
 *
 * @param objectType The entity's `kind/name`.
 * @param objectId   The record id.
 * @return ( items, resolution ) => void.
 */
export function useResolveReviewItems(
	objectType: string,
	objectId: string | null
): ResolveReviewItems {
	return useCallback(
		( groupItems: SyncReviewItem[], resolution: ReviewResolution ) => {
			if ( objectId === null ) {
				return;
			}
			resolveReviewProposals(
				objectType,
				objectId,
				groupItems.map( ( item ) => item.id ),
				resolution
			);
		},
		[ objectType, objectId ]
	);
}
