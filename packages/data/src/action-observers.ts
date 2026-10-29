import type { Middleware } from 'redux';
import type { DataRegistry } from './types';

export type StoreActionObserver = ( change: {
	registry: DataRegistry;
	action: { type: string; [ key: string ]: unknown };
	before: unknown;
	after: unknown;
} ) => void;

const observers = new Map< string, Set< StoreActionObserver > >();

/**
 * Observes completed store actions. Observers must not dispatch synchronously.
 *
 * @param name     Store name.
 * @param observer Receives the action and immutable states.
 * @return Unsubscribe function.
 */
export function observeStoreActions(
	name: string,
	observer: StoreActionObserver
) {
	if ( ! observers.has( name ) ) {
		observers.set( name, new Set() );
	}
	observers.get( name )!.add( observer );
	return () => observers.get( name )?.delete( observer );
}

/**
 * @param name     Store name.
 * @param registry Owning registry.
 * @return Middleware placed after thunk handling.
 */
export function createActionObserverMiddleware(
	name: string,
	registry: DataRegistry
): Middleware {
	return ( store ) => ( next ) => ( action ) => {
		const listeners = observers.get( name );
		if ( ! listeners?.size ) {
			return next( action );
		}
		const before = store.getState().root;
		const result = next( action );
		const after = store.getState().root;
		for ( const observer of listeners ) {
			try {
				observer( {
					registry,
					action: action as Parameters< StoreActionObserver >[ 0 ][ 'action' ],
					before,
					after,
				} );
			} catch ( error ) {
				// A diagnostic observer must not interrupt accepted editor changes.
				// eslint-disable-next-line no-console
				console.error( 'Store action observer failed', error );
			}
		}
		return result;
	};
}
