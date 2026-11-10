/**
 * WordPress dependencies
 */
import { getBlockContent, getBlockType } from '@wordpress/blocks';

/**
 * External dependencies
 */
import fastDeepEqual from 'fast-deep-equal/es6/index.js';

/**
 * Internal dependencies
 */
import { resolveEngineAdapter } from '../framework';
import { createReviewHandlers } from '../review/handlers';
import type { ReviewResolver } from '../review/resolver';
import { LOCAL_EDITOR_ORIGIN, LOCAL_UNDO_IGNORED_ORIGIN } from '../sync/config';
import type { SyncManager, SyncConfig, ObjectID } from '../sync';
import type {
	EntitySyncContext,
	EntitySyncManager,
	EntitySyncRecord,
	EntitySyncRecordId,
	EntitySyncEditOptions,
	EntitySyncBeforeSaveContext,
} from '@wordpress/core-data';

const POST_META_KEY_FOR_CRDT_DOC_PERSISTENCE = '_crdt_document';
const CRDT_AUTOSAVE_SNAPSHOT_KEY = 'crdt_snapshot';

/**
 * The services core-data reads from the provider, plus the two review
 * resolution verbs. core-data no longer carries those; the plugin's review
 * UI calls them on this object (see `src/review/resolver.ts`).
 */
export type PluginEntitySyncServices = NonNullable<
	EntitySyncManager[ 'services' ]
> &
	ReviewResolver;

/** The manager this plugin registers with core-data. */
export interface PluginEntitySyncManager extends EntitySyncManager {
	/** Absent once the manager was stopped (`unloadAll`). */
	readonly services?: PluginEntitySyncServices;
}

function getRawValue( value: unknown ): string | undefined {
	if ( typeof value === 'string' ) {
		return value;
	}
	if (
		value &&
		typeof value === 'object' &&
		'raw' in value &&
		typeof value.raw === 'string'
	) {
		return value.raw;
	}
	return undefined;
}
function toObjectId( id: EntitySyncRecordId ): ObjectID {
	return id as ObjectID;
}

/**
 * Add engine block metadata without changing Gutenberg's entity definitions.
 * @param config
 */
function withBlockMetadata( config: SyncConfig ): SyncConfig {
	return {
		...config,
		richTextFields: ( name ) => {
			const block = getBlockType( name );
			return block
				? Object.entries( block.attributes ?? {} )
						.filter(
							( [ , field ] ) =>
								field.source === 'html' ||
								field.source === 'rich-text'
						)
						.map( ( [ key ] ) => key )
				: [ 'content' ];
		},
		isRawContentBlock: ( name ) =>
			name === 'core/html' || name === 'core/freeform',
		serializeRawContent: ( block ) => {
			if ( block.innerContent ) {
				return getBlockContent(
					block as Parameters< typeof getBlockContent >[ 0 ]
				);
			}
			return typeof block.attributes?.content === 'string'
				? block.attributes.content
				: '';
		},
		hydrateRawContent: ( name, html ) =>
			name === 'core/freeform'
				? { attributes: { content: html } }
				: { innerContent: html === '' ? [] : [ html ] },
	};
}

// Post meta is applied to the CRDT one subkey at a time, so compare the save
// response at the same granularity to avoid carrying stale sibling values.
function getServerMutatedMetaFields(
	updatedMeta: EntitySyncRecord | undefined,
	persistedMeta: EntitySyncRecord | undefined,
	syncedMeta: EntitySyncRecord | undefined
): EntitySyncRecord {
	const baseline = { ...persistedMeta, ...syncedMeta };

	return Object.fromEntries(
		Object.entries( updatedMeta ?? {} ).filter( ( [ key, value ] ) => {
			if ( key === POST_META_KEY_FOR_CRDT_DOC_PERSISTENCE ) {
				// The persisted CRDT snapshot may change on save and is
				// intentionally excluded from CRDT meta synchronization, so it
				// is not a server mutation.
				return false;
			}

			return ! fastDeepEqual( value, baseline[ key ] );
		} )
	);
}

/**
 * The fields of a save response that differ from what the client sent (or
 * held before the save): the changes the server made on its own, which the
 * shared document must learn about.
 *
 * @param updatedRecord   The save response.
 * @param persistedRecord The record before the save.
 * @param syncedChanges   The edits that were sent.
 * @return The server-mutated fields.
 */
export function getServerMutatedFields(
	updatedRecord: EntitySyncRecord,
	persistedRecord: EntitySyncRecord,
	syncedChanges: EntitySyncRecord
): EntitySyncRecord {
	return Object.fromEntries(
		Object.entries( updatedRecord ).flatMap( ( [ key, value ] ) => {
			if ( key === 'meta' ) {
				const serverMutatedMeta = getServerMutatedMetaFields(
					value as EntitySyncRecord | undefined,
					persistedRecord.meta as EntitySyncRecord | undefined,
					syncedChanges.meta as EntitySyncRecord | undefined
				);

				return Object.keys( serverMutatedMeta ).length
					? [ [ key, serverMutatedMeta ] ]
					: [];
			}

			const baseline =
				key in syncedChanges
					? syncedChanges[ key ]
					: persistedRecord[ key ];

			// The save response nests raw attributes as `{ raw, rendered }`
			// while the baseline holds raw strings; compare raw values so the
			// shape difference does not read as a server mutation.
			const wasServerMutated = ! fastDeepEqual(
				getRawValue( value ) ?? value,
				getRawValue( baseline ) ?? baseline
			);

			return wasServerMutated ? [ [ key, value ] ] : [];
		} )
	);
}

/**
 * Adapt Gutenberg's record operations to the plugin's selected engine.
 *
 * @param editor  Editor record operations.
 * @param resolve Creates the selected engine manager; injectable for tests.
 * @return The manager registered with Gutenberg.
 */
export function createPluginEntitySyncManager(
	editor: EntitySyncContext,
	resolve: () => SyncManager | undefined = () =>
		resolveEngineAdapter()?.createManager()
): PluginEntitySyncManager {
	let syncManager: SyncManager | undefined;
	let unavailable = false;
	const getSyncManager = () => {
		if ( syncManager ) {
			return syncManager;
		}
		if ( ! globalThis.window?.__experimentalEnableRealTimeCollaboration ) {
			return undefined;
		}
		syncManager = resolve();
		unavailable = ! syncManager;
		return syncManager;
	};
	const hasSyncManager = () => Boolean( syncManager );
	const getSyncConfig = (
		kind: string,
		name: string
	): SyncConfig | undefined => {
		const config = editor.getSyncConfig( kind, name );
		return config ? withBlockMetadata( config ) : undefined;
	};

	return {
		services: {
			isAvailable: () => {
				getSyncManager();
				return ! unavailable;
			},
			retry: () => syncManager?.retry?.(),
			getAwareness: ( ...args ) => syncManager?.getAwareness( ...args ),
			getEntitySnapshot: ( ...args ) =>
				syncManager?.getEntitySnapshot( ...args ),
			entityContainsSnapshot: ( ...args ) =>
				syncManager?.entityContainsSnapshot( ...args ) ?? false,
			createPersistedCRDTDoc: async ( ...args ) =>
				( await syncManager?.createPersistedCRDTDoc( ...args ) ) ??
				null,
			resolveProposal: ( ...args ) =>
				syncManager?.resolveProposal?.( ...args ),
			restoreProposal: ( ...args ) =>
				syncManager?.restoreProposal?.( ...args ),
		},
		shouldSync( kind, name ) {
			return Boolean( getSyncManager() && getSyncConfig( kind, name ) );
		},

		load( kind, name, recordId, record, handlers ) {
			const syncConfig = getSyncConfig( kind, name );
			const manager = getSyncManager();

			if ( ! syncConfig || ! manager ) {
				return;
			}

			const objectType = `${ kind }/${ name }`;
			const objectId = toObjectId( recordId );
			return manager.load( syncConfig, objectType, objectId, record, {
				...editor.recordHandlers( kind, name, recordId, handlers ),
				// The review half: core-data's handlers no longer carry
				// it, so the plugin keeps its own list and notices.
				...createReviewHandlers( objectType, objectId ),
			} );
		},

		loadCollection( kind, name, handlers ) {
			const syncConfig = getSyncConfig( kind, name );
			const manager = getSyncManager();

			if ( ! syncConfig || ! manager ) {
				return;
			}

			return manager.loadCollection(
				syncConfig,
				`${ kind }/${ name }`,
				editor.collectionHandlers( kind, name, handlers )
			);
		},

		update( kind, name, recordId, edits, options ) {
			if ( ! getSyncConfig( kind, name ) ) {
				return;
			}

			getSyncManager()?.update(
				`${ kind }/${ name }`,
				toObjectId( recordId ),
				edits,
				getEditOrigin( options ),
				{ isNewUndoLevel: isNewUndoLevel( options ) }
			);
		},

		beforeSave( kind, name, recordId, edits, context ) {
			if ( ! getSyncConfig( kind, name ) ) {
				return;
			}

			return beforeSave( kind, name, recordId, edits, context );
		},

		afterSave( kind, name, recordId, context ) {
			if ( ! getSyncConfig( kind, name ) ) {
				return;
			}

			const { savedRecord, persistedRecord, edits } = context;
			const syncChanges = persistedRecord
				? getServerMutatedFields( savedRecord, persistedRecord, edits )
				: savedRecord;

			// Use an untracked origin so that the save response does not
			// create undo levels.
			getSyncManager()?.update(
				`${ kind }/${ name }`,
				undefined === recordId ? null : toObjectId( recordId ),
				syncChanges,
				LOCAL_UNDO_IGNORED_ORIGIN,
				{ isSave: true }
			);
		},

		unload( kind, name, recordId ) {
			if ( ! getSyncConfig( kind, name ) ) {
				return;
			}

			getSyncManager()?.unload(
				`${ kind }/${ name }`,
				toObjectId( recordId )
			);
		},

		unloadAll() {
			if ( hasSyncManager() ) {
				getSyncManager()?.unloadAll();
			}
		},

		// A getter, so the value is read when core-data asks: the undo
		// manager only exists once a synced entity is loaded.
		get undoManager() {
			return getSyncManager()?.undoManager;
		},
	};

	function getEditOrigin( options: EntitySyncEditOptions ): string {
		// Use an untracked origin for undoIgnore changes so the Yjs UndoManager
		// does not capture them as undo levels, while still syncing them to the
		// CRDT document and other peers.
		return options.undoIgnore
			? LOCAL_UNDO_IGNORED_ORIGIN
			: LOCAL_EDITOR_ORIGIN;
	}

	function isNewUndoLevel( options: EntitySyncEditOptions ): boolean {
		// Transient changes (`isCached`) merge into the current undo level;
		// completed ones start a new level. `undoIgnore` never touches undo.
		return options.undoIgnore ? false : ! options.isCached;
	}

	async function beforeSave(
		kind: string,
		name: string,
		recordId: EntitySyncRecordId,
		edits: EntitySyncRecord,
		{ persistedRecord, isAutosave }: EntitySyncBeforeSaveContext
	): Promise< EntitySyncRecord | void > {
		const manager = getSyncManager();

		if ( ! manager ) {
			return;
		}

		const objectType = `${ kind }/${ name }`;
		const objectId = toObjectId( recordId );

		// `saveEntityRecord` can be called directly, bypassing
		// `editEntityRecord`, so make sure its changes enter the CRDT first. An
		// autosave snapshots the document below, and a regular save creates the
		// persisted document from it, so both must see these changes.
		if ( persistedRecord ) {
			manager.update(
				objectType,
				objectId,
				edits,
				LOCAL_UNDO_IGNORED_ORIGIN
			);
		}

		if ( isAutosave ) {
			// Capture the CRDT snapshot in the same tick as the payload so it
			// describes exactly the content being autosaved.
			const snapshot = manager.getEntitySnapshot( objectType, objectId );

			return snapshot
				? { [ CRDT_AUTOSAVE_SNAPSHOT_KEY ]: snapshot }
				: undefined;
		}

		// Add meta for the persisted CRDT document during real post saves so the
		// saved post and CRDT snapshot are committed in the same request. We don't
		// want a post save to fail but a CRDT update to succeed or vice versa.
		// CRDT repair uses /wp-sync/v1/save to avoid post-save side effects.
		if ( 'postType' !== kind || ! persistedRecord ) {
			return;
		}

		const serializedDoc = await manager.createPersistedCRDTDoc(
			objectType,
			toObjectId( persistedRecord.id as EntitySyncRecordId )
		);

		if ( ! serializedDoc ) {
			return;
		}

		return {
			meta: {
				...( edits.meta as EntitySyncRecord | undefined ),
				[ POST_META_KEY_FOR_CRDT_DOC_PERSISTENCE ]: serializedDoc,
			},
		};
	}
}
