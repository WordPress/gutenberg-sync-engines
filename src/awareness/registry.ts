/**
 * Where the awareness instance for an entity can be found.
 *
 * The framework creates one typed Awareness per synced entity (through the
 * entity's `syncConfig.createAwareness`) and hands it to the engine; the
 * manager exposes it only through core-data's private hooks. This plugin's
 * engines register the instance here so the slow-awareness controller can
 * publish its own field on it and read peers' fields back.
 */

/**
 * Internal dependencies
 */
import { areBlocksEqual, BLOCK_FIELD } from './channels/sync-channel';
import type { AwarenessHost } from './channels/sync-channel';

type Listener = ( key: string, awareness: AwarenessHost ) => void;

const instances = new Map< string, AwarenessHost >();
const listeners = new Set< Listener >();

/**
 * The registry key for an entity.
 *
 * @param objectType Entity object type, e.g. `postType/post`.
 * @param objectId   Entity id.
 * @return The key.
 */
export function awarenessKey( objectType: string, objectId: string ): string {
	return `${ objectType }:${ objectId }`;
}

/**
 * Registers an entity's awareness instance. Called by each engine adapter
 * right after it creates the instance.
 *
 * @param objectType Entity object type.
 * @param objectId   Entity id.
 * @param awareness  The awareness instance (anything y-protocols-shaped).
 */
export function registerAwareness(
	objectType: string,
	objectId: string,
	awareness: unknown
): void {
	if ( ! awareness ) {
		return;
	}
	const key = awarenessKey( objectType, objectId );
	const host = awareness as AwarenessHost;
	/*
	 * Teach the typed awareness about the block field whether or not this
	 * tab runs the slow mode: core-data's equality gate throws on any field
	 * it has no check for, and a peer (or a stale server entry from a tab
	 * that switched modes) can carry the field at any time. Without this,
	 * receiving such a state breaks the tab's sync polling.
	 */
	if (
		host.equalityFieldChecks &&
		! host.equalityFieldChecks[ BLOCK_FIELD ]
	) {
		host.equalityFieldChecks[ BLOCK_FIELD ] = areBlocksEqual;
	}
	instances.set( key, host );
	listeners.forEach( ( listener ) => listener( key, host ) );
}

/**
 * The registered awareness for an entity, if any.
 *
 * @param objectType Entity object type.
 * @param objectId   Entity id.
 * @return The instance, or undefined.
 */
export function getRegisteredAwareness(
	objectType: string,
	objectId: string
): AwarenessHost | undefined {
	return instances.get( awarenessKey( objectType, objectId ) );
}

/**
 * Subscribes to registrations (the editor may ask before the engine has
 * created the entity).
 *
 * @param listener Called with the key and instance on every registration.
 * @return Unsubscribe.
 */
export function onAwarenessRegistered( listener: Listener ): () => void {
	listeners.add( listener );
	return () => {
		listeners.delete( listener );
	};
}
