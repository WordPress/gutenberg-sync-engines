/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Supplied by the bundled wp-core-data script.
import { privateApis } from '@wordpress/core-data';
import { __ } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import { unlock } from '../lock-unlock';
import { createEntitySyncAdapter } from './adapter';
import { flushHeldUpdates } from '../providers/http-polling/polling-manager';

/** Send held updates without leaving a save waiting forever. */
async function flushBeforeSave(): Promise< void > {
	let timer: ReturnType< typeof setTimeout > | undefined;
	try {
		await Promise.race( [
			flushHeldUpdates(),
			new Promise< never >( ( _, reject ) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								__(
									'Collaboration updates could not be sent. Try saving again.',
									'gutenberg-sync-engines'
								)
							)
						),
					5000
				);
			} ),
		] );
	} finally {
		clearTimeout( timer );
	}
}

/** Register once, after the engines and transports, before editor startup. */
export function registerPluginEntitySync(): () => void {
	if ( ! globalThis.window?.__experimentalEnableRealTimeCollaboration ) {
		return () => {};
	}
	const { registerEntitySyncManager, createDefaultEntitySyncManager } =
		unlock( privateApis );
	const manager = createEntitySyncAdapter(
		createDefaultEntitySyncManager(),
		flushBeforeSave
	);
	const unregister = registerEntitySyncManager( manager );
	return () => {
		unregister();
		manager.unloadAll();
	};
}
