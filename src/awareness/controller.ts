/**
 * The slow-awareness controller: for the post being edited, run the
 * publisher on the chosen channel and feed peers' blocks into the store.
 */

/**
 * WordPress dependencies
 */
import { dispatch, select, subscribe } from '@wordpress/data';

/**
 * Internal dependencies
 */
import type { BlockTreeReader } from './block-id';
import {
	createHeartbeatChannel,
	isHeartbeatAvailable,
} from './channels/heartbeat-channel';
import {
	createSyncChannel,
	suppressRealtimeSelection,
} from './channels/sync-channel';
import type { AwarenessHost } from './channels/sync-channel';
import { createPresencePublisher } from './publisher';
import type { Publisher } from './publisher';
import { getRegisteredAwareness, onAwarenessRegistered } from './registry';
import { store } from './store';
import type { Channel, SlowAwarenessSettings } from './types';

interface EditorStoreSelectors {
	getCurrentPostId: () => number | null | undefined;
	getCurrentPostType: () => string | null | undefined;
}

/**
 * A registered store's selectors, narrowed to the slice this module reads
 * (`select` types a store named by string as an open record).
 *
 * @param name Store name.
 * @return The selectors, or undefined before the store is registered.
 */
function selectStore< Selectors >( name: string ): Selectors | undefined {
	return select( name ) as Selectors | undefined;
}

/**
 * Starts slow awareness for the editor on this page. Waits for the editor
 * to know its post and for the engine to have created the post's awareness
 * instance, then runs until stopped.
 *
 * @param settings The mode settings (interval and channel).
 * @return A stop function.
 */
export function startSlowAwareness(
	settings: SlowAwarenessSettings
): () => void {
	let stopped = false;
	let stopSession: ( () => void ) | null = null;

	function tryStart(): void {
		if ( stopped || stopSession ) {
			return;
		}
		const editor = selectStore< EditorStoreSelectors >( 'core/editor' );
		const reader = selectStore< BlockTreeReader >( 'core/block-editor' );
		if ( ! editor || ! reader ) {
			return;
		}
		const postId = editor.getCurrentPostId();
		const postType = editor.getCurrentPostType();
		if ( ! postId || ! postType ) {
			return;
		}
		const awareness = getRegisteredAwareness(
			`postType/${ postType }`,
			String( postId )
		);
		if ( ! awareness ) {
			return;
		}
		stopSession = startSession( settings, awareness, reader );
	}

	const unsubscribeEditor = subscribe( tryStart, 'core/editor' );
	const unsubscribeRegistry = onAwarenessRegistered( tryStart );
	tryStart();

	return () => {
		stopped = true;
		unsubscribeEditor();
		unsubscribeRegistry();
		stopSession?.();
		stopSession = null;
	};
}

function startSession(
	settings: SlowAwarenessSettings,
	awareness: AwarenessHost,
	reader: BlockTreeReader
): () => void {
	const { setPeers: onPeers, reset } = dispatch( store );

	// In both modes the framework's live cursor is suppressed on the sync
	// transport's awareness state, so peers see the block outline only,
	// never a cursor that jumps every few seconds. Presence (who is
	// here) keeps riding the sync transport either way.
	const restoreSelection = suppressRealtimeSelection( awareness );

	let channel: Channel;
	let publisher: Publisher | null = null;
	if ( 'heartbeat' === settings.channel && isHeartbeatAvailable() ) {
		// Only the block name moves over Heartbeat, on the advisory
		// channel's discovery probe, which reads the selection as it is
		// built.
		channel = createHeartbeatChannel( {
			reader,
			intervalMs: settings.intervalMs,
			onPeers,
		} );
	} else {
		// The publisher samples the selection once per interval and
		// hands the channel each new block.
		const sync = createSyncChannel( { awareness, onPeers } );
		publisher = createPresencePublisher( {
			reader,
			intervalMs: settings.intervalMs,
			onPublish: sync.publish,
		} );
		channel = sync;
	}

	channel.start();
	publisher?.start();

	return () => {
		publisher?.stop();
		channel.stop();
		restoreSelection();
		reset();
	};
}
