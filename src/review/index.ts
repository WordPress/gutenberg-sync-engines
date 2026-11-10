/**
 * Conflict review: the open list of edits an engine set aside, the notices
 * that announce them, the document-settings panel that indexes them and the
 * in-canvas cards that resolve them. Gutenberg used to carry all of this
 * (core-data's `syncReviewItems` and the editor's collaboration review
 * panel); it now lives here, fed by the plugin's own record handlers.
 */

/**
 * WordPress dependencies
 */
import { createElement } from '@wordpress/element';
// eslint-disable-next-line import/no-unresolved -- Supplied by the wp-plugins script.
import { registerPlugin } from '@wordpress/plugins';

/**
 * Internal dependencies
 */
import { registerReviewStore } from './store';
import CollaborationReviewPanel from './ui/panel';
import { registerConflictMarkers } from './ui/markers';
import { ensureReviewStyles } from './ui/styles';

const PLUGIN_NAME = 'gutenberg-sync-engines-review';

let registered = false;

/**
 * Registers the review UI once: the store, the sidebar panel (an editor
 * plugin, so it renders in the post editor's document settings), the
 * in-canvas cards and their styles. Only when collaboration is on: the
 * editor never calls the engines otherwise, so nothing could be set aside.
 */
export function registerReviewUi(): void {
	if (
		registered ||
		! globalThis.window?.__experimentalEnableRealTimeCollaboration
	) {
		return;
	}
	registered = true;
	registerReviewStore();
	ensureReviewStyles();
	registerConflictMarkers();
	registerPlugin( PLUGIN_NAME, {
		render: () => createElement( CollaborationReviewPanel ),
	} );
}
