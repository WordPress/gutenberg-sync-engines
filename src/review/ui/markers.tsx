/**
 * In-canvas review surface: an inline pending-edit card on every block
 * whose edits were set aside (ONE merged card per block — the primary
 * resolution surface), plus an inline card for each parked new-block
 * proposal, anchored where the block would land. The document-sidebar
 * panel is a summary-only index over the same items; only conflicts whose
 * block or anchor no longer exists resolve there.
 *
 * The cards hang off each block's edit component through the public
 * `editor.BlockEdit` filter, so the block popover renders inside the block
 * list and can find its block's element; a plugin has no other way into
 * the canvas.
 */

/**
 * WordPress dependencies
 */
import { createHigherOrderComponent } from '@wordpress/compose';
import { useSelect } from '@wordpress/data';
import { addFilter } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-components script.
import { Button } from '@wordpress/components';
import {
	store as blockEditorStore,
	privateApis as blockEditorPrivateApis,
	// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-block-editor script.
} from '@wordpress/block-editor';

/**
 * Internal dependencies
 */
import { unlock } from '../../lock-unlock';
import type { SyncReviewItem } from '../../sync';
import {
	canRestoreItems,
	NO_MARKERS,
	REASON_LABELS,
	selectBlockMarkers,
	type BlockMarkers,
	type ResolveReviewItems,
} from './items';
import { useReviewData, useResolveReviewItems } from './review-data';

type Placement = 'top-end' | 'bottom-start' | 'top-start';

interface BlockPopoverProps {
	clientId: string;
	placement: Placement;
	focusOnMount: boolean;
	className: string;
	__unstablePopoverSlot: string;
	children: JSX.Element;
}

/**
 * The block tools' popover slot in the admin document. Without a slot the
 * block popover renders in place, which from a block's edit component
 * means inside the canvas iframe, where the plugin's stylesheet does not
 * reach; through the slot the card lands beside the block toolbar, like
 * the editor's own block popovers.
 */
const POPOVER_SLOT = '__unstable-block-tools-after';

/**
 * The content of the inline pending-edit card: ONE merged task per block
 * (the prototype's merge-not-stack decision), no count chip, and the two
 * verbs — Adopt takes the set-aside edit, Reject discards it. Adopting a
 * requires-approval edit is reserved for users who may publish unfiltered
 * HTML. Position-independent so it can be unit-tested without the block
 * popover.
 *
 * @param props
 * @param props.groups    Every review group targeting the block.
 * @param props.onResolve ( items, resolution ) => void.
 */
export function BlockCardBody( {
	groups,
	onResolve,
}: {
	groups: SyncReviewItem[][];
	onResolve: ResolveReviewItems;
} ) {
	const items = groups.flat();
	const allLocal = items.every( ( item ) => item.isLocal );
	const restorable = canRestoreItems( items );
	const reasons = Array.from(
		new Set(
			items
				.map( ( item ) => REASON_LABELS[ item.reason ] )
				.filter( Boolean )
		)
	);
	const summaries = items
		.map( ( item ) => item.summary ?? item.excerpt )
		.filter( Boolean );

	return (
		<div className="gse-review-pending-card__body">
			<p className="gse-review-pending-card__attribution">
				{ allLocal
					? __(
							'Your edit on this block is pending.',
							'gutenberg-sync-engines'
					  )
					: __(
							'A collaborator’s edit on this block is pending.',
							'gutenberg-sync-engines'
					  ) }{ ' ' }
				{ reasons.join( ' ' ) }
			</p>
			{ summaries.length > 0 && (
				<p className="gse-review-pending-card__summary">
					{ sprintf(
						/* translators: %s: the content of the edit that is pending. */
						__( 'Pending content: “%s”', 'gutenberg-sync-engines' ),
						summaries.join( ' ' )
					) }
				</p>
			) }
			<div className="gse-review-pending-card__actions">
				{ restorable ? (
					<Button
						__next40pxDefaultSize
						size="compact"
						variant="primary"
						onClick={ () => onResolve( items, 'restored' ) }
					>
						{ __( 'Adopt', 'gutenberg-sync-engines' ) }
					</Button>
				) : (
					<span className="gse-review-pending-card__hint">
						{ __(
							'Only someone allowed to publish unfiltered HTML can adopt this.',
							'gutenberg-sync-engines'
						) }
					</span>
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
		</div>
	);
}

/**
 * The content of an inline approval card for a parked NEW-block proposal.
 * It shows who proposed it and the proposed content as inert text (NEVER
 * live DOM — the point of the approval gate is that this markup has not
 * been trusted), with Approve/Discard. Approve is reserved for users who
 * may publish it; others see why and can only Discard. Position-independent
 * so it can be unit-tested without the block popover.
 *
 * @param props
 * @param props.item      The parked insertion review item.
 * @param props.onResolve ( items, resolution ) => void.
 */
export function InsertionCardBody( {
	item,
	onResolve,
}: {
	item: SyncReviewItem;
	onResolve: ResolveReviewItems;
} ) {
	const { blockType, html } = item.proposedInsertion!;
	const restorable = canRestoreItems( [ item ] );

	return (
		<div className="gse-review-insertion-card__body">
			<p className="gse-review-insertion-card__attribution">
				{ item.isLocal
					? __(
							'You proposed adding content that needs approval.',
							'gutenberg-sync-engines'
					  )
					: __(
							'A collaborator proposed adding content that needs approval.',
							'gutenberg-sync-engines'
					  ) }
			</p>
			{ blockType && (
				<p className="gse-review-insertion-card__type">{ blockType }</p>
			) }
			{ html && (
				// Inert text, never live DOM: the whole point of the
				// approval gate is that this markup has not been trusted.
				<pre className="gse-review-insertion-card__preview">
					{ html }
				</pre>
			) }
			<div className="gse-review-insertion-card__actions">
				{ restorable ? (
					<Button
						__next40pxDefaultSize
						size="compact"
						variant="primary"
						onClick={ () => onResolve( [ item ], 'restored' ) }
					>
						{ __( 'Approve', 'gutenberg-sync-engines' ) }
					</Button>
				) : (
					<span className="gse-review-insertion-card__hint">
						{ __(
							'Only someone allowed to publish unfiltered HTML can approve this.',
							'gutenberg-sync-engines'
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
					{ __( 'Discard', 'gutenberg-sync-engines' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The block popover, when the editor exposes it. Resolved once, lazily,
 * so importing this module never throws on an editor without it.
 */
function getBlockPopover():
	| ( ( props: BlockPopoverProps ) => JSX.Element | null )
	| undefined {
	try {
		return unlock( blockEditorPrivateApis ).PrivateBlockPopover;
	} catch {
		return undefined;
	}
}

interface BlockEditProps {
	clientId: string;
	attributes?: { metadata?: { syncId?: unknown } } & Record<
		string,
		unknown
	>;
	[ key: string ]: unknown;
}

type BlockEditComponent = ( props: BlockEditProps ) => JSX.Element;

/**
 * The cards of one block, rendered beside its edit component.
 *
 * @param props
 * @param props.clientId The block.
 * @param props.markers  Its markers.
 */
function BlockMarkerCards( {
	clientId,
	markers,
}: {
	clientId: string;
	markers: BlockMarkers;
} ) {
	const { objectType, objectId } = useReviewData();
	const onResolve = useResolveReviewItems( objectType, objectId );
	const BlockPopover = getBlockPopover();
	if ( ! BlockPopover ) {
		return null;
	}
	return (
		<>
			{ markers.groups.length > 0 && (
				<BlockPopover
					clientId={ clientId }
					placement="top-end"
					focusOnMount={ false }
					className="gse-review-pending-card"
					__unstablePopoverSlot={ POPOVER_SLOT }
				>
					<BlockCardBody
						groups={ markers.groups }
						onResolve={ onResolve }
					/>
				</BlockPopover>
			) }
			{ markers.insertions.map( ( insertion ) => (
				<BlockPopover
					key={ insertion.item.id }
					clientId={ clientId }
					placement={ insertion.placement }
					focusOnMount={ false }
					className="gse-review-insertion-card"
					__unstablePopoverSlot={ POPOVER_SLOT }
				>
					<InsertionCardBody
						item={ insertion.item }
						onResolve={ onResolve }
					/>
				</BlockPopover>
			) ) }
		</>
	);
}

const withConflictMarkers = createHigherOrderComponent(
	( BlockEdit: BlockEditComponent ) =>
		function ConflictMarkedBlockEdit( props: BlockEditProps ) {
			const { clientId } = props;
			const { items, clientIdByTarget } = useReviewData();
			const isFirstRootBlock = useSelect(
				( select ) =>
					select( blockEditorStore ).getBlockOrder()[ 0 ] ===
					clientId,
				[ clientId ]
			);
			const markers = selectBlockMarkers(
				items,
				clientIdByTarget,
				clientId,
				isFirstRootBlock
			);
			if ( markers === NO_MARKERS ) {
				return <BlockEdit { ...props } />;
			}
			return (
				<>
					<BlockEdit { ...props } />
					<BlockMarkerCards
						clientId={ clientId }
						markers={ markers }
					/>
				</>
			);
		},
	'withConflictMarkers'
);

let registered = false;

/** Hangs the cards off every block's edit component; safe to call again. */
export function registerConflictMarkers(): void {
	if ( registered ) {
		return;
	}
	registered = true;
	addFilter(
		'editor.BlockEdit',
		'gutenberg-sync-engines/review/conflict-markers',
		withConflictMarkers
	);
}
