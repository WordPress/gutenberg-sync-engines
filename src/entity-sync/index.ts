/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Supplied by the bundled wp-core-data script.
import {
	privateApis,
	type EntitySyncContext,
	type EntitySyncManager,
} from '@wordpress/core-data';
import { __ } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import { unlock } from '../lock-unlock';
import { registerReviewResolver } from '../review/resolver';
import { createEntitySyncAdapter } from './adapter';
import { createPluginEntitySyncManager } from './manager';
import { flushHeldUpdates } from '../providers/http-polling/polling-manager';

declare global {
	interface Window {
		/** Read by the older core-data contract only (see `registerWithProvider`). */
		_wpEntitySyncProvider?: string;
	}
}

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

/**
 * The name the plugin's provider went by while core-data selected
 * providers by name. The bundled Gutenberg subtree still does; the pinned
 * copy predates the contract where the first registration wins and a
 * provider takes no name. Remove together with `registerWithProvider`'s
 * branch when the subtree pin moves past that change.
 */
const LEGACY_PROVIDER_NAME = 'gutenberg-sync-engines';

type ProviderCreate = ( context: EntitySyncContext ) => EntitySyncManager;

/**
 * Registers the provider the way the running core-data expects: the
 * current contract takes the factory alone; the older one (two
 * parameters) takes a name first and only accepts the provider named by
 * `window._wpEntitySyncProvider`, which the plugin's PHP no longer sets,
 * so it is set here, right before the call that reads it.
 *
 * @param register core-data's `registerEntitySyncProvider`.
 * @param create   The provider factory.
 * @return Unregisters the provider.
 */
function registerWithProvider(
	register: ( ...args: unknown[] ) => () => void,
	create: ProviderCreate
): () => void {
	if ( register.length >= 2 ) {
		globalThis.window._wpEntitySyncProvider = LEGACY_PROVIDER_NAME;
		return register( LEGACY_PROVIDER_NAME, create );
	}
	return register( create );
}

/**
 * Register once, after the engines and transports, before editor startup.
 * core-data takes the first provider registered and ignores later ones;
 * Gutenberg registers none of its own, so this plugin's is the one.
 */
export function registerPluginEntitySync(): () => void {
	if ( ! globalThis.window?.__experimentalEnableRealTimeCollaboration ) {
		return () => {};
	}
	const { registerEntitySyncProvider } = unlock( privateApis );
	let manager: ReturnType< typeof createEntitySyncAdapter > | undefined;
	let unregisterResolver = () => {};
	const create = ( context: EntitySyncContext ) => {
		manager = createEntitySyncAdapter(
			createPluginEntitySyncManager( context ),
			flushBeforeSave
		);
		// The review UI and notices resolve proposals through the
		// manager; core-data no longer relays those verbs. Delegated
		// per call: the services go away when the manager stops.
		unregisterResolver = registerReviewResolver( {
			resolveProposal: ( ...args ) =>
				manager?.services?.resolveProposal( ...args ),
			restoreProposal: ( ...args ) =>
				manager?.services?.restoreProposal( ...args ),
		} );
		return manager;
	};
	const unregister: () => void = registerWithProvider(
		registerEntitySyncProvider,
		create
	);
	return () => {
		unregister();
		unregisterResolver();
		manager?.unloadAll();
	};
}
