// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { registerSyncConflictView } from './views';
import {
	TableConflictPreview,
	TableConflictView,
} from './components/table-merge-dialog';

/*
 * The block-type review views the plugin ships. A table's cells merge
 * better as a grid than as text, so its conflicts open the table dialog
 * and preview as a compact table. Every other block keeps the built-in
 * dialog. The registration is the same public seam a third-party block
 * would use.
 */
registerSyncConflictView( {
	blockName: 'core/table',
	kind: 'merge',
	render: TableConflictView,
	renderPreview: TableConflictPreview,
} );
