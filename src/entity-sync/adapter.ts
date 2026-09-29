/**
 * Internal dependencies
 */
import type { EntitySyncManager } from '../../gutenberg/packages/core-data/src/entity-sync';

/**
 * Add plugin transport flushing to Gutenberg's engine bridge. Keeping that
 * bridge preserves each engine's snapshots, undo metadata, and editor UI.
 *
 * @param base  The bridge supplied by the vendored core-data package.
 * @param flush Send held transport updates before a regular save.
 * @return The plugin's entity sync manager.
 */
export function createEntitySyncAdapter(
	base: EntitySyncManager,
	flush: () => Promise< void >
): EntitySyncManager {
	let stopped = false;
	return {
		shouldSync: ( ...args ) => base.shouldSync?.( ...args ) !== false,
		load( ...args ) {
			stopped = false;
			return base.load( ...args );
		},
		loadCollection( ...args ) {
			stopped = false;
			return base.loadCollection?.( ...args );
		},
		update( ...args ) {
			if ( ! stopped ) {
				base.update( ...args );
			}
		},
		async beforeSave( kind, name, id, edits, context ) {
			if ( stopped || base.shouldSync?.( kind, name, id ) === false ) {
				return;
			}
			const additions = await base.beforeSave?.(
				kind,
				name,
				id,
				edits,
				context
			);
			if ( ! context.isAutosave ) {
				await flush();
			}
			return additions;
		},
		afterSave( ...args ) {
			if ( ! stopped ) {
				base.afterSave?.( ...args );
			}
		},
		unload: ( ...args ) => base.unload( ...args ),
		unloadAll() {
			stopped = true;
			base.unloadAll();
		},
		get undoManager() {
			return stopped ? undefined : base.undoManager;
		},
	};
}
