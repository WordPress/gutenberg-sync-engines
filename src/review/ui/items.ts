/**
 * The pure pieces of the review UI: the reason copy, the capability hint,
 * grouping, anchoring, and which cards a block carries. No editor state is
 * read here, so the panel and the cards can be tested without one.
 */

/**
 * WordPress dependencies
 */
import { __ } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import type { SyncReviewItem } from '../../sync';
import type { ReviewResolution } from '../resolver';

export type ResolveReviewItems = (
	items: SyncReviewItem[],
	resolution: ReviewResolution
) => void;

declare global {
	interface Window {
		_wpCollaborationCanUnfilteredHtml?: boolean;
	}
}

export const REASON_LABELS: Record< string, string > = {
	'frame-conflict': __(
		'It conflicted with a collaborator’s change.',
		'gutenberg-sync-engines'
	),
	'dependent-on-escalated': __(
		'It depended on another edit that was set aside.',
		'gutenberg-sync-engines'
	),
	'requires-approval': __(
		'It contains content that needs approval from someone allowed to publish unfiltered HTML.',
		'gutenberg-sync-engines'
	),
};

/**
 * Whether the current user may restore a group of review items. Restoring
 * a requires-approval conflict IS the approval (the content re-publishes
 * under the restorer's account), so it is reserved for users who can
 * publish unfiltered HTML. UI hint only — ingest re-enforces per the
 * authoring user's capability regardless.
 *
 * @param items The group's review items.
 * @return Whether restore is available.
 */
export function canRestoreItems( items: SyncReviewItem[] ): boolean {
	return (
		items.every( ( item ) => 'requires-approval' !== item.reason ) ||
		false !== window._wpCollaborationCanUnfilteredHtml
	);
}

/**
 * Groups review items by their unit (a batch of edits made together), so a
 * burst of typing reads as one conflict with one set of actions.
 *
 * @param items Review items.
 * @return Groups of items sharing a unitId.
 */
export function groupByUnit( items: SyncReviewItem[] ): SyncReviewItem[][] {
	const groups = new Map< string, SyncReviewItem[] >();
	for ( const item of items ) {
		if ( ! groups.has( item.unitId ) ) {
			groups.set( item.unitId, [] );
		}
		groups.get( item.unitId )!.push( item );
	}
	return Array.from( groups.values() );
}

/**
 * The clientId a review item anchors to in the canvas, or undefined for an
 * unanchored item (its block no longer exists, or it targets no block).
 * The target is the block's persistent identity (`targetId`/syncId).
 *
 * @param item                  Review item.
 * @param maps                  The maps returned by useReviewData.
 * @param maps.clientIdByTarget syncId → clientId.
 * @return Anchor clientId.
 */
export function itemAnchorClientId(
	item: SyncReviewItem,
	{ clientIdByTarget }: { clientIdByTarget: Record< string, string > }
): string | undefined {
	if ( item.targetId ) {
		return clientIdByTarget[ item.targetId ];
	}
	return undefined;
}

/** The cards one block carries. */
export interface BlockMarkers {
	/** Groups of on-block conflicts targeting the block. */
	groups: SyncReviewItem[][];
	/** Parked insertions anchored to the block, with their side. */
	insertions: {
		placement: 'bottom-start' | 'top-start';
		item: SyncReviewItem;
	}[];
}

export const NO_MARKERS: BlockMarkers = { groups: [], insertions: [] };

/**
 * The markers of one block, from the current post's review items: the
 * conflicts whose target is the block, the insertions whose anchor sibling
 * is the block (card below it), and, for the first root block, the
 * insertions at the top of the document (card above it). An insertion
 * whose anchor is gone, and every insertion on an empty canvas, has no
 * card; the sidebar panel covers it.
 *
 * @param items            The post's open review items.
 * @param clientIdByTarget syncId → clientId.
 * @param clientId         The block.
 * @param isFirstRootBlock Whether the block is the first root block.
 * @return The block's markers (`NO_MARKERS` when none).
 */
export function selectBlockMarkers(
	items: SyncReviewItem[],
	clientIdByTarget: Record< string, string >,
	clientId: string,
	isFirstRootBlock: boolean
): BlockMarkers {
	if ( ! items.length ) {
		return NO_MARKERS;
	}
	const groups: SyncReviewItem[][] = [];
	const insertions: BlockMarkers[ 'insertions' ] = [];
	for ( const group of groupByUnit( items ) ) {
		const [ first ] = group;
		if ( first.proposedInsertion ) {
			const { afterSiblingId } = first.proposedInsertion;
			if ( afterSiblingId ) {
				if ( clientIdByTarget[ afterSiblingId ] === clientId ) {
					insertions.push( {
						placement: 'bottom-start',
						item: first,
					} );
				}
			} else if ( isFirstRootBlock ) {
				insertions.push( { placement: 'top-start', item: first } );
			}
			continue;
		}
		if (
			first.targetId &&
			clientIdByTarget[ first.targetId ] === clientId
		) {
			groups.push( group );
		}
	}
	return groups.length || insertions.length
		? { groups, insertions }
		: NO_MARKERS;
}
