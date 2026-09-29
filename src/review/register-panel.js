// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { registerPlugin } from '@wordpress/plugins';
import UnanchoredConflictsPanel from './components/unanchored-panel';

/*
 * The document sidebar panel for conflicts that have no block to present
 * on (see the panel component). A plugin registration, the public way to
 * add a document settings panel.
 */
registerPlugin( 'gutenberg-sync-engines-conflicts', {
	render: UnanchoredConflictsPanel,
} );
