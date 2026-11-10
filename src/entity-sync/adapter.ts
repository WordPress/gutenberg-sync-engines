/**
 * Internal dependencies
 */
import type { PluginEntitySyncManager } from './manager';

/**
 * Flush plugin transport updates before completing a save.
 *
 * @param base  The plugin-owned entity manager.
 * @param flush Send held transport updates before a regular save.
 * @return The plugin's entity sync manager.
 */
export function createEntitySyncAdapter(
	base: PluginEntitySyncManager,
	flush: () => Promise< void >
): PluginEntitySyncManager {
	let stopped = false;
	return {
		get services() {
			return stopped ? undefined : base.services;
		},
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
