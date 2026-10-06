/**
 * A conflict source over one engine's loaded entities.
 *
 * Every engine keeps its conflicts per entity (a post), and an entity is
 * created and destroyed per session while the review UI watches the post
 * across those lifetimes. This helper carries the part all engines
 * share: the per-entity ledger, the listeners keyed by entity (valid
 * before, and across, the entity's lifetime), and the "did the records
 * change" check an engine runs when its document changed without a
 * record opening or closing. An engine supplies, per entity, how to list
 * its records and how to apply a decision.
 */

/**
 * Internal dependencies
 */
import type {
	SyncConflict,
	SyncConflictDecision,
	SyncConflictOutcome,
	SyncConflictSource,
} from './types';

export interface EntityConflicts {
	/** The entity's open records. A record's sides are rebuilt on every read. */
	list: () => SyncConflict[];
	/**
	 * Applies the reviewer's decision to one record. The result is what
	 * SyncConflictSource.resolveConflict returns.
	 */
	resolve: (
		conflictId: string,
		decision: SyncConflictDecision
	) => void | SyncConflictOutcome | Promise< SyncConflictOutcome >;
}

export interface EntityConflictSource {
	/** The source to register with the conflict registry. */
	source: SyncConflictSource;
	/** Adds one entity's records, replacing any earlier entry. */
	set: (
		objectType: string,
		objectId: unknown,
		entity: EntityConflicts
	) => void;
	/**
	 * Forgets one entity's records, when the entry is still this entity
	 * (a newer entity for the same post keeps its own), and tells the
	 * entity's listeners.
	 */
	delete: (
		objectType: string,
		objectId: unknown,
		entity: EntityConflicts
	) => void;
	/** Forgets every entity and tells their listeners. */
	clear: () => void;
	/** Tells one entity's listeners that its open records changed. */
	notify: ( objectType: string, objectId: unknown ) => void;
	/**
	 * Tells one entity's listeners only when its records read differently
	 * from what the listeners last read. For a document change that may
	 * or may not have touched a record under review.
	 */
	notifyIfChanged: ( objectType: string, objectId: unknown ) => void;
}

/**
 * Creates a conflict source whose records come from entities added later.
 *
 * @return The source and the ways to add, remove, and announce entities.
 */
export function createEntityConflictSource(): EntityConflictSource {
	const entities = new Map< string, EntityConflicts >();
	const listeners = new Map< string, Set< () => void > >();
	// The records as the listeners last read them, serialized.
	const published = new Map< string, string >();
	const keyOf = ( objectType: string, objectId: unknown ) =>
		`${ objectType }:${ String( objectId ) }`;

	const notifyKey = ( key: string ) => {
		listeners.get( key )?.forEach( ( listener ) => listener() );
	};

	const listKey = ( key: string ): SyncConflict[] => {
		const conflicts = entities.get( key )?.list() ?? [];
		published.set( key, JSON.stringify( conflicts ) );
		return conflicts;
	};

	return {
		source: {
			getOpenConflicts: ( objectType, objectId ) =>
				listKey( keyOf( objectType, objectId ) ),
			subscribe: ( objectType, objectId, listener ) => {
				const key = keyOf( objectType, objectId );
				if ( ! listeners.has( key ) ) {
					listeners.set( key, new Set() );
				}
				listeners.get( key )?.add( listener );
				return () => {
					listeners.get( key )?.delete( listener );
				};
			},
			resolveConflict: ( objectType, objectId, conflictId, decision ) =>
				entities
					.get( keyOf( objectType, objectId ) )
					?.resolve( conflictId, decision ) ?? 'resolved',
		},
		set( objectType, objectId, entity ) {
			entities.set( keyOf( objectType, objectId ), entity );
		},
		delete( objectType, objectId, entity ) {
			const key = keyOf( objectType, objectId );
			if ( entities.get( key ) !== entity ) {
				return;
			}
			entities.delete( key );
			published.delete( key );
			notifyKey( key );
		},
		clear() {
			const keys = Array.from( entities.keys() );
			entities.clear();
			published.clear();
			keys.forEach( notifyKey );
		},
		notify( objectType, objectId ) {
			notifyKey( keyOf( objectType, objectId ) );
		},
		notifyIfChanged( objectType, objectId ) {
			const key = keyOf( objectType, objectId );
			const before = published.get( key );
			listKey( key );
			if ( before !== published.get( key ) ) {
				notifyKey( key );
			}
		},
	};
}
