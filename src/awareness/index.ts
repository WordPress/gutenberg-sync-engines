/**
 * Bootstraps slow awareness when the site has turned it on.
 *
 * The server passes the mode in `window._gutenbergSyncEnginesSettings`:
 * `awarenessIntervalMs` (0 keeps the framework's live cursors) and
 * `awarenessChannel` (`sync` rides the sync transport's awareness state;
 * `heartbeat` rides WordPress Heartbeat, a separate request stream).
 */

/**
 * WordPress dependencies
 */
import { createElement, createRoot } from '@wordpress/element';

/**
 * Internal dependencies
 */
import { startSlowAwareness } from './controller';
import { readSlowAwarenessSettings } from './settings';
import { registerAwarenessStore } from './store';
import { registerBlockIndicator } from './ui/block-indicator';
import { PresenceBadges } from './ui/presence-badges';

export { readSlowAwarenessSettings } from './settings';

/**
 * Turns the mode on for this editor page when configured.
 */
export function bootstrapSlowAwareness(): void {
	const settings = readSlowAwarenessSettings();
	if ( ! settings.intervalMs ) {
		return;
	}
	registerAwarenessStore();
	registerBlockIndicator();

	// The badge layer needs no editor slot: it draws into the canvas
	// document itself, so it mounts on a plugin-owned root.
	const host = document.createElement( 'div' );
	host.className = 'gutenberg-sync-engines-awareness';
	document.body.appendChild( host );
	createRoot( host ).render( createElement( PresenceBadges ) );

	startSlowAwareness( settings );
}
