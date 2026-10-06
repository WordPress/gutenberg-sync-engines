/**
 * The plugin-local conflict registry: every engine adapter registers its
 * SyncConflictSource here at module load, and the review UI reads, watches,
 * and resolves conflicts through it without knowing which engine is active.
 * Only the active engine holds state for an entity, so the union of the
 * sources is at most one non-empty list.
 *
 * Conflict data deliberately does NOT go through core-data's store (the
 * fork's review items, which upstream Gutenberg never had) or a new
 * `@wordpress/data` store: the engines already keep per-entity state, and
 * the UI only needs subscribe, read, and resolve.
 */

/**
 * WordPress dependencies
 */
import { useCallback, useSyncExternalStore } from '@wordpress/element';

/**
 * Internal dependencies
 */
import type {
	SyncConflict,
	SyncConflictDecision,
	SyncConflictOutcome,
	SyncConflictSource,
} from './types';

const sources = new Set< SyncConflictSource >();

/**
 * The stable "no conflicts" result. Unconflicted blocks are the
 * overwhelmingly common case; returning one shared array keeps their
 * renders free of fresh objects (useSyncExternalStore compares snapshots
 * by identity).
 */
const NO_CONFLICTS: SyncConflict[] = [];

/**
 * Per-entity subscription state: the hook listeners, the subscriptions
 * held on every source while at least one listener exists, and the cached
 * snapshot those subscriptions invalidate.
 */
interface EntityWatch {
	listeners: Set< () => void >;
	unsubscribes: Map< SyncConflictSource, () => void >;
	snapshot: SyncConflict[] | null;
}

const watches = new Map< string, EntityWatch >();

const keyOf = ( objectType: string, objectId: string | null ) =>
	`${ objectType }:${ String( objectId ) }`;

function attachSource(
	key: string,
	objectType: string,
	objectId: string | null,
	watch: EntityWatch,
	source: SyncConflictSource
): void {
	if ( watch.unsubscribes.has( source ) ) {
		return;
	}
	watch.unsubscribes.set(
		source,
		source.subscribe( objectType, objectId, () => {
			watch.snapshot = null;
			watch.listeners.forEach( ( listener ) => listener() );
		} )
	);
}

/**
 * Registers an engine's conflict source. Called by each engine adapter at
 * module load. Entities already being watched pick the new source up.
 *
 * @param source The engine's source.
 */
export function registerConflictSource( source: SyncConflictSource ): void {
	if ( sources.has( source ) ) {
		return;
	}
	sources.add( source );
	for ( const [ key, watch ] of watches ) {
		const separator = key.indexOf( ':' );
		const objectType = key.slice( 0, separator );
		const objectIdText = key.slice( separator + 1 );
		attachSource(
			key,
			objectType,
			'null' === objectIdText ? null : objectIdText,
			watch,
			source
		);
		watch.snapshot = null;
		watch.listeners.forEach( ( listener ) => listener() );
	}
}

/**
 * Test support: forget every registered source and watch.
 */
export function resetConflictSourcesForTesting(): void {
	for ( const watch of watches.values() ) {
		watch.unsubscribes.forEach( ( unsubscribe ) => unsubscribe() );
	}
	watches.clear();
	sources.clear();
}

/**
 * The open conflicts of one entity, across every registered source. The
 * result is referentially stable between changes while the entity is
 * being watched.
 *
 * @param objectType The sync object type (for a post, `postType/<name>`).
 * @param objectId   The sync object id (the post id as a string).
 * @return The open conflict records.
 */
export function getOpenConflicts(
	objectType: string,
	objectId: string | null
): SyncConflict[] {
	const watch = watches.get( keyOf( objectType, objectId ) );
	if ( watch?.snapshot ) {
		return watch.snapshot;
	}
	let conflicts: SyncConflict[] = NO_CONFLICTS;
	for ( const source of sources ) {
		const open = source.getOpenConflicts( objectType, objectId );
		if ( open.length ) {
			conflicts =
				conflicts === NO_CONFLICTS ? open : conflicts.concat( open );
		}
	}
	if ( watch ) {
		watch.snapshot = conflicts;
	}
	return conflicts;
}

/**
 * Watches one entity's open conflicts across every registered source.
 *
 * @param objectType The sync object type.
 * @param objectId   The sync object id.
 * @param listener   Called on every change to the open list.
 * @return An unsubscribe function.
 */
export function subscribeConflicts(
	objectType: string,
	objectId: string | null,
	listener: () => void
): () => void {
	const key = keyOf( objectType, objectId );
	let watch = watches.get( key );
	if ( ! watch ) {
		watch = {
			listeners: new Set(),
			unsubscribes: new Map(),
			snapshot: null,
		};
		watches.set( key, watch );
	}
	for ( const source of sources ) {
		attachSource( key, objectType, objectId, watch, source );
	}
	watch.listeners.add( listener );
	return () => {
		const current = watches.get( key );
		if ( ! current ) {
			return;
		}
		current.listeners.delete( listener );
		if ( 0 === current.listeners.size ) {
			current.unsubscribes.forEach( ( unsubscribe ) => unsubscribe() );
			watches.delete( key );
		}
	};
}

/**
 * Hands the reviewer's decision to the source whose open list holds the
 * record. Unknown ids are ignored: the record closed elsewhere first.
 *
 * @param objectType The sync object type.
 * @param objectId   The sync object id.
 * @param conflictId The record's id.
 * @param decision   The decision.
 * @return What became of the decision (see SyncConflictOutcome).
 */
export function resolveConflict(
	objectType: string,
	objectId: string | null,
	conflictId: string,
	decision: SyncConflictDecision
): Promise< SyncConflictOutcome > {
	for ( const source of sources ) {
		const open = source.getOpenConflicts( objectType, objectId );
		if ( open.some( ( conflict ) => conflict.id === conflictId ) ) {
			return Promise.resolve(
				source.resolveConflict(
					objectType,
					objectId,
					conflictId,
					decision
				)
			).then(
				( outcome ) => outcome ?? 'resolved',
				() => 'failed'
			);
		}
	}

	return Promise.resolve( 'resolved' );
}

/**
 * The sync object type and id of a post, as the engines key entities.
 *
 * @param postType The post type name.
 * @param postId   The post id.
 * @return `{ objectType, objectId }`, with nulls before the post is known.
 */
function postObject(
	postType: string | undefined,
	postId: string | number | undefined
): { objectType: string | null; objectId: string | null } {
	if ( ! postType || undefined === postId || null === postId ) {
		return { objectType: null, objectId: null };
	}
	return { objectType: `postType/${ postType }`, objectId: String( postId ) };
}

const noopSubscribe = () => () => {};

/**
 * The current post's open conflicts, live. Reads the registry through
 * useSyncExternalStore, so a component re-renders exactly when the open
 * list changes.
 *
 * @param postType The current post type (from the editor store).
 * @param postId   The current post id (from the editor store).
 * @return The open conflict records (a stable empty array when none).
 */
export function useOpenConflicts(
	postType: string | undefined,
	postId: string | number | undefined
): SyncConflict[] {
	const { objectType, objectId } = postObject( postType, postId );
	const subscribe = useCallback(
		( listener: () => void ) =>
			null === objectType
				? noopSubscribe()
				: subscribeConflicts( objectType, objectId, listener ),
		[ objectType, objectId ]
	);
	const getSnapshot = useCallback(
		() =>
			null === objectType
				? NO_CONFLICTS
				: getOpenConflicts( objectType, objectId ),
		[ objectType, objectId ]
	);
	return useSyncExternalStore( subscribe, getSnapshot, getSnapshot );
}

/**
 * A stable callback resolving one of the current post's conflicts.
 *
 * @param postType The current post type.
 * @param postId   The current post id.
 * @return `( conflictId, decision ) => Promise< SyncConflictOutcome >`.
 */
export function useResolveConflict(
	postType: string | undefined,
	postId: string | number | undefined
): (
	conflictId: string,
	decision: SyncConflictDecision
) => Promise< SyncConflictOutcome > {
	const { objectType, objectId } = postObject( postType, postId );
	return useCallback(
		( conflictId: string, decision: SyncConflictDecision ) => {
			if ( null === objectType ) {
				return Promise.resolve< SyncConflictOutcome >( 'resolved' );
			}

			return resolveConflict(
				objectType,
				objectId,
				conflictId,
				decision
			);
		},
		[ objectType, objectId ]
	);
}
