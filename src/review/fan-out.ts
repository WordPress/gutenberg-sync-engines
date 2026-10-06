/**
 * A conflict source over every engine instance an adapter created.
 *
 * The conflict registry takes an engine's source at module load, but
 * engines are created per session (the framework asks the adapter for a
 * manager). So the registered source is a fan-out: reads union the
 * instances, subscriptions attach to each, and an instance created after
 * a subscription started is attached on creation.
 */

/**
 * Internal dependencies
 */
import type { SyncConflictSource } from './types';

interface Subscription {
	objectType: string;
	objectId: string | null;
	listener: () => void;
	unsubscribes: Map< SyncConflictSource, () => void >;
}

export interface ConflictFanOut {
	/** The source to register with the conflict registry. */
	source: SyncConflictSource;
	/** Adds one engine instance's own source. */
	add: ( instance: SyncConflictSource ) => void;
}

/**
 * Creates a fan-out source.
 *
 * @return The source and the way to add instances to it.
 */
export function createConflictFanOut(): ConflictFanOut {
	const instances = new Set< SyncConflictSource >();
	const subscriptions = new Set< Subscription >();

	const attach = (
		subscription: Subscription,
		instance: SyncConflictSource
	) => {
		if ( subscription.unsubscribes.has( instance ) ) {
			return;
		}
		subscription.unsubscribes.set(
			instance,
			instance.subscribe(
				subscription.objectType,
				subscription.objectId,
				subscription.listener
			)
		);
	};

	return {
		add( instance ) {
			if ( instances.has( instance ) ) {
				return;
			}
			instances.add( instance );
			subscriptions.forEach( ( subscription ) => {
				attach( subscription, instance );
				subscription.listener();
			} );
		},
		source: {
			getOpenConflicts: ( objectType, objectId ) =>
				Array.from( instances ).flatMap( ( instance ) =>
					instance.getOpenConflicts( objectType, objectId )
				),
			subscribe: ( objectType, objectId, listener ) => {
				const subscription: Subscription = {
					objectType,
					objectId,
					listener,
					unsubscribes: new Map(),
				};
				instances.forEach( ( instance ) =>
					attach( subscription, instance )
				);
				subscriptions.add( subscription );
				return () => {
					subscription.unsubscribes.forEach( ( unsubscribe ) =>
						unsubscribe()
					);
					subscriptions.delete( subscription );
				};
			},
			resolveConflict: ( objectType, objectId, conflictId, decision ) => {
				for ( const instance of instances ) {
					const open = instance.getOpenConflicts(
						objectType,
						objectId
					);
					if (
						open.some( ( conflict ) => conflict.id === conflictId )
					) {
						// Hand the engine's outcome back: the registry reads a
						// missing one as resolved, which would hide a 'stale'.
						return instance.resolveConflict(
							objectType,
							objectId,
							conflictId,
							decision
						);
					}
				}
				// No instance holds the id: the record closed elsewhere first,
				// which the registry reads as resolved.
				return undefined;
			},
		},
	};
}
