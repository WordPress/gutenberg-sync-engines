/**
 * The review half of a loaded record's handlers: keeps the store's open
 * list current and tells the user, through the editor's notices, when an
 * edit was set aside. Ported from core-data's `sync-review.ts`, which
 * Gutenberg no longer carries.
 */

/**
 * WordPress dependencies
 */
import { dispatch as dataDispatch } from '@wordpress/data';
import { __, _n, sprintf } from '@wordpress/i18n';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-notices script.
import { store as noticesStore } from '@wordpress/notices';

/**
 * Internal dependencies
 */
import type { RecordHandlers } from '../sync';
import { resolveReviewProposals, type ReviewResolution } from './resolver';
import { registerReviewStore, store as reviewStore } from './store';

/** Above this many open items one counter notice replaces the per-item ones. */
const AGGREGATE_NOTICE_THRESHOLD = 3;

export type ReviewHandlers = Required<
	Pick< RecordHandlers, 'onProposalsChange' | 'onEscalation' >
>;

/**
 * Builds the review handlers of one record.
 *
 * @param objectType The entity's `kind/name`.
 * @param objectId   The record id.
 * @param dispatch   The data registry's dispatch; injectable for tests.
 * @return The handlers to spread over the record handlers.
 */
export function createReviewHandlers(
	objectType: string,
	objectId: string,
	dispatch: typeof dataDispatch = dataDispatch
): ReviewHandlers {
	const escalationNoticeId = ( proposalId: string ) =>
		`gutenberg-sync-engines-escalation-${ objectType }-${ objectId }-${ proposalId }`;
	const aggregateNoticeId = `gutenberg-sync-engines-review-aggregate-${ objectType }-${ objectId }`;
	let aggregateNoticeActive = false;
	let knownProposalIds: string[] = [];

	return {
		onProposalsChange: ( items ) => {
			registerReviewStore();
			dispatch( reviewStore ).setReviewItems(
				objectType,
				objectId,
				items
			);

			const notices = dispatch( noticesStore );
			const openIds = new Set( items.map( ( item ) => item.id ) );
			const useAggregate = items.length > AGGREGATE_NOTICE_THRESHOLD;

			if ( useAggregate && ! aggregateNoticeActive ) {
				// Entering aggregate mode: sweep per-item notices so they
				// don't stack under the counter notice.
				for ( const id of knownProposalIds ) {
					notices.removeNotice( escalationNoticeId( id ) );
				}
			}
			aggregateNoticeActive = useAggregate;

			if ( useAggregate ) {
				notices.createNotice(
					'warning',
					sprintf(
						/* translators: %d: number of edits set aside for review. */
						_n(
							'%d edit was set aside because of conflicting changes. Review it in the Collaboration panel of the document settings.',
							'%d edits were set aside because of conflicting changes. Review them in the Collaboration panel of the document settings.',
							items.length,
							'gutenberg-sync-engines'
						),
						items.length
					),
					{
						id: aggregateNoticeId,
						isDismissible: true,
					}
				);
			} else {
				notices.removeNotice( aggregateNoticeId );
				// Remove notices for proposals resolved elsewhere (another
				// collaborator, the review panel, or another tab).
				for ( const id of knownProposalIds ) {
					if ( ! openIds.has( id ) ) {
						notices.removeNotice( escalationNoticeId( id ) );
					}
				}
			}

			knownProposalIds = items.map( ( item ) => item.id );
		},
		onEscalation: ( { isLocal, proposalId, summary } ) => {
			// While aggregated, the counter notice and the review panel
			// carry the information; skip the per-item notice.
			if ( aggregateNoticeActive ) {
				return;
			}
			const base = isLocal
				? __(
						"One of your recent edits conflicted with a collaborator's change and was set aside.",
						'gutenberg-sync-engines'
				  )
				: __(
						"A collaborator's edit conflicted with recent changes and was set aside.",
						'gutenberg-sync-engines'
				  );
			const content = summary
				? sprintf(
						/* translators: 1: conflict description. 2: the lost content. */
						__(
							'%1$s Lost content: “%2$s”',
							'gutenberg-sync-engines'
						),
						base,
						summary
				  )
				: base;
			const noticeId = escalationNoticeId( proposalId );
			const close = ( resolution: ReviewResolution ) => {
				resolveReviewProposals(
					objectType,
					objectId,
					[ proposalId ],
					resolution
				);
				dispatch( noticesStore ).removeNotice( noticeId );
			};
			dispatch( noticesStore ).createNotice( 'warning', content, {
				id: noticeId,
				isDismissible: true,
				actions: [
					{
						label: __( 'Restore', 'gutenberg-sync-engines' ),
						onClick: () => close( 'restored' ),
					},
					{
						label: __( 'Discard', 'gutenberg-sync-engines' ),
						onClick: () => close( 'dismissed' ),
					},
				],
			} );
		},
	};
}
