// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { useDispatch, useSelect } from '@wordpress/data';
import { useCallback } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { store as editorStore } from '@wordpress/editor';
import { store as noticesStore } from '@wordpress/notices';
import { useOpenConflicts, useResolveConflict } from '../conflicts';

const EMPTY_CONFLICTS = [];

// One notice however many decisions are refused.
const STALE_NOTICE_ID = 'gutenberg-sync-engines-review-stale';

/**
 * Whether the current user may approve content held for unfiltered-HTML
 * review. This only decides what the UI shows: the server checks the
 * authoring user's capability again on every write. The plugin's PHP sets
 * the flag on its client settings (enqueue_editor_assets). Only an
 * explicit `true` allows: when the settings or the flag are missing, the
 * answer is no.
 *
 * @return {boolean} Whether approval is available.
 */
export function canApproveUnfilteredHtml() {
	return true === window._gutenbergSyncEnginesSettings?.canUnfilteredHtml;
}

/**
 * The post being edited, as the conflict registry keys entities.
 *
 * @return {Object} `{ postType, postId }`.
 */
export function useCurrentPost() {
	return useSelect( ( select ) => {
		const { getCurrentPostType, getCurrentPostId } = select( editorStore );

		return {
			postType: getCurrentPostType(),
			postId: getCurrentPostId(),
		};
	}, [] );
}

/**
 * An accepted decision with the `current` side the reviewer decided
 * against, so the engine can refuse it when the content has changed since
 * (see SyncConflictDecision). The record a card or a dialog was last
 * rendered with is the one the reviewer saw. Other decisions pass through.
 *
 * @param {Object} conflict The record as it was last shown.
 * @param {Object} decision The decision.
 * @return {Object} The decision to send.
 */
export function withSeenCurrent( conflict, decision ) {
	if ( 'accept' !== decision.action || undefined !== decision.current ) {
		return decision;
	}

	return { ...decision, current: conflict.current };
}

/**
 * Sends a decision on one of the current post's conflicts to its engine,
 * and tells the reviewer when the engine refused it because the content
 * had changed. The record is still open then, with the content as it is
 * now, so they can review it again.
 *
 * @return {Function} `( conflict, decision ) => Promise< outcome >`.
 */
export function useDecideConflict() {
	const { postType, postId } = useCurrentPost();
	const resolve = useResolveConflict( postType, postId );
	const { createWarningNotice } = useDispatch( noticesStore );

	return useCallback(
		( conflict, decision ) =>
			resolve( conflict.id, withSeenCurrent( conflict, decision ) ).then(
				( outcome ) => {
					if ( 'stale' === outcome ) {
						createWarningNotice(
							__(
								'This content changed before your decision arrived, so nothing was changed. Review it again.'
							),
							{ id: STALE_NOTICE_ID }
						);
					}

					return outcome;
				}
			),
		[ resolve, createWarningNotice ]
	);
}

/**
 * The conflict records whose target is a given block. A record covering a
 * span of blocks matches its FIRST block only, so a span presents as one
 * card. Durable ids win over the position: an id is the block's
 * `metadata.syncId`, or, for an engine whose documents carry the editor's
 * own block ids (yjs-server), the block's client id. A positional target
 * matches the block at that index among its parent's children (the top
 * level when the target names no parent). Proposed insertions (`count`
 * 0) never match: they propose a block that does not exist yet.
 *
 * @param {Function} select    Registry select (inside a useSelect).
 * @param {Array}    conflicts Open conflict records.
 * @param {string}   clientId  The block's client id.
 * @return {Array} The records targeting the block.
 */
export function conflictsTargetingBlock( select, conflicts, clientId ) {
	const { getBlockAttributes, getBlockRootClientId, getBlockIndex } =
		select( blockEditorStore );
	const syncId = getBlockAttributes( clientId )?.metadata?.syncId;
	const rootClientId = getBlockRootClientId( clientId );
	const parentSyncId = rootClientId
		? getBlockAttributes( rootClientId )?.metadata?.syncId
		: undefined;
	const index = getBlockIndex( clientId );

	return conflicts.filter( ( conflict ) => {
		const { target } = conflict;
		if ( 'blocks' !== target.type || 0 === target.count ) {
			return false;
		}

		if ( target.ids?.length ) {
			return (
				( !! syncId && target.ids[ 0 ] === syncId ) ||
				target.ids[ 0 ] === clientId
			);
		}

		if ( target.parentId ) {
			return target.parentId === parentSyncId && target.index === index;
		}

		return '' === rootClientId && target.index === index;
	} );
}

/**
 * The record whose span CONTINUES on a block, with the block its card is
 * on: a record whose `ids` name the block after the first one, while the
 * first one is in the document. The span's first block carries the card
 * (conflictsTargetingBlock), which shows the whole span; the blocks after
 * it are folded out of the canvas meanwhile (hooks/span-blocks.jsx). When
 * the first block is gone the record has no card, and the later blocks
 * are left alone (the sidebar panel lists the record).
 *
 * @param {Function} select    Registry select (inside a useSelect).
 * @param {Array}    conflicts Open conflict records.
 * @param {string}   clientId  The block's client id.
 * @return {?Object} `{ conflict, firstClientId }`, or null.
 */
export function conflictContinuingOnBlock( select, conflicts, clientId ) {
	const { getBlockAttributes, getClientIdsWithDescendants } =
		select( blockEditorStore );
	const syncId = getBlockAttributes( clientId )?.metadata?.syncId;
	const isBlock = ( id, candidate ) =>
		( !! syncId && id === syncId ) || id === candidate;

	for ( const conflict of conflicts ) {
		const { target } = conflict;
		if (
			'blocks' !== target.type ||
			0 === target.count ||
			! target.ids?.length
		) {
			continue;
		}

		const position = target.ids.findIndex( ( id ) =>
			isBlock( id, clientId )
		);
		if ( position <= 0 ) {
			continue;
		}

		const [ first ] = target.ids;
		const firstClientId = getClientIdsWithDescendants().find(
			( candidate ) =>
				candidate === first ||
				getBlockAttributes( candidate )?.metadata?.syncId === first
		);
		if ( firstClientId ) {
			return { conflict, firstClientId };
		}
	}

	return null;
}

/**
 * The open record whose span continues on one block, if any (see
 * conflictContinuingOnBlock).
 *
 * @param {string} clientId The block's client id.
 * @return {?Object} `{ conflict, firstClientId }`, or null.
 */
export function useConflictContinuation( clientId ) {
	const { postType, postId } = useCurrentPost();
	const open = useOpenConflicts( postType, postId );

	return useSelect(
		( select ) => {
			if ( ! open.length ) {
				return null;
			}

			return conflictContinuingOnBlock( select, open, clientId );
		},
		[ clientId, open ]
	);
}

/**
 * The open conflicts of one kind targeting one block (see
 * conflictsTargetingBlock for how a record names its block). One record
 * is one conflict: the engine publishes the edits it set aside together
 * as one record, and never two records of one kind over the same block
 * by one author. A record covering several blocks targets its first
 * block, so a section presents once; its other blocks are folded away
 * (useConflictContinuation).
 *
 * @param {string} clientId The block's client id.
 * @param {string} kind     `merge`, or `sequestration` for a security hold.
 * @return {Array} The records.
 */
export function useBlockConflictsOfKind( clientId, kind ) {
	const { postType, postId } = useCurrentPost();
	const open = useOpenConflicts( postType, postId );

	return useSelect(
		( select ) => {
			if ( ! open.length ) {
				return EMPTY_CONFLICTS;
			}

			const matches = conflictsTargetingBlock(
				select,
				open,
				clientId
			).filter( ( conflict ) => kind === conflict.kind );

			if ( ! matches.length ) {
				return EMPTY_CONFLICTS;
			}

			return matches;
		},
		[ clientId, kind, open ]
	);
}
