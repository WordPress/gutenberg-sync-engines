/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved, @wordpress/no-unsafe-wp-apis -- Provided at runtime as wp.blocks.
import { parse, __unstableSerializeAndClean } from '@wordpress/blocks';

/*
 * DE-RTC's local copy of an entity record, as plain JSON.
 *
 * DE-RTC never merges on the client: the server's canonical document is a
 * serialized-block string and every merge happens there. The client only
 * needs to remember what the editor last showed (blocks and property
 * values), tell the session when that changes, and tell the editor when
 * the server's content changes it. This module does exactly that — the
 * job a local Y.Doc used to do through the framework's record↔CRDT
 * mapping, without the CRDT.
 *
 * The rules for which editor changes are kept, and which record values
 * reach the editor, are ported from core-data's post mapping
 * (`applyPostChangesToCRDTDoc` / `getPostChangesFromCRDTDoc` in
 * `utils/crdt.ts`) and its generic twin for other entities. Only the Yjs
 * parts are left out: rich-text merging (the server merges), and
 * selection history (shared carets need Yjs relative positions; see
 * PostEditorAwareness, which turns them off over a stub doc).
 */

/** The record changed because the editor changed it. */
export type DeRtcChangeListener = ( origin: unknown ) => void;

export interface DeRtcRecord {
	/** A random transport client id (the Y.Doc clientID it replaces). */
	readonly clientId: number;

	/** The current value of one field, or undefined. */
	get: ( name: string ) => unknown;

	/** The names of every field the record holds. */
	keys: () => string[];

	/** The current blocks (an empty list before any arrive). */
	blocks: () => any[];

	/**
	 * Stores changes and notifies listeners once when anything changed.
	 * `meta` merges per key (a partial object never drops sibling keys);
	 * an undefined value removes the field. Blocks compare by reference —
	 * the editor's block tree is immutable, so a new tree means a change;
	 * callers holding re-parsed blocks compare content first (see
	 * `sameBlocks`).
	 *
	 * @param changes Field values to store.
	 * @param origin  Why the record changes (passed to listeners).
	 * @return Whether anything changed.
	 */
	apply: ( changes: Record< string, unknown >, origin: unknown ) => boolean;

	/** Subscribes to changes; returns the unsubscribe function. */
	subscribe: ( listener: DeRtcChangeListener ) => () => void;
}

/**
 * The fields core-data syncs for a post type, before taxonomies (the
 * `syncedProperties` set in core-data's entities.js). Taxonomy fields are
 * added per post type: the server seeds each attached taxonomy under its
 * REST base in the room's first version, and the record keeps every field
 * the server sends.
 */
export const POST_SYNCED_PROPERTIES = [
	'author',
	'blocks',
	'content',
	'comment_status',
	'date',
	'excerpt',
	'featured_media',
	'format',
	'meta',
	'ping_status',
	'slug',
	'status',
	'sticky',
	'template',
	'title',
];

/** Post meta keys that never sync (core-data's disallowedPostMetaKeys). */
const DISALLOWED_META_KEYS = new Set( [ '_crdt_document' ] );

/**
 * A random transport client id, in the range Yjs client ids used.
 *
 * @return The id.
 */
function randomClientId(): number {
	const [ word ] = globalThis.crypto.getRandomValues( new Uint32Array( 1 ) );
	return ( word % ( 2 ** 31 - 1 ) ) + 1;
}

/**
 * Order-tolerant value equality: term-ID arrays are sets (numeric lists
 * compare sorted); everything else compares by JSON encoding.
 *
 * @param a One value.
 * @param b Other value.
 * @return Whether the values are equal.
 */
export function valuesEqual( a: unknown, b: unknown ): boolean {
	if (
		Array.isArray( a ) &&
		Array.isArray( b ) &&
		a.every( ( value ) => 'number' === typeof value ) &&
		b.every( ( value ) => 'number' === typeof value )
	) {
		const aSorted = [ ...a ].sort( ( x, y ) => x - y );
		const bSorted = [ ...b ].sort( ( x, y ) => x - y );
		return JSON.stringify( aSorted ) === JSON.stringify( bSorted );
	}
	return JSON.stringify( a ) === JSON.stringify( b );
}

/**
 * Serializes blocks the way core-data does when it compares blocks against
 * saved content, so proposal content matches what a save would write.
 *
 * @param blocks Editor blocks.
 * @return Serialized block content.
 */
export function serializeBlocks( blocks: unknown[] ): string {
	return __unstableSerializeAndClean( blocks as any[] ).trim();
}

/**
 * Whether two block trees hold the same content (same reference, or the
 * same serialized form).
 *
 * @param a One tree.
 * @param b Other tree.
 * @return Whether they are the same.
 */
export function sameBlocks( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}
	if ( ! Array.isArray( a ) || ! Array.isArray( b ) ) {
		return false;
	}
	return serializeBlocks( a ) === serializeBlocks( b );
}

/**
 * A field value in raw form: REST records carry title and excerpt as
 * `{ raw, rendered }`, editor edits as plain strings.
 *
 * @param value Field value.
 * @return The raw string, or undefined.
 */
function getRawValue( value: unknown ): string | undefined {
	if ( 'string' === typeof value ) {
		return value;
	}
	if (
		value &&
		'object' === typeof value &&
		'string' === typeof ( value as { raw?: unknown } ).raw
	) {
		return ( value as { raw: string } ).raw;
	}
	return undefined;
}

/**
 * Creates an empty record.
 *
 * @return The record.
 */
export function createDeRtcRecord(): DeRtcRecord {
	const clientId = randomClientId();
	const values = new Map< string, unknown >();
	const listeners = new Set< DeRtcChangeListener >();

	const set = ( name: string, value: unknown ): boolean => {
		if ( undefined === value ) {
			return values.delete( name );
		}
		const current = values.get( name );
		if (
			'blocks' === name
				? current === value
				: valuesEqual( current, value )
		) {
			return false;
		}
		values.set( name, value );
		return true;
	};

	return {
		clientId,

		get: ( name ) => values.get( name ),

		keys: () => Array.from( values.keys() ),

		blocks: () => {
			const blocks = values.get( 'blocks' );
			return Array.isArray( blocks ) ? blocks : [];
		},

		apply( changes, origin ) {
			let changed = false;
			for ( const [ name, value ] of Object.entries( changes ) ) {
				if ( 'meta' === name && value && 'object' === typeof value ) {
					const meta = {
						...( ( values.get( 'meta' ) as Record<
							string,
							unknown
						> ) ?? {} ),
					};
					let metaChanged = false;
					for ( const [ key, metaValue ] of Object.entries(
						value as Record< string, unknown >
					) ) {
						if ( DISALLOWED_META_KEYS.has( key ) ) {
							continue;
						}
						if ( undefined === metaValue ) {
							metaChanged = key in meta || metaChanged;
							delete meta[ key ];
						} else if (
							// Meta lists keep their order: only term IDs are sets.
							JSON.stringify( meta[ key ] ) !==
							JSON.stringify( metaValue )
						) {
							meta[ key ] = metaValue;
							metaChanged = true;
						}
					}
					if ( metaChanged ) {
						values.set( 'meta', meta );
						changed = true;
					}
					continue;
				}
				changed = set( name, value ) || changed;
			}
			if ( changed ) {
				listeners.forEach( ( listener ) => listener( origin ) );
			}
			return changed;
		},

		subscribe( listener ) {
			listeners.add( listener );
			return () => {
				listeners.delete( listener );
			};
		},
	};
}

/**
 * Turns an editor change set into the record changes DE-RTC keeps (the
 * `applyChangesToCRDTDoc` rules). For posts: only synced fields; a
 * lazily-serialized `content` is dropped (blocks are the content); a
 * change that clears blocks but carries content (the Code Editor) derives
 * blocks from that content; the "Auto Draft" placeholder title and an
 * empty slug never sync. `content` itself is never stored — the blocks
 * are the one representation. Other entities keep every field that is
 * not a function.
 *
 * @param changes    The editor's changes.
 * @param record     The record they apply to.
 * @param objectType The entity type (`postType/<name>` for posts).
 * @return The record changes.
 */
export function recordChangesFromEditor(
	changes: Record< string, unknown >,
	record: DeRtcRecord,
	objectType: string
): Record< string, unknown > {
	const result: Record< string, unknown > = {};
	if ( ! objectType.startsWith( 'postType/' ) ) {
		for ( const [ name, value ] of Object.entries( changes ) ) {
			if ( 'function' !== typeof value ) {
				result[ name ] = value;
			}
		}
		return result;
	}

	const synced = new Set( [ ...POST_SYNCED_PROPERTIES, ...record.keys() ] );
	for ( const [ name, value ] of Object.entries( changes ) ) {
		if ( ! synced.has( name ) || 'function' === typeof value ) {
			continue;
		}
		switch ( name ) {
			case 'content':
				// Never stored: blocks carry the content.
				break;
			case 'blocks': {
				if ( value ) {
					result.blocks = identifyEditorBlocks( value as any[] );
					break;
				}
				const raw = getRawValue( changes.content );
				if ( 'string' === typeof raw ) {
					result.blocks = identifyEditorBlocks( parse( raw ) );
				}
				break;
			}
			case 'title': {
				const raw = getRawValue( value ) ?? '';
				result.title =
					'Auto Draft' === raw && ! record.get( 'title' ) ? '' : raw;
				break;
			}
			case 'excerpt':
				result.excerpt = getRawValue( value ) ?? '';
				break;
			case 'slug':
				if ( value ) {
					result.slug = value;
				}
				break;
			default:
				result[ name ] = value;
		}
	}
	return result;
}

/**
 * Gives new editor blocks an identity before a record listener can send them.
 *
 * Gutenberg assigns a fresh UUID clientId on creation (including duplication).
 * Use that UUID here and in includes/shared/sync-id.js, which writes it into
 * the editor later. Both copies then agree even if capture beats that write.
 * Peers retain the serialized syncId, never their own parsed clientId. Existing
 * IDs, including server genesis IDs, remain unchanged. Blocks without an
 * editor clientId are left unchanged; only the creating editor assigns IDs.
 *
 * @param blocks The immutable editor tree.
 * @return The tree with missing and duplicate identities filled.
 */
function identifyEditorBlocks( blocks: any[] ): any[] {
	const seen = new Set< string >();
	const clientIds = new Set< string >();
	const collect = ( tree: any[] ) => {
		for ( const block of tree ) {
			if ( block.clientId ) {
				clientIds.add( block.clientId );
			}
			if ( block.innerBlocks ) {
				collect( block.innerBlocks );
			}
		}
	};
	collect( blocks );
	const walk = ( tree: any[] ): any[] => {
		let changed = false;
		const result = tree.map( ( block ) => {
			const syncId = block.attributes?.metadata?.syncId;
			// A copy may precede its source. Reserve creation IDs for their
			// original clientId so the source never loses its own identity.
			const belongsToAnother =
				syncId !== block.clientId && clientIds.has( syncId );
			const assign =
				( ! syncId || seen.has( syncId ) || belongsToAnother ) &&
				block.clientId;
			seen.add( assign ? block.clientId : syncId );
			const innerBlocks = block.innerBlocks && walk( block.innerBlocks );
			if ( ! assign && innerBlocks === block.innerBlocks ) {
				return block;
			}
			changed = true;
			return {
				...block,
				...( assign && {
					attributes: {
						...block.attributes,
						metadata: {
							...block.attributes?.metadata,
							syncId: block.clientId,
						},
					},
				} ),
				...( innerBlocks && { innerBlocks } ),
			};
		} );
		return changed ? result : tree;
	};
	return walk( blocks );
}

/**
 * The editor changes a record holds against the edited record (the
 * `getChangesFromCRDTDoc` rules): only fields that differ. For posts a
 * "floating" date and the invalid `auto-draft` status never overwrite the
 * editor, meta merges over the editor's meta and ignores keys the post
 * no longer registers, and changed blocks bring a lazy `content`
 * serializer so the post reads as dirty and saves the new content.
 *
 * @param record       The record.
 * @param editedRecord The editor's current record.
 * @param objectType   The entity type.
 * @return The changes to dispatch to the editor.
 */
export function editorChangesFromRecord(
	record: DeRtcRecord,
	editedRecord: Record< string, any >,
	objectType: string
): Record< string, unknown > {
	const changes: Record< string, unknown > = {};
	const isPost = objectType.startsWith( 'postType/' );
	for ( const name of record.keys() ) {
		const value = record.get( name );
		const current = editedRecord?.[ name ];
		if ( ! isPost ) {
			if ( ! valuesEqual( current, value ) ) {
				changes[ name ] = value;
			}
			continue;
		}
		switch ( name ) {
			case 'blocks':
				if ( value !== current ) {
					changes.blocks = value;
				}
				break;
			case 'date': {
				const floating =
					null === current || editedRecord.modified === current;
				if ( ! floating && ! valuesEqual( current, value ) ) {
					changes.date = value;
				}
				break;
			}
			case 'meta': {
				const currentMeta = ( current ?? {} ) as Record<
					string,
					unknown
				>;
				const allowed = Object.fromEntries(
					Object.entries(
						( value ?? {} ) as Record< string, unknown >
					).filter(
						( [ key ] ) =>
							! DISALLOWED_META_KEYS.has( key ) &&
							key in currentMeta
					)
				);
				const merged = { ...currentMeta, ...allowed };
				if ( ! valuesEqual( currentMeta, merged ) ) {
					changes.meta = merged;
				}
				break;
			}
			case 'status':
				if (
					'auto-draft' !== value &&
					! valuesEqual( current, value )
				) {
					changes.status = value;
				}
				break;
			case 'title':
			case 'excerpt':
				if ( ! valuesEqual( getRawValue( current ), value ) ) {
					changes[ name ] = value;
				}
				break;
			default:
				if ( ! valuesEqual( current, value ) ) {
					changes[ name ] = value;
				}
		}
	}
	if ( Array.isArray( changes.blocks ) ) {
		const blocks = changes.blocks;
		changes.content = () => serializeBlocks( blocks );
	}
	return changes;
}
