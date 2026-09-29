/**
 * The conflict review UI: the in-canvas cards that replace a parked
 * block's edit UI, the dialogs they open, and the sidebar panel for
 * conflicts with no block to present on. Importing this module installs
 * the two `editor.BlockEdit` filters, the panel, and the stylesheet; all
 * of it renders from the conflict registry (./conflicts.ts) that every
 * engine adapter feeds.
 */

/**
 * Internal dependencies
 */
import './hooks/conflict-block';
import './hooks/sequestered-block';
import './register-views';
import './register-panel';
import './style.scss';

export {
	registerConflictSource,
	useOpenConflicts,
	useResolveConflict,
} from './conflicts';
export { registerSyncConflictView, getSyncConflictView } from './views';
export type {
	SyncConflict,
	SyncConflictDecision,
	SyncConflictSource,
	SyncConflictTarget,
} from './types';
