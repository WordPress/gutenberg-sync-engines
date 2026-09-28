/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * WordPress dependencies
 */
// __unstableSerializeAndClean is the exact serializer core-data uses when
// comparing CRDT blocks against persisted content; sharing it keeps proposal
// content byte-consistent with WordPress saves.
// eslint-disable-next-line import/no-unresolved, @wordpress/no-unsafe-wp-apis -- Provided at runtime as wp.blocks.
import { parse, __unstableSerializeAndClean } from '@wordpress/blocks';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { CRDT_RECORD_MAP_KEY } from '../yjs/constants';

/**
 * Origin tag for Yjs transactions that apply server-accepted canonical
 * content, so they are not mistaken for local edits (which would echo a
 * proposal) and so the entity's observers report them as remote changes.
 */
export const DE_RTC_REMOTE_ORIGIN = 'de-rtc-remote';

/**
 * Origin tag for Yjs transactions that restore a parked proposal's blocks
 * into the doc. Dual-natured by design: the entity's observers report it
 * to the EDITOR like a remote change (the restored blocks must reach the
 * canvas), while the session codec treats it as a LOCAL edit (the doc is
 * dirty and the restored state must re-propose under the restorer's
 * capability).
 */
export const DE_RTC_RESTORE_ORIGIN = 'de-rtc-restore';

/**
 * The shared per-entity state the engine entity and its session codec
 * both close over: the local Y.Doc that bridges the editor, and the
 * canonical version/content tracking the proposal wire needs.
 *
 * The doc is an EDITOR BRIDGE, not the sync substrate: the server's
 * canonical document is a serialized-block string, and this bridge
 * translates between that string and the editor's block model using the
 * editor's own parser/serializer (via the sync config's record↔doc
 * mapping, shared with the yjs engines).
 */
/**
 * How a contested block is addressed: its durable identity (syncId) when
 * every block of the document carries one, else its top-level index.
 */
export type DeRtcContestKey = string | number;

export interface DeRtcDocBridge {
	/** The Yjs document bridging the editor. */
	doc: Y.Doc;

	/** Whether the server's genesis (or any canonical row) has applied. */
	isBootstrapped: () => boolean;

	/** The version label of the last canonical state APPLIED to the doc. */
	lastVersion: () => string | null;

	/**
	 * Applies a server-accepted canonical state into the doc (remote
	 * origin) and advances the version tracking. Fires bootstrap
	 * listeners on the first application. Rows at or behind the version
	 * already incorporated are ignored (a deferred stale row must never
	 * regress the doc).
	 *
	 * @param version    Canonical version label.
	 * @param content    Canonical serialized-block content.
	 * @param properties Canonical entity-property map (flat, meta.<key>).
	 */
	applyCanonical: (
		version: string,
		content: string,
		properties?: Record< string, unknown >
	) => void;

	/**
	 * Advances the version WITHOUT touching the doc — for the client's
	 * own accepted proposal when it round-tripped unchanged: the doc
	 * already holds that content (plus any newer local keystrokes, which
	 * an application would clobber).
	 *
	 * @param version Canonical version label.
	 */
	advanceVersion: ( version: string ) => void;

	/**
	 * Incorporates a canonical state that arrived while local edits are
	 * pending: adopts canonical blocks the doc has NOT locally edited
	 * since `proposedContent` was proposed, keeps locally-edited blocks
	 * (the server merges them on the next proposal), and advances the
	 * version. Only valid when the block structure is unchanged on every
	 * side (equal block counts); returns false when it cannot align, in
	 * which case the caller keeps deferring.
	 *
	 * Per-block base honesty: when a kept block was ALSO changed in the
	 * arriving canonical (a true same-block collision), the version the
	 * doc held BEFORE this incorporation is recorded as that block's
	 * base. The next proposal carries the map, and the server merges the
	 * collided block from its TRUE base — non-overlapping concurrent
	 * edits merge, real overlaps park for review — instead of reading the
	 * re-proposal as a clean sole-writer change (the silent block-level
	 * last-writer-wins this client policy used to cause).
	 *
	 * @param version         Canonical version label.
	 * @param content         Canonical serialized-block content.
	 * @param proposedContent The content this client last proposed.
	 * @return Whether the canonical state was incorporated.
	 */
	incorporateCanonicalPreservingLocalEdits: (
		version: string,
		content: string,
		proposedContent: string
	) => boolean;

	/**
	 * The recorded true-base versions of blocks kept through a colliding
	 * incorporation, keyed by the block's durable identity (its
	 * `metadata.syncId`) — or, for documents whose blocks carry no
	 * identity, by top-level block index (JSON-string keys). The server
	 * accepts both key forms. Empty when no collision is pending.
	 */
	blockBaseVersions: () => Record< string, string >;

	/**
	 * Contested-block lifecycle (the validated pending-edits
	 * model): fired each time an incorporation keeps a locally-edited
	 * block that the arriving canonical ALSO changed. Repeats for the
	 * same block REFRESH the one contest (merge-not-stack) — the event
	 * always carries the LATEST canonical version and serialized form
	 * of the block.
	 */
	onContested: (
		listener: ( event: {
			/** The contest key: the block's syncId, or its top-level index. */
			key: DeRtcContestKey;
			/** The top-level index the block sits under (an anchor hint). */
			index: number;
			/** The block's durable identity, when it has one. */
			syncId?: string;
			version: string;
			html: string;
		} ) => void
	) => void;

	/**
	 * Fired when a contest resolves: the block adopted canonical (its
	 * kept form finally merged, a wholesale apply or version-only
	 * advance settled it), or an explicit Adopt/Reject verb ran.
	 */
	onContestResolved: ( listener: ( key: DeRtcContestKey ) => void ) => void;

	/**
	 * ADOPT: apply the contest's latest canonical block into the doc.
	 * Applied under the remote origin — it already IS canonical, so it
	 * must not mark the doc dirty or re-propose. Resolves the contest
	 * and clears the block's recorded base.
	 *
	 * @return Whether a contest existed for the index.
	 */
	adoptContestedBlock: ( key: DeRtcContestKey ) => boolean;

	/**
	 * REJECT: resolve the contest, KEEPING the local block and its
	 * recorded true base — the next proposal still declares it, so the
	 * server merges honestly (compatible edits merge, true overlaps
	 * park to the peer's review). A later peer edit to the same block
	 * raises a fresh contest.
	 *
	 * @return Whether a contest existed for the index.
	 */
	rejectContestedBlock: ( key: DeRtcContestKey ) => boolean;

	/** Serializes the doc's current blocks to proposal content. */
	buildContent: () => string;

	/**
	 * The doc's current entity-property registers in the wire shape: every
	 * record-map entry except `blocks`, Yjs values plainified, the `meta`
	 * map flattened to `meta.<key>` entries, taxonomy term-ID arrays in
	 * canonical numeric order (matching the server genesis seed).
	 */
	buildProperties: () => Record< string, unknown >;

	/**
	 * Incorporates the property half of the client's OWN accepted row:
	 * adopts a canonical value the client has NOT locally changed since
	 * proposing (the server merged a peer's property change into our
	 * row), and keeps locally-edited values (the next proposal
	 * reconciles them) — the property twin of the block incorporation
	 * policy.
	 *
	 * @param properties         Canonical property map from the row.
	 * @param proposedProperties The map this client last proposed.
	 */
	incorporateProperties: (
		properties: Record< string, unknown >,
		proposedProperties: Record< string, unknown >
	) => void;

	/**
	 * Registers a one-shot listener fired when the first canonical state
	 * applies (the bootstrap moment).
	 *
	 * @param listener Bootstrap callback.
	 */
	onBootstrap: ( listener: () => void ) => void;

	/**
	 * Adopts a version label WITHOUT touching the document: used when the
	 * room restarted and the local content is about to be re-proposed
	 * against the new genesis, so the doc keeps the person's edits while
	 * the version gate accepts the new lineage. Clears per-block bases and
	 * contests (they referenced the old lineage).
	 */
	adoptVersion: ( version: string ) => void;

	/**
	 * Forgets the room lineage (version and bootstrap state) so the next
	 * canonical row is applied as a fresh bootstrap regardless of its
	 * version number. The document itself is untouched.
	 */
	resetLineage: () => void;
}

/**
 * Parses canonical content into editor blocks, dropping the empty
 * freeform artifacts inter-block whitespace can produce (the server
 * merge core's wp_de_rtc_remove_empty_freeform_blocks twin).
 *
 * @param content Serialized block content.
 * @return Editor blocks.
 */
export function parseCanonicalBlocks(
	content: string
): ReturnType< typeof parse > {
	if ( ! content ) {
		return [];
	}
	return parse( content ).filter( ( block ) => {
		if ( ! block.name ) {
			return false;
		}
		if ( 'core/freeform' === block.name ) {
			const text = String( block.attributes?.content ?? '' ).trim();
			return '' !== text;
		}
		return true;
	} );
}

/**
 * One block's comparison form: its serialized markup. Every parse mints
 * a fresh clientId per block, so two independently parsed copies of the
 * same block are never structurally equal; the serializer drops the id.
 * It is the exact serializer core-data uses, so the form is also
 * byte-consistent with proposal content.
 *
 * @param block An editor block.
 * @return The block's serialized form.
 */
export function serializeBlock( block: unknown ): string {
	return __unstableSerializeAndClean( [ block as any ] ).trim();
}

/**
 * The indexes at which two block lists differ, compared position by
 * position, or null when the lists differ in length: positional
 * comparison is only meaningful across an unchanged structure.
 *
 * @param base One block list.
 * @param next The other block list.
 * @return Changed indexes, or null on a structural difference.
 */
export function changedBlockIndexes(
	base: unknown[],
	next: unknown[]
): number[] | null {
	if ( base.length !== next.length ) {
		return null;
	}
	const changed: number[] = [];
	for ( let index = 0; index < next.length; index++ ) {
		if (
			serializeBlock( base[ index ] ) !== serializeBlock( next[ index ] )
		) {
			changed.push( index );
		}
	}
	return changed;
}

/**
 * The durable identity of an editor block (`metadata.syncId`), if any.
 *
 * @param block Editor block.
 * @return The syncId, or undefined.
 */
export function syncIdOf( block: unknown ): string | undefined {
	const metadata = ( block as { attributes?: { metadata?: unknown } } )
		?.attributes?.metadata as { syncId?: unknown } | undefined;
	return 'string' === typeof metadata?.syncId ? metadata.syncId : undefined;
}

/**
 * Re-keys freshly parsed canonical blocks onto the clientIds the doc
 * already holds for the same durable identities, at every depth.
 *
 * Every parse mints fresh clientIds, and the framework's block merge
 * accepts incoming clientIds — so without this, every canonical
 * application remounted every block on the canvas (focus, open dropdowns,
 * and the caret's block all reset). A block that kept its `metadata.syncId`
 * across the round trip is the same block: it keeps its clientId. Blocks
 * the doc does not know keep their fresh ids, and a duplicated identity
 * maps once (clientIds must stay unique).
 *
 * @param blocks      Freshly parsed canonical blocks (mutated in place).
 * @param localBlocks The doc's current blocks (JSON).
 */
export function stabilizeClientIds(
	blocks: unknown[],
	localBlocks: unknown[]
): void {
	const clientIdBySyncId = new Map< string, string >();
	const collect = ( nodes: unknown[] ) => {
		for ( const node of nodes ) {
			const block = node as {
				clientId?: unknown;
				innerBlocks?: unknown[];
			};
			const syncId = syncIdOf( block );
			if (
				syncId &&
				'string' === typeof block.clientId &&
				! clientIdBySyncId.has( syncId )
			) {
				clientIdBySyncId.set( syncId, block.clientId );
			}
			if ( Array.isArray( block.innerBlocks ) ) {
				collect( block.innerBlocks );
			}
		}
	};
	collect( localBlocks );
	if ( 0 === clientIdBySyncId.size ) {
		return;
	}

	const used = new Set< string >();
	const assign = ( nodes: unknown[] ) => {
		for ( const node of nodes ) {
			const block = node as {
				clientId?: string;
				innerBlocks?: unknown[];
			};
			const syncId = syncIdOf( block );
			const clientId = syncId
				? clientIdBySyncId.get( syncId )
				: undefined;
			if ( clientId && ! used.has( clientId ) ) {
				block.clientId = clientId;
				used.add( clientId );
			}
			if ( Array.isArray( block.innerBlocks ) ) {
				assign( block.innerBlocks );
			}
		}
	};
	assign( blocks );
}

/**
 * Replaces the block carrying a syncId, wherever it sits in the tree.
 *
 * @param blocks      Block tree (mutated in place).
 * @param syncId      The identity to find.
 * @param replacement The block to put in its place.
 * @return Whether a block was replaced.
 */
export function replaceBlockBySyncId(
	blocks: unknown[],
	syncId: string,
	replacement: unknown
): boolean {
	for ( let i = 0; i < blocks.length; i++ ) {
		const block = blocks[ i ] as { innerBlocks?: unknown[] };
		if ( syncIdOf( block ) === syncId ) {
			blocks[ i ] = replacement;
			return true;
		}
		if (
			Array.isArray( block.innerBlocks ) &&
			replaceBlockBySyncId( block.innerBlocks, syncId, replacement )
		) {
			return true;
		}
	}
	return false;
}

/** One block of an identity map (see flattenByIdentity). */
export type IdentityNode = {
	block: any;
	parent: string | null;
	/** The block's own form: name + attributes, children excluded. */
	own: string;
	childIds: string[];
};

/**
 * Flattens a tree into an identity map, or null when any block lacks a
 * syncId or two blocks share one (identity cannot be trusted).
 *
 * @param blocks Block tree.
 * @return Map by syncId, with the root order under the empty key.
 */
export function flattenByIdentity(
	blocks: unknown[]
): { nodes: Map< string, IdentityNode >; roots: string[] } | null {
	const nodes = new Map< string, IdentityNode >();
	const serializeOwn = ( block: any ) =>
		__unstableSerializeAndClean( [ { ...block, innerBlocks: [] } ] ).trim();
	const walk = (
		list: unknown[],
		parent: string | null
	): string[] | null => {
		const ids: string[] = [];
		for ( const raw of list ) {
			const block = raw as any;
			const id = syncIdOf( block );
			if ( ! id || nodes.has( id ) ) {
				return null;
			}
			const node: IdentityNode = {
				block,
				parent,
				own: serializeOwn( block ),
				childIds: [],
			};
			nodes.set( id, node );
			const childIds = walk( block.innerBlocks ?? [], id );
			if ( null === childIds ) {
				return null;
			}
			node.childIds = childIds;
			ids.push( id );
		}
		return ids;
	};
	const roots = walk( blocks, null );
	return null === roots ? null : { nodes, roots };
}

/**
 * The identity-keyed incorporation (see the bridge's
 * incorporateCanonicalPreservingLocalEdits): rebuilds the doc from the
 * canonical structure, keeping locally-edited own content and locally-born
 * blocks. Null when any side lacks identity — the positional rule applies.
 *
 * @param canonical             Canonical blocks (clientIds already stabilized).
 * @param proposed              The blocks this client last proposed.
 * @param local                 The doc's current blocks.
 * @param state                 Bridge bookkeeping.
 * @param state.priorVersion    The version the doc held before this incorporation.
 * @param state.nextVersion     The canonical version being incorporated.
 * @param state.blockBases      The per-block true-base record (mutated).
 * @param state.contestedLatest The latest canonical form per contest (mutated).
 * @param state.resolveContest  Resolves a contest whose block adopted canonical.
 * @return The merged blocks and the keys that collided, or null.
 */
function incorporateByIdentity(
	canonical: unknown[],
	proposed: unknown[],
	local: unknown[],
	state: {
		priorVersion: string | null;
		nextVersion: string;
		blockBases: Map< DeRtcContestKey, string >;
		contestedLatest: Map<
			DeRtcContestKey,
			{ version: string; block: unknown; index: number }
		>;
		resolveContest: ( key: DeRtcContestKey ) => void;
	}
): { blocks: unknown[]; collided: string[] } | null {
	const C = flattenByIdentity( canonical );
	const P = flattenByIdentity( proposed );
	const L = flattenByIdentity( local );
	if ( ! C || ! P || ! L ) {
		return null;
	}
	const collided: string[] = [];
	const placed = new Set< string >();

	// Locally-born blocks (not in the proposal) go after the local
	// sibling they follow; those whose parent vanished re-home at the
	// root end, so nothing typed since proposing is lost.
	const localNewborns = ( parent: string | null ): string[] => {
		const siblings =
			null === parent ? L.roots : L.nodes.get( parent )?.childIds ?? [];
		return siblings.filter( ( id ) => ! P.nodes.has( id ) );
	};
	const weave = ( ordered: string[], parent: string | null ): string[] => {
		const result = ordered.slice();
		const siblings =
			null === parent ? L.roots : L.nodes.get( parent )?.childIds ?? [];
		for ( const id of localNewborns( parent ) ) {
			if ( result.includes( id ) ) {
				continue;
			}
			let at = 0;
			for ( let back = siblings.indexOf( id ) - 1; back >= 0; back-- ) {
				const anchor = result.indexOf( siblings[ back ] );
				if ( -1 !== anchor ) {
					at = anchor + 1;
					break;
				}
			}
			result.splice( at, 0, id );
		}
		return result;
	};

	const build = ( id: string, topIndex: number ): unknown | null => {
		placed.add( id );
		const cn = C.nodes.get( id );
		const pn = P.nodes.get( id );
		const ln = L.nodes.get( id );
		let own: any;
		let childSource: string[];
		if ( cn && pn && ! ln ) {
			return null; // Deleted locally since proposing.
		}
		if ( ! cn ) {
			// Born locally since proposing (or re-homed): local form.
			own = ln!.block;
			childSource = ln!.childIds;
		} else if ( ! pn || ! ln ) {
			// New from the server: canonical form.
			own = cn.block;
			childSource = cn.childIds;
		} else {
			const locallyEdited = ln.own !== pn.own;
			if ( ! locallyEdited ) {
				state.blockBases.delete( id );
				state.resolveContest( id );
				own = cn.block;
			} else {
				own = ln.block;
				if ( cn.own !== pn.own ) {
					if (
						! state.blockBases.has( id ) &&
						null !== state.priorVersion
					) {
						state.blockBases.set( id, state.priorVersion );
					}
					state.contestedLatest.set( id, {
						version: state.nextVersion,
						block: cn.block,
						index: topIndex,
					} );
					collided.push( id );
				}
			}
			childSource = cn.childIds;
		}
		const innerBlocks: unknown[] = [];
		for ( const childId of weave( childSource, id ) ) {
			if ( placed.has( childId ) ) {
				continue;
			}
			const child = build( childId, topIndex );
			if ( null !== child ) {
				innerBlocks.push( child );
			}
		}
		return { ...own, innerBlocks };
	};

	const blocks: unknown[] = [];
	for ( const id of weave( C.roots, null ) ) {
		if ( placed.has( id ) ) {
			continue;
		}
		const built = build( id, blocks.length );
		if ( null !== built ) {
			blocks.push( built );
		}
	}
	// Orphans: locally-born blocks whose parent is gone.
	for ( const [ id, node ] of L.nodes ) {
		if (
			! placed.has( id ) &&
			! P.nodes.has( id ) &&
			null !== node.parent &&
			! placed.has( node.parent )
		) {
			const built = build( id, blocks.length );
			if ( null !== built ) {
				blocks.push( built );
			}
		}
	}
	return { blocks, collided };
}

/**
 * Order-tolerant value equality for property registers: term-ID arrays
 * are sets (numeric lists compare sorted); everything else compares by
 * JSON encoding. The client twin of the server's property comparison.
 *
 * @param a One value.
 * @param b Other value.
 * @return Whether the values are equal.
 */
export function propertyValuesEqual( a: unknown, b: unknown ): boolean {
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
 * Unflattens a wire property map (`meta.<key>` entries beside plain
 * properties) into the change shape the sync config applies: meta keys
 * regroup under one partial `meta` object (the config merges meta per
 * key, so a partial object never wipes sibling keys).
 *
 * @param flat Flat wire property map.
 * @return Record changes.
 */
export function unflattenProperties(
	flat: Record< string, unknown >
): Record< string, unknown > {
	const changes: Record< string, unknown > = {};
	let meta: Record< string, unknown > | null = null;
	for ( const [ name, value ] of Object.entries( flat ) ) {
		if ( name.startsWith( 'meta.' ) ) {
			meta = meta ?? {};
			meta[ name.slice( 'meta.'.length ) ] = value;
		} else {
			changes[ name ] = value;
		}
	}
	if ( meta ) {
		changes.meta = meta;
	}
	return changes;
}

/**
 * Creates the shared doc bridge for one entity.
 *
 * @param doc        The entity's Yjs document.
 * @param syncConfig The sync config supplying the record↔doc mapping.
 * @return The doc bridge.
 */
export function createDeRtcDocBridge(
	doc: Y.Doc,
	syncConfig: SyncConfig
): DeRtcDocBridge {
	let bootstrapped = false;
	let version: string | null = null;
	// Per-block true bases of blocks kept through colliding
	// incorporations: block index -> the version their local
	// text was really written against.
	const blockBases = new Map< DeRtcContestKey, string >();
	// The latest canonical form of each contested block:
	// refreshed on every colliding row (merge-not-stack), consumed by
	// the Adopt verb, cleared whenever the contest resolves.
	const contestedLatest = new Map<
		DeRtcContestKey,
		{ version: string; block: unknown; index: number }
	>();
	const contestedListeners = new Set<
		( event: {
			key: DeRtcContestKey;
			index: number;
			syncId?: string;
			version: string;
			html: string;
		} ) => void
	>();
	const contestResolvedListeners = new Set<
		( key: DeRtcContestKey ) => void
	>();

	const emitContested = ( key: DeRtcContestKey ) => {
		const entry = contestedLatest.get( key );
		if ( ! entry ) {
			return;
		}
		const html = __unstableSerializeAndClean( [
			entry.block as any,
		] ).trim();
		contestedListeners.forEach( ( listener ) =>
			listener( {
				key,
				index: entry.index,
				...( 'string' === typeof key ? { syncId: key } : {} ),
				version: entry.version,
				html,
			} )
		);
	};
	const resolveContest = ( key: DeRtcContestKey ) => {
		if ( contestedLatest.delete( key ) ) {
			contestResolvedListeners.forEach( ( listener ) => listener( key ) );
		}
	};
	const resolveAllContests = () => {
		for ( const key of Array.from( contestedLatest.keys() ) ) {
			resolveContest( key );
		}
	};
	let bootstrapListeners: Array< () => void > = [];

	// Version labels are the server's monotonic 'v<seq>' scheme.
	const seqOf = ( label: string | null ): number =>
		null === label ? 0 : parseInt( label.replace( /^v/, '' ), 10 ) || 0;

	// The doc's current blocks as plain JSON (the record map holds a
	// Y.Array under the framework's mapping, a plain array under tests).
	const localBlocksJson = (): any[] => {
		const stored: any = doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' );
		return stored?.toJSON?.() ?? ( Array.isArray( stored ) ? stored : [] );
	};

	const markVersion = ( nextVersion: string ) => {
		version = nextVersion;
		if ( ! bootstrapped ) {
			bootstrapped = true;
			const listeners = bootstrapListeners;
			bootstrapListeners = [];
			listeners.forEach( ( listener ) => listener() );
		}
	};

	const readFlatProperties = (): Record< string, unknown > => {
		const flat: Record< string, unknown > = {};
		doc.getMap( CRDT_RECORD_MAP_KEY ).forEach(
			( stored: any, name: string ) => {
				/*
				 * `blocks` IS the content model; a `content` record-map
				 * entry (core-data mirrors the serialized string into the
				 * doc) would duplicate the ENTIRE document as a property
				 * register on every proposal and every announce — the
				 * double-carry that wire inspection caught. One
				 * representation: content travels as content, never as a
				 * property.
				 */
				if ( 'blocks' === name || 'content' === name ) {
					return;
				}
				const value =
					stored && 'function' === typeof stored.toJSON
						? stored.toJSON()
						: stored;
				if ( 'meta' === name ) {
					if ( value && 'object' === typeof value ) {
						for ( const [ metaKey, metaValue ] of Object.entries(
							value as Record< string, unknown >
						) ) {
							flat[ `meta.${ metaKey }` ] = metaValue;
						}
					}
					return;
				}
				if (
					Array.isArray( value ) &&
					value.every( ( entry ) => 'number' === typeof entry )
				) {
					// Term bindings are sets: canonical numeric order,
					// matching the server genesis seed.
					flat[ name ] = [ ...value ].sort( ( a, b ) => a - b );
					return;
				}
				flat[ name ] = value;
			}
		);
		return flat;
	};

	return {
		doc,

		isBootstrapped: () => bootstrapped,

		lastVersion: () => version,

		adoptVersion( nextVersion ) {
			blockBases.clear();
			resolveAllContests();
			markVersion( nextVersion );
		},

		resetLineage() {
			bootstrapped = false;
			version = null;
			blockBases.clear();
			resolveAllContests();
		},

		applyCanonical( nextVersion, content, properties ) {
			if ( bootstrapped && seqOf( nextVersion ) <= seqOf( version ) ) {
				return;
			}
			const blocks = parseCanonicalBlocks( content );
			stabilizeClientIds( blocks, localBlocksJson() );
			const changes: Record< string, unknown > = properties
				? { ...unflattenProperties( properties ), blocks }
				: { blocks };
			doc.transact( () => {
				syncConfig.applyChangesToCRDTDoc( doc, changes );
			}, DE_RTC_REMOTE_ORIGIN );
			// Wholesale adoption: every pending collision resolved.
			blockBases.clear();
			resolveAllContests();
			markVersion( nextVersion );
		},

		advanceVersion( nextVersion ) {
			if ( bootstrapped && seqOf( nextVersion ) <= seqOf( version ) ) {
				return;
			}
			// Our proposal round-tripped unchanged: every kept block's
			// content IS canonical now.
			blockBases.clear();
			resolveAllContests();
			markVersion( nextVersion );
		},

		incorporateCanonicalPreservingLocalEdits(
			nextVersion,
			content,
			proposedContent
		) {
			if ( bootstrapped && seqOf( nextVersion ) <= seqOf( version ) ) {
				return true; // Stale row: nothing to incorporate.
			}

			const canonicalBlocks = parseCanonicalBlocks( content );
			const proposedBlocks = parseCanonicalBlocks( proposedContent );
			const localBlocks = localBlocksJson();
			stabilizeClientIds( canonicalBlocks, localBlocks );

			/*
			 * By identity when every block carries one: a client-side
			 * three-way (proposed = base, canonical = theirs, local =
			 * mine) block-for-block at every depth. Blocks the doc did not
			 * touch since proposing adopt canonical; kept blocks that
			 * canonical ALSO changed record their true base and raise a
			 * contest keyed by syncId; blocks born locally since proposing
			 * stay next to the sibling they followed. No equal-count
			 * restriction — structure merges by identity like content.
			 */
			const byIdentity = incorporateByIdentity(
				canonicalBlocks,
				proposedBlocks,
				localBlocks,
				{
					priorVersion: version,
					nextVersion,
					blockBases,
					contestedLatest,
					resolveContest,
				}
			);
			if ( null !== byIdentity ) {
				doc.transact( () => {
					syncConfig.applyChangesToCRDTDoc( doc, {
						blocks: byIdentity.blocks,
					} );
				}, DE_RTC_REMOTE_ORIGIN );
				markVersion( nextVersion );
				byIdentity.collided.forEach( emitContested );
				return true;
			}

			// Index alignment is only sound when the LOCAL structure is
			// unchanged since the proposal and the canonical either matches
			// it or extends it (a peer appended blocks — adopted below).
			// Anything else (local structure changes mid-flight, peer
			// deletions or mid-document insertions) keeps deferring until
			// the local state settles.
			if (
				localBlocks.length !== proposedBlocks.length ||
				canonicalBlocks.length < proposedBlocks.length
			) {
				return false;
			}
			for ( let i = 0; i < proposedBlocks.length; i++ ) {
				if ( canonicalBlocks[ i ].name !== proposedBlocks[ i ].name ) {
					return false;
				}
			}

			// Both lists are proposal-length here (checked above), so
			// neither diff can report a structural difference.
			const locallyEdited = new Set(
				changedBlockIndexes( localBlocks, proposedBlocks ) ?? []
			);
			const canonicalChanged = new Set(
				changedBlockIndexes(
					canonicalBlocks.slice( 0, proposedBlocks.length ),
					proposedBlocks
				) ?? []
			);

			const priorVersion = version;
			const collided: number[] = [];
			const merged = proposedBlocks
				.map( ( proposedBlock, index ) => {
					if ( ! locallyEdited.has( index ) ) {
						// Adopting canonical resolves any pending
						// collision on this block.
						blockBases.delete( index );
						resolveContest( index );
						return canonicalBlocks[ index ];
					}
					// Kept. If canonical ALSO changed this block, that is
					// a true same-block collision: remember the version
					// our text was really written against (once — the
					// OLDEST pending base wins), so the next proposal
					// tells the server the truth instead of presenting a
					// clean sole-writer change.
					if ( canonicalChanged.has( index ) ) {
						if (
							! blockBases.has( index ) &&
							null !== priorVersion
						) {
							blockBases.set( index, priorVersion );
						}
						// The contest tracks the LATEST canonical form:
						// repeats refresh the one pending item, never a
						// second one (merge-not-stack).
						contestedLatest.set( index, {
							version: nextVersion,
							block: canonicalBlocks[ index ],
							index,
						} );
						collided.push( index );
					}
					return localBlocks[ index ];
				} )
				.concat( canonicalBlocks.slice( proposedBlocks.length ) );

			doc.transact( () => {
				syncConfig.applyChangesToCRDTDoc( doc, { blocks: merged } );
			}, DE_RTC_REMOTE_ORIGIN );
			markVersion( nextVersion );
			collided.forEach( emitContested );

			return true;
		},

		buildContent() {
			// Serialize the doc's blocks the way core-data itself does when
			// comparing CRDT state against persisted content — proposal
			// content stays byte-consistent with what a WordPress save of
			// the same blocks would produce (the server's hash fast-paths
			// depend on that stability).
			const stored: any = doc
				.getMap( CRDT_RECORD_MAP_KEY )
				.get( 'blocks' );
			const blocks =
				stored?.toJSON?.() ?? ( Array.isArray( stored ) ? stored : [] );
			return __unstableSerializeAndClean( blocks ).trim();
		},

		buildProperties: readFlatProperties,

		blockBaseVersions() {
			const map: Record< string, string > = {};
			for ( const [ key, baseVersion ] of blockBases ) {
				map[ String( key ) ] = baseVersion;
			}
			return map;
		},

		onContested( listener ) {
			contestedListeners.add( listener );
		},

		onContestResolved( listener ) {
			contestResolvedListeners.add( listener );
		},

		adoptContestedBlock( key ) {
			const entry = contestedLatest.get( key );
			if ( ! entry ) {
				return false;
			}
			const blocks: unknown[] = localBlocksJson().slice();
			if ( 'string' === typeof key ) {
				replaceBlockBySyncId( blocks, key, entry.block );
			} else if ( key < blocks.length ) {
				blocks[ key ] = entry.block;
			}
			// Remote origin: this content already IS canonical — it must
			// not mark the doc dirty or re-propose.
			doc.transact( () => {
				syncConfig.applyChangesToCRDTDoc( doc, { blocks } );
			}, DE_RTC_REMOTE_ORIGIN );
			blockBases.delete( key );
			resolveContest( key );
			return true;
		},

		rejectContestedBlock( key ) {
			if ( ! contestedLatest.has( key ) ) {
				return false;
			}
			// Keep the local block AND its recorded true base: the next
			// proposal still declares it (per-block base honesty). Only the
			// pending item resolves; a later peer edit raises a fresh one.
			resolveContest( key );
			return true;
		},

		incorporateProperties( properties, proposedProperties ) {
			const currentFlat = readFlatProperties();
			const adopt: Record< string, unknown > = {};
			for ( const [ name, value ] of Object.entries( properties ) ) {
				if (
					propertyValuesEqual( value, proposedProperties[ name ] )
				) {
					continue; // Nothing changed server-side.
				}
				if (
					propertyValuesEqual(
						currentFlat[ name ],
						proposedProperties[ name ]
					)
				) {
					// Untouched locally since proposing: adopt the
					// server-merged value (a peer's change).
					adopt[ name ] = value;
				}
				// Locally edited since proposing: keep ours; the next
				// proposal reconciles (block-incorporation's LWW twin).
			}
			if ( 0 === Object.keys( adopt ).length ) {
				return;
			}
			doc.transact( () => {
				syncConfig.applyChangesToCRDTDoc(
					doc,
					unflattenProperties( adopt )
				);
			}, DE_RTC_REMOTE_ORIGIN );
		},

		onBootstrap( listener ) {
			if ( bootstrapped ) {
				listener();
				return;
			}
			bootstrapListeners.push( listener );
		},
	};
}
