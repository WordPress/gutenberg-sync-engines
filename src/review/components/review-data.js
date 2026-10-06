// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { store as editorStore } from '@wordpress/editor';

export const REASON_LABELS = {
	'frame-conflict': __( 'It conflicted with a collaborator’s change.' ),
	'attr-conflict': __(
		'It changed block settings a collaborator also changed.'
	),
	'dependent-on-escalated': __(
		'It depended on another edit that was set aside.'
	),
	'requires-approval': __(
		'It contains content that needs approval from someone allowed to publish unfiltered HTML.'
	),
};

/**
 * Whether the current user may approve content held for unfiltered-HTML
 * review. UI hint only, since ingest re-enforces per the authoring user's
 * capability regardless of what the client shows. The plugin's PHP sets
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
