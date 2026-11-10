/**
 * WordPress dependencies
 */
import { __, sprintf } from '@wordpress/i18n';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-components script.
import { Button } from '@wordpress/components';

/**
 * Internal dependencies
 */
import type { SyncReviewItem } from '../../sync';
import {
	canRestoreItems,
	REASON_LABELS,
	type ResolveReviewItems,
} from './items';

/**
 * One conflict group (a unit of edits set aside together): attribution,
 * reason, and the lost content. Resolution verbs are Adopt (take the set-
 * aside edit) and Reject (discard it) — the pending-edit vocabulary. When
 * `onNavigate` is given, the attribution becomes a link to the conflicted
 * block. With `summaryOnly` the group renders no verbs: it is an index
 * entry, and resolution happens at the inline block card.
 *
 * @param props
 * @param props.items         The group's review items.
 * @param props.onResolve     ( items, resolution ) => void.
 * @param [props.onNavigate]  Jump to the conflicted block.
 * @param [props.summaryOnly] Render without resolution verbs.
 */
export default function ReviewGroup( {
	items,
	onResolve,
	onNavigate,
	summaryOnly,
}: {
	items: SyncReviewItem[];
	onResolve: ResolveReviewItems;
	onNavigate?: () => void;
	summaryOnly?: boolean;
} ) {
	const [ first ] = items;
	const attribution = first.isLocal
		? __( 'One of your edits was set aside.', 'gutenberg-sync-engines' )
		: __(
				'A collaborator’s edit was set aside.',
				'gutenberg-sync-engines'
		  );
	const restorable = canRestoreItems( items );
	const isApproval = 'requires-approval' === first.reason;
	let reason = REASON_LABELS[ first.reason ];
	if ( isApproval && ! summaryOnly ) {
		reason = restorable
			? `${ reason } ${ __(
					'Adopting it publishes the content under your account.',
					'gutenberg-sync-engines'
			  ) }`
			: `${ reason } ${ __(
					'Only someone allowed to publish unfiltered HTML can adopt it.',
					'gutenberg-sync-engines'
			  ) }`;
	}
	const summaries = items
		.map( ( item ) => item.summary ?? item.excerpt )
		.filter( Boolean );

	return (
		<div className="gse-review-panel__item">
			<p className="gse-review-panel__attribution">
				{ onNavigate ? (
					<Button
						__next40pxDefaultSize
						variant="link"
						onClick={ onNavigate }
						label={ __(
							'Go to the conflicted block',
							'gutenberg-sync-engines'
						) }
						showTooltip
					>
						{ attribution }
					</Button>
				) : (
					attribution
				) }{ ' ' }
				{ reason }
			</p>
			{ summaries.length > 0 && (
				<p className="gse-review-panel__summary">
					{ sprintf(
						/* translators: %s: the content of the edit that was set aside. */
						__( 'Lost content: “%s”', 'gutenberg-sync-engines' ),
						summaries.join( ' ' )
					) }
				</p>
			) }
			{ ! summaryOnly && (
				<div className="gse-review-panel__actions">
					{ restorable && (
						<Button
							__next40pxDefaultSize
							size="compact"
							variant="secondary"
							onClick={ () => onResolve( items, 'restored' ) }
						>
							{ __( 'Adopt', 'gutenberg-sync-engines' ) }
						</Button>
					) }
					<Button
						__next40pxDefaultSize
						size="compact"
						variant="tertiary"
						isDestructive
						onClick={ () => onResolve( items, 'dismissed' ) }
					>
						{ __( 'Reject', 'gutenberg-sync-engines' ) }
					</Button>
				</div>
			) }
		</div>
	);
}
