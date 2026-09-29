/**
 * The conflict review UI: the in-canvas cards that replace a parked
 * block's edit UI and the dialogs they open. Importing this module installs
 * the two `editor.BlockEdit` filters and the dialog stylesheet; the cards
 * render from the conflict registry (./conflicts.ts) that every engine
 * adapter feeds.
 */

/**
 * Internal dependencies
 */
import './hooks/conflict-block';
import './hooks/sequestered-block';
import './register-views';
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
