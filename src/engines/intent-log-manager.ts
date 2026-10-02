/**
 * Internal dependencies
 */
/**
 * External dependencies
 */
import type { Awareness } from 'y-protocols/awareness';

/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';
import { parse as parseBlockDelimiters } from '@wordpress/block-serialization-default-parser';
// eslint-disable-next-line import/no-unresolved -- Provided by the editor runtime.
import { getBlockType, getSaveContent } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { createAwarenessDoc } from './awareness-sync';
import { registerAwareness } from '../awareness/registry';
import {
	applyDerivedIntents,
	deriveIntents,
	documentDistance,
	engineDocumentToBlocks,
	summarizeEditorTree,
	type RawContentAdapter,
	type RichTextFieldsResolver,
	type BridgeBlock,
} from './intent-log-bridge';
import {
	createIntentLogSession,
	randomClientId,
	type IntentLogSession,
} from './intent-log-session';
import { mintSyncId } from './intent-log/sync-id.js';
import { fieldToHtml } from './intent-log/rich-text.js';
import {
	createIntentLogUndoManager,
	type IntentLogUndoManager,
} from './intent-log-undo';
import { getProviderCreators, LOCAL_UNDO_IGNORED_ORIGIN } from '../framework';
import type { EngineDocument } from './intent-log/engine-types';
import type {
	CollectionHandlers,
	ObjectData,
	ObjectID,
	ObjectType,
	ProviderCreator,
	ProviderCreatorResult,
	RecordHandlers,
	SyncConfig,
	SyncManager,
} from '@wordpress/sync';

/*
 * The intent-log SyncManager: the engine adapter surface core-data drives,
 * implemented over an IntentLogSession per entity plus the capture bridge.
 *
 * Where the Yjs manager maintains a CRDT doc and diffs into Y types, this
 * manager keeps the session's engine document as the shared state:
 *
 * - editor → wire: update() derives verified intents from the incoming
 *   block tree (capture bridge) and authors them through the session, which
 *   emits wire updates to the transport;
 * - wire → editor: session change events map the engine document back to
 *   blocks and dispatch editRecord, guarded against echo loops by
 *   canonical-state comparison.
 *
 * THE OBSERVED BASELINE. An editor tree is not testimony about the CURRENT
 * shared document — it is testimony about the document state the editor
 * last saw, plus the user's edits on top. Capture therefore diffs each tree
 * against that observed state and authors the result AT ITS SEQ, leaving
 * the engine's transform to merge it with everything that landed since.
 * Diffing against the head instead is what made a push racing live
 * keystrokes destructive: the tree, still lacking the pushed remote text,
 * read as a deletion of it.
 *
 * Which state the editor last saw is not directly observable (the block
 * editor reports nothing when it applies a push, and a push can be
 * superseded by an in-flight editor change before it ever renders), so the
 * manager keeps candidates: the last CONFIRMED observed state plus every
 * push still unconfirmed. An arriving tree is matched to the candidate it
 * differs from least (documentDistance) — a tree is always one of them plus
 * a small edit. Ties keep the confirmed one: an unconfirmed push must never
 * be the excuse for authoring a destructive diff. A push nobody contradicts
 * within PUSH_OBSERVED_DELAY is confirmed on its own, since a quiet editor
 * has certainly rendered it.
 *
 * Scope (documented in ARCHITECTURE.md):
 * - Blocks sync through the capture bridge; entity properties sync as
 *   per-name registers via set_property intents — the framework's scalar
 *   synced-property set (SYNCED_PROPERTIES), the post type's attached
 *   taxonomies (term-ID-array registers by rest_base), and registered
 *   post meta (per-key registers under `meta.<key>` names, minus the
 *   persisted-CRDT denylist).
 * - Undo is COLLABORATIVE: inverse intents over the accepted log (see
 *   intent-log-undo.ts). The manager exposes its own undo manager, so
 *   core-data routes undo/redo through it; each capture batch and each
 *   property push forms one undo unit.
 * - No CRDT-doc persistence/snapshots (server materializes instead), so
 *   createPersistedCRDTDoc/getEntitySnapshot return null/undefined and
 *   entityContainsSnapshot returns false (callers fail open).
 */

/**
 * A document state the editor is (or may be) displaying: the module note's
 * observed baseline, and every unconfirmed push candidate.
 */
interface ObservedState {
	/** The engine document. */
	doc: EngineDocument;
	/** Engine log position it was read at (the seq captures author at). */
	seq: number;
	/** Canonical bridge-block form, for cheap divergence tests. */
	json: string;
}

/**
 * How long a push goes unchallenged before it counts as observed. Only a
 * tree arriving from the editor can contradict it, and the block editor
 * applies a push within a render — so silence for this long means it landed.
 */
const PUSH_OBSERVED_DELAY = 1200;

/**
 * How long a capture-driven editor sync waits for the typing burst to fall
 * quiet (see scheduleEditorSync). Long enough that it does not reset the
 * block store between keystrokes, short enough that identity write-backs
 * land while the user is still on the same paragraph.
 */
const CAPTURE_SYNC_DELAY = 1200;

/**
 * How recently the editor must have typed for remote application to be
 * deferred to the settled editor sync instead of pushed immediately (see
 * the onChange tail). Distinct from CAPTURE_SYNC_DELAY: this only decides
 * WHETHER to defer; the deferred sync still waits the full capture delay.
 */
const PUSH_QUIET_MS = 500;

/**
 * Cap on unconfirmed push candidates. Pushes supersede each other in the
 * editor (only the last value of the controlled block list is rendered), so
 * the recent ones are the only plausible baselines.
 */
const MAX_PENDING_PUSHES = 8;

interface EntityState {
	session: IntentLogSession;
	handlers: RecordHandlers;
	providers: ProviderCreatorResult[];
	unloaded: boolean;
	/** Presence surface for the collaborator UI (see getAwareness). */
	awareness?: Awareness;
	/**
	 * Stable clientId per syncId for blocks pushed to the editor. The
	 * block-editor store keys blocks by clientId; pushing without one makes
	 * the canvas silently drop the tree (debug bundles) or remount blocks
	 * on every push (losing selection). Stability across pushes lets React
	 * reconcile in place.
	 */
	clientIds: Map< string, string >;
	/** Monotonic push counter, guarding stale confirmation timers. */
	pushSeq: number;
	/** Pending capture-driven editor sync (see scheduleEditorSync). */
	syncTimer: ReturnType< typeof setTimeout > | null;
	/** Whether that pending sync must push regardless of divergence. */
	syncForce: boolean;
	/**
	 * The state the editor is understood to display, and the seq captures
	 * are authored at. Null until the room snapshot arrives.
	 */
	observed: ObservedState | null;
	/**
	 * Pushes dispatched but not yet confirmed as displayed (see the module
	 * note): candidate baselines for the next tree, newest last.
	 */
	pendingPushes: ObservedState[];
	/**
	 * The latest block tree the editor handed to update() BEFORE the room
	 * snapshot arrived. Pre-init edits cannot be authored (there is no
	 * document yet) and the capture lane is edge-triggered, so without
	 * this buffer an edit made during the join round trip stays local
	 * forever — the fuzzer found it as a reload straddling a block insert
	 * on an empty-genesis room, where the bootstrap push (which would at
	 * least reconcile the trees) is skipped too. An empty-genesis
	 * bootstrap schedules a deferred capture of it (see the bootstrap
	 * branch for why deferred and why only-when-still-empty); a non-empty
	 * bootstrap or any newer post-init editor tree discards it.
	 */
	preInitTree: BridgeBlock[] | null;
	/**
	 * When the editor last handed update() a block tree — the typing-hot
	 * signal for the remote-push gate (see the onChange tail). A push
	 * landing mid-burst remounts the block under the caret and the
	 * user's next keystrokes die in a detached node (found by the
	 * real-websocket e2e lane, where remote rows arrive per-keystroke
	 * instead of per poll; de-rtc got the equivalent gate first).
	 */
	lastEditorEditAt: number;
	/**
	 * Whether a stale-base void recovery is already scheduled (a whole
	 * authoring ladder voids together — one re-capture per burst; see
	 * the onDisposition handler).
	 */
	staleVoidRecapturePending: boolean;
	/**
	 * Whether the next bootstrap change event follows a mid-session
	 * horizon reset WITH local work on the canvas — it must recapture
	 * the editor tree instead of pushing the checkpoint document over
	 * it (see onReset).
	 */
	resetRecapturePending: boolean;
	/**
	 * The latest block tree the editor handed to update() — the
	 * known-good capture shape the stale-void recovery re-derives from.
	 * (core-data's getEditedRecord() returns blocks in a shape the
	 * bridge's derive/verify rejects wholesale — observed as derive
	 * returning null — so recovery must reuse the feed's own trees.)
	 */
	lastEditorTree: BridgeBlock[] | null;
	/**
	 * Whether update() is currently authoring captured intents. The
	 * session emits change events synchronously per authored intent;
	 * those are the editor's own state and must not bounce back.
	 */
	capturing: boolean;
	/**
	 * Ids the editor has actually displayed (last agreed view). Only these
	 * may be DELETED by a capture diff: a document block missing from the
	 * editor tree but never displayed is staleness, not a deletion.
	 *
	 * Three seeding sources, all proofs of display:
	 * 1. persisted syncIds parsed from the record the editor loaded and
	 *    rendered (covers blocks saved after the room's genesis — a late
	 *    joiner bootstraps from the old genesis or a checkpoint yet has
	 *    displayed the newer saved blocks);
	 * 2. the seq-0 genesis bootstrap document, derived from the same saved
	 *    content the editor parsed (covers legacy content whose ids exist
	 *    only as deterministic genesis mints);
	 * 3. every tree the editor hands to update() — its ongoing testimony.
	 */
	editorIds: Set< string >;
	/**
	 * Whether the bootstrap document has been offered for genesis seeding
	 * (one-shot, on the first post-initialization change event).
	 */
	genesisSeeded: boolean;
	/** Document ids as of the previous session change (tombstone diffing). */
	prevDocIds: Set< string >;
	/**
	 * Ids removed from the document by remote intents. A stale editor tree
	 * still showing them must not resurrect them.
	 */
	docTombstones: Set< string >;
	/**
	 * Last property values pushed to (or captured from) the editor, for
	 * property echo suppression (meta registers included, under their
	 * `meta.<key>` names). Seeded from the loaded record so the genesis
	 * snapshot's properties are not re-pushed as edits.
	 */
	lastPushedProps: Record< string, unknown >;
	/**
	 * The property names this entity syncs: the static scalar whitelist
	 * plus the post type's attached taxonomies (by rest_base), resolved
	 * once at load.
	 */
	syncedProperties: string[];
	/**
	 * Mirror of the edited record's meta object. Every meta edit flows
	 * through update() — as the FULL merged object from editor edits
	 * (mergedEdits) or a PARTIAL subkey set from the post-save feed — so
	 * merging each arrival keeps this current. Meta pushes merge changed
	 * registers over it (the raw editRecord dispatch replaces `meta`
	 * wholesale, so a partial push would wipe sibling keys), and its key
	 * set is the orphaned-register guard: a `meta.<key>` register with no
	 * counterpart key here is unregistered for this post and pushing it
	 * would mark the post permanently dirty.
	 */
	knownMeta: Record< string, unknown >;
	/**
	 * Rich-text attribute names per block type (from the entity syncConfig,
	 * backed by the block registry). Names both the fields the bridge
	 * captures and the fields it serializes back into attributes.
	 */
	fieldsResolver: RichTextFieldsResolver;
	rawContent?: RawContentAdapter;
}

/**
 * A loaded collection room (post lists, taxonomy term lists): the
 * notification-and-refetch lane. Collection documents carry no records —
 * only per-client save registers (COLLECTION_SAVE_PREFIX names) — and a
 * peer's register write means "a record of this type was saved; refetch
 * the REST query". Mirrors the framework's EngineCollection contract
 * (markSaved → onPeerSave) without syncing record content, which is what
 * lets a newly created category reach every collaborator's term list.
 */
interface CollectionState {
	session: IntentLogSession;
	providers: ProviderCreatorResult[];
	unloaded: boolean;
	/** Presence surface (optional; taxonomy configs may not define one). */
	awareness?: Awareness;
	/** This client's save register name (its writes never refetch). */
	selfRegister: string;
	/** Monotonic value for the save register (one bump per save). */
	saveSeq: number;
	/** A save announced before the room bootstrap, replayed on init. */
	pendingSave: boolean;
	/** Peer-register snapshot, null until the bootstrap baseline is set. */
	lastSignature: string | null;
}

/**
 * Register-name prefix for collection save signals. Each client writes
 * ONLY its own register (suffixed with its actor identity), so concurrent
 * saves by different clients touch different names and can never escalate
 * a property conflict — an escalated (parked) save signal would silently
 * cost a peer its refetch.
 */
const COLLECTION_SAVE_PREFIX = 'savedAt:';

/**
 * Entity properties synced as per-name registers (set_property intents).
 * The scalar subset of the framework's synced-property contract (see
 * `syncedProperties` in core-data's entities.js) — blocks/content sync
 * through the capture bridge, and `meta` is a later phase. Each entity
 * extends this static set with its post type's attached taxonomies (by
 * rest_base, mirroring the framework's dynamic entries — term-ID arrays
 * as whole-array registers). Values are raw JSON scalars (string, number,
 * boolean, or null) or term-ID arrays in both the edited record and the
 * engine document.
 */
const SYNCED_PROPERTIES = [
	'title',
	'excerpt',
	'slug',
	'status',
	'comment_status',
	'ping_status',
	'format',
	'sticky',
	'author',
	'featured_media',
	'date',
	'template',
];

/**
 * A raw value a synced property register may hold: a JSON scalar, or a
 * term-ID array (taxonomy properties sync as whole-array registers).
 */
type SyncedPropertyValue = string | number | boolean | null | number[];

/**
 * Whether a value is a term-ID array (every element a number).
 *
 * @param value Candidate value.
 * @return True for arrays of numbers (including empty).
 */
function isTermIdArray( value: unknown ): value is number[] {
	return (
		Array.isArray( value ) &&
		value.every( ( item ) => 'number' === typeof item )
	);
}

/**
 * Reads a synced property from a record or edits object as a raw value.
 * REST records carry title/excerpt as `{ raw, rendered }`; editor edits
 * carry them as plain strings. Other properties are plain scalars in both
 * shapes (`date` may be null: a "floating" publish-immediately date), and
 * taxonomy properties are term-ID arrays.
 *
 * @param source Record or edits object.
 * @param name   Property name.
 * @return The raw value, or undefined when absent/unsyncable.
 */
function rawPropertyValue(
	source: Record< string, unknown >,
	name: string
): SyncedPropertyValue | undefined {
	const value = source[ name ];
	if (
		null === value ||
		'string' === typeof value ||
		'number' === typeof value ||
		'boolean' === typeof value ||
		isTermIdArray( value )
	) {
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
 * Whether an engine-document register value is one the property lane may
 * push into the editor. Guards against malformed remote payloads
 * (set_property values are unvalidated `isAny` on the wire).
 *
 * @param value Register value from the engine document.
 * @return True for string/number/boolean/null and term-ID arrays.
 */
function isSyncablePropertyValue(
	value: unknown
): value is SyncedPropertyValue {
	return (
		null === value ||
		'string' === typeof value ||
		'number' === typeof value ||
		'boolean' === typeof value ||
		isTermIdArray( value )
	);
}

/**
 * Canonical form of a property value: term-ID arrays sort numerically,
 * everything else passes through. Taxonomy bindings are SETS — the editor
 * appends IDs in click order while the REST record serializes name order,
 * and without one canonical order the post-save mutation feed re-captures
 * the same set as a "change", whose register write then collides with any
 * in-flight toggle as a spurious property-conflict escalation.
 *
 * @param value Property value.
 * @return The canonical value (a sorted copy for term-ID arrays).
 */
function canonicalPropertyValue( value: unknown ): unknown {
	if ( isTermIdArray( value ) ) {
		return [ ...value ].sort( ( a, b ) => a - b );
	}
	return value;
}

/**
 * Value equality for property registers: strict for scalars, and
 * order-INSENSITIVE elementwise comparison for term-ID arrays (see
 * canonicalPropertyValue — same set must never read as a change, even
 * against unsorted values written by older clients). Array registers
 * arrive as fresh instances on every read, so reference equality would
 * author an echo intent per render.
 *
 * @param a One value (may be undefined: absent).
 * @param b Other value.
 * @return True when the register values are the same.
 */
function samePropertyValue( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}
	if ( ! Array.isArray( a ) || ! Array.isArray( b ) ) {
		return false;
	}
	if ( a.length !== b.length ) {
		return false;
	}
	const aSorted = canonicalPropertyValue( a );
	const bSorted = canonicalPropertyValue( b );
	return (
		Array.isArray( aSorted ) &&
		Array.isArray( bSorted ) &&
		aSorted.every( ( item, index ) => item === bSorted[ index ] )
	);
}

/**
 * Register-name prefix for post-meta properties: each registered meta key
 * syncs as its own register (`meta.<key>`), giving concurrent edits to
 * DIFFERENT keys independence and same-key conflicts the per-register
 * escalation grain.
 */
const META_PROPERTY_PREFIX = 'meta.';

/**
 * Meta keys that never sync, mirroring the framework sync config's
 * `disallowedPostMetaKeys`: the persisted CRDT snapshot is transport
 * state, not content.
 */
const DISALLOWED_META_KEYS = new Set( [ '_crdt_document' ] );

/**
 * Deep equality over JSON values, for meta registers (whose values may be
 * arbitrary registered-schema JSON). One deliberate looseness: an empty
 * array and an empty plain object compare EQUAL, because PHP's JSON
 * encoding cannot distinguish an empty assoc array from an empty list —
 * a genesis seeded from PHP would otherwise ping-pong an empty
 * object-typed meta value forever.
 *
 * @param a One value.
 * @param b Other value.
 * @return True when the values are structurally equal.
 */
function jsonDeepEqual( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}
	const aIsArray = Array.isArray( a );
	const bIsArray = Array.isArray( b );
	if ( aIsArray && bIsArray ) {
		return (
			( a as unknown[] ).length === ( b as unknown[] ).length &&
			( a as unknown[] ).every( ( item, index ) =>
				jsonDeepEqual( item, ( b as unknown[] )[ index ] )
			)
		);
	}
	const aIsObject = ! aIsArray && a && 'object' === typeof a;
	const bIsObject = ! bIsArray && b && 'object' === typeof b;
	if ( aIsObject && bIsObject ) {
		const aEntries = Object.entries( a as Record< string, unknown > );
		const bRecord = b as Record< string, unknown >;
		return (
			aEntries.length === Object.keys( bRecord ).length &&
			aEntries.every(
				( [ key, value ] ) =>
					key in bRecord && jsonDeepEqual( value, bRecord[ key ] )
			)
		);
	}
	// The PHP JSON boundary: empty assoc array === empty list.
	const isEmptyContainer = ( value: unknown ) =>
		( Array.isArray( value ) && 0 === value.length ) ||
		( !! value &&
			'object' === typeof value &&
			! Array.isArray( value ) &&
			0 === Object.keys( value as object ).length );
	return isEmptyContainer( a ) && isEmptyContainer( b );
}

/**
 * A record or edits object's `meta` as a plain object, or undefined.
 *
 * @param source Record or edits object.
 * @return The meta object, or undefined.
 */
function metaObject(
	source: Record< string, unknown >
): Record< string, unknown > | undefined {
	const value = source.meta;
	if ( value && 'object' === typeof value && ! Array.isArray( value ) ) {
		return value as Record< string, unknown >;
	}
	return undefined;
}

/**
 * Collects the persisted syncIds carried in a record's serialized content.
 *
 * Reads only the block delimiters (grammar-level parse, no block registry),
 * so it sees exactly what the editor parsed and rendered from this content.
 * Legacy content without persisted ids yields an empty set — deterministic
 * genesis seeding covers that shape instead.
 *
 * @param content Raw serialized post content, or undefined.
 * @return The persisted syncIds.
 */
function collectPersistedSyncIds( content: string | undefined ): Set< string > {
	const ids = new Set< string >();
	if ( ! content || ! content.includes( '"syncId"' ) ) {
		return ids;
	}
	type ParsedNode = {
		attrs: { metadata?: { syncId?: unknown } } | null;
		innerBlocks: ParsedNode[];
	};
	const walk = ( nodes: ParsedNode[] ) => {
		for ( const node of nodes ) {
			const syncId = node.attrs?.metadata?.syncId;
			if ( 'string' === typeof syncId ) {
				ids.add( syncId );
			}
			walk( node.innerBlocks );
		}
	};
	walk( parseBlockDelimiters( content ) as ParsedNode[] );
	return ids;
}

/**
 * Collects all syncIds in a bridge block tree (metadata.syncId).
 *
 * @param blocks Bridge blocks.
 * @param into   Accumulator.
 * @return The accumulator.
 */
function collectBlockIds(
	blocks: BridgeBlock[],
	into: Set< string > = new Set()
): Set< string > {
	for ( const block of blocks ) {
		const metadata = block.attributes?.metadata as
			| { syncId?: string }
			| undefined;
		if ( metadata?.syncId ) {
			into.add( metadata.syncId );
		}
		collectBlockIds( block.innerBlocks, into );
	}
	return into;
}

/**
 * Canonical form of a bridge block tree for echo suppression.
 *
 * @param blocks Bridge blocks.
 * @return Canonical JSON.
 */
function canonicalBlocksJson( blocks: BridgeBlock[] ): string {
	return JSON.stringify( blocks );
}

/**
 * A bridge block extended with the editor-required clientId.
 */
type EditorBlock = BridgeBlock & {
	clientId: string;
	isValid: boolean;
	innerBlocks: EditorBlock[];
};

/**
 * Assigns stable clientIds (keyed by syncId) to a bridge block tree so the
 * block-editor store accepts and reconciles it.
 *
 * @param blocks    Bridge blocks (syncId present in metadata).
 * @param clientIds syncId → clientId map (grown as needed).
 * @return Editor-ready blocks.
 */
/**
 * Merges a block type's attribute DEFAULTS under the given attributes.
 *
 * Pushed blocks are built from the engine document, whose attrs mirror the
 * serialized comment JSON — which OMITS default-valued attributes. Most
 * blocks tolerate the gaps, but some save() implementations dereference a
 * defaulted attribute (core/group renders `<TagName>` from `tagName`,
 * default 'div'): with the attribute absent, save() throws, and the
 * serializer silently emits the block as a VOID comment — children and
 * wrapper gone from saved content, which then parses as an invalid
 * recovery block for every future visitor (found by the fuzzer as
 * post-reload invalid groups whenever a genesis-sourced group was saved).
 * createBlock() is deliberately NOT used here: its schema sanitization
 * would drop attributes the block type does not declare, and the push
 * must remain lossless.
 *
 * @param name       Block name.
 * @param attributes Attributes from the engine document.
 * @return Attributes with block-type defaults filled in.
 */
function withBlockDefaults(
	name: string,
	attributes: Record< string, unknown >
): Record< string, unknown > {
	const blockType = getBlockType( name ) as
		| { attributes?: Record< string, { default?: unknown } > }
		| undefined;
	if ( ! blockType?.attributes ) {
		return attributes;
	}
	let merged: Record< string, unknown > | null = null;
	for ( const [ key, schema ] of Object.entries( blockType.attributes ) ) {
		if ( undefined === schema.default || key in attributes ) {
			continue;
		}
		if ( ! merged ) {
			merged = { ...attributes };
		}
		merged[ key ] = schema.default;
	}
	return merged ?? attributes;
}

/**
 * Renders a block's save markup with EMPTY inner blocks — the wrapper plus
 * the block's own static inner HTML — for save-accurate `_wrapper` and
 * `content` authoring (see the bridge's SaveMarkupAdapter).
 * Returns null when the type is unregistered or its save() throws; capture
 * then leaves the document's existing wrapper/content untouched.
 *
 * @param block Bridge block (editor shape).
 * @return Save markup or null.
 */
function saveMarkupAdapter( block: BridgeBlock ): string | null {
	try {
		const blockType = getBlockType( block.name );
		if ( ! blockType ) {
			return null;
		}
		return getSaveContent(
			blockType as Parameters< typeof getSaveContent >[ 0 ],
			block.attributes,
			[]
		);
	} catch {
		return null;
	}
}

function toEditorBlocks(
	blocks: BridgeBlock[],
	clientIds: Map< string, string >
): EditorBlock[] {
	return blocks.map( ( block ) => {
		const syncId = ( block.attributes?.metadata as { syncId?: string } )
			?.syncId;
		let clientId = syncId ? clientIds.get( syncId ) : undefined;
		if ( ! clientId ) {
			clientId = globalThis.crypto.randomUUID();
			if ( syncId ) {
				clientIds.set( syncId, clientId );
			}
		}
		return {
			...block,
			attributes: withBlockDefaults(
				block.name,
				( block.attributes ?? {} ) as Record< string, unknown >
			),
			clientId,
			isValid: true,
			innerBlocks: toEditorBlocks( block.innerBlocks, clientIds ),
		};
	} );
}

/**
 * Maps an engine document to the bridge blocks the editor is handed.
 *
 * @param state Entity state.
 * @param doc   Engine document.
 * @return Bridge blocks.
 */
function documentBlocks(
	state: EntityState,
	doc: EngineDocument
): BridgeBlock[] {
	return engineDocumentToBlocks(
		doc,
		state.fieldsResolver,
		state.rawContent
	);
}

/**
 * Collects every block id in an engine document.
 *
 * @param doc  Engine document.
 * @param into Accumulator.
 * @return The accumulator.
 */
function collectDocumentIds(
	doc: EngineDocument,
	into: Set< string > = new Set()
): Set< string > {
	const walk = ( blocks: EngineDocument[ 'root' ] ) => {
		for ( const block of blocks ) {
			into.add( block.syncId );
			walk( block.children );
		}
	};
	walk( doc.root );
	return into;
}

/**
 * Records the state the editor is understood to display, and with it the
 * seq captures are authored at (the session keeps its replica's log
 * sliceable from there).
 *
 * @param state Entity state.
 * @param next  Observed state.
 */
function setObserved( state: EntityState, next: ObservedState ): void {
	// The session clamps the seq into its replica's authorable range (and
	// skips entries this client authored itself); keep the record in step.
	state.session.setObservedSeq( next.seq );
	state.observed = { ...next, seq: state.session.getObservedSeq() };
}

/**
 * Dispatches a document to the editor and files it as an unconfirmed
 * baseline candidate (see the module note).
 *
 * @param state  Entity state.
 * @param next   State being pushed.
 * @param blocks Its bridge blocks.
 */
function pushDocument(
	state: EntityState,
	next: ObservedState,
	blocks: BridgeBlock[]
): void {
	state.pendingPushes.push( next );
	if ( state.pendingPushes.length > MAX_PENDING_PUSHES ) {
		state.pendingPushes.shift();
	}
	state.handlers.editRecord(
		{ blocks: toEditorBlocks( blocks, state.clientIds ) },
		{ undoIgnore: true }
	);
	const token = ++state.pushSeq;
	setTimeout( () => {
		/*
		 * Nothing arrived from the editor since this push, so it rendered:
		 * the block editor reports nothing back for changes it applied
		 * itself, and an editor change would have consumed the pending
		 * candidates. Promoting it also releases the replica's log
		 * retention down to this seq.
		 */
		const latest = state.pendingPushes.at( -1 );
		if ( state.unloaded || token !== state.pushSeq || ! latest ) {
			return;
		}
		state.pendingPushes = [];
		setObserved( state, latest );
	}, PUSH_OBSERVED_DELAY );
}

/**
 * Brings the editor up to the shared document when it is behind it.
 *
 * @param state Entity state.
 * @param force Push even when the document matches what the editor is
 *              believed to show — for the cases where that belief is
 *              knowably incomplete (identity write-backs, retained blocks).
 */
function syncEditor( state: EntityState, force = false ): void {
	const doc = state.session.getDocument();
	if ( ! doc || ! state.observed ) {
		return;
	}
	const blocks = documentBlocks( state, doc );
	const json = canonicalBlocksJson( blocks );
	const shown = state.pendingPushes.at( -1 ) ?? state.observed;
	if ( ! force && json === shown.json ) {
		return;
	}
	pushDocument( state, { doc, seq: state.session.getSeq(), json }, blocks );
}

/**
 * Queues an editor sync for after the capture that asked for it.
 *
 * A push dispatched from INSIDE update() never reaches the editor:
 * core-data hands the sync manager the edits (where this runs) BEFORE it
 * commits them, and every editor edit carries the editor's own block tree —
 * so its commit lands on top of anything we dispatch here. Only a push made
 * outside that call survives, which is why capture-driven syncs (identity
 * write-backs, retained blocks, a merged document the tree is behind on)
 * wait for the burst to fall quiet. Remote-driven pushes are dispatched
 * immediately: they run from a transport callback, with no editor edit
 * following them.
 *
 * @param state Entity state.
 * @param force See syncEditor.
 */
function scheduleEditorSync( state: EntityState, force = false ): void {
	state.syncForce = state.syncForce || force;
	if ( state.syncTimer ) {
		clearTimeout( state.syncTimer );
	}
	state.syncTimer = setTimeout( () => {
		state.syncTimer = null;
		/*
		 * Re-check typing-hotness at FIRE time: the delay only measures
		 * from scheduling, and a burst that keeps going would otherwise
		 * take this push mid-stream — remounting the caret block and
		 * eating the next keystrokes (deterministic truncation on the
		 * real-websocket lane, where per-keystroke remote rows schedule
		 * this sync early in the peer's burst).
		 */
		if ( Date.now() - state.lastEditorEditAt < PUSH_QUIET_MS ) {
			scheduleEditorSync( state, state.syncForce );
			return;
		}
		const forced = state.syncForce;
		state.syncForce = false;
		if ( ! state.unloaded ) {
			syncEditor( state, forced );
		}
	}, CAPTURE_SYNC_DELAY );
}

/**
 * Resolves which state an arriving editor tree was authored against, and
 * makes it the observed baseline.
 *
 * Every unconfirmed push is a candidate alongside the confirmed baseline;
 * the tree is that state plus the user's own edit, so the candidate it
 * differs from least is the one it came from. A tie is no evidence that the
 * editor rendered a push, and treating an unrendered push as observed is
 * exactly what turns a lost race into a destructive diff — so ties keep the
 * confirmed baseline. Either way the candidates are consumed: the record now
 * carries the editor's own tree, so any push it did not render is gone.
 *
 * @param state  Entity state.
 * @param blocks The arriving editor tree.
 */
function chooseObservedBaseline(
	state: EntityState,
	blocks: BridgeBlock[]
): void {
	const observed = state.observed;
	// Candidates that carry the same content as the confirmed baseline
	// cannot be told apart from it by any tree, and choosing one would
	// change nothing but the seq — drop them before doing real work (this
	// is the common case: a push the editor was never behind on).
	const pending = state.pendingPushes.filter(
		( candidate ) => candidate.json !== observed?.json
	);
	state.pendingPushes = [];
	// Invalidate the pending confirmation timers: this tree is the answer.
	state.pushSeq++;
	if ( 0 === pending.length || ! observed ) {
		return;
	}
	const options = {
		richTextFields: state.fieldsResolver,
		rawContent: state.rawContent,
	};
	const summary = summarizeEditorTree( blocks, options );
	const relevantIds = new Set< string >();
	for ( const candidate of [ observed, ...pending ] ) {
		collectDocumentIds( candidate.doc, relevantIds );
	}
	let best = observed;
	let bestDistance = documentDistance(
		summary,
		best.doc,
		relevantIds,
		options
	);
	for ( const candidate of pending ) {
		const distance = documentDistance(
			summary,
			candidate.doc,
			relevantIds,
			options
		);
		if ( distance < bestDistance ) {
			best = candidate;
			bestDistance = distance;
		}
	}
	if ( best !== observed ) {
		setObserved( state, best );
	}
}

/**
 * Creates an intent-log sync manager.
 *
 * @param debug Whether to log debug output.
 * @return Sync manager.
 */
export function createIntentLogManager( debug = false ): SyncManager {
	const entityStates = new Map< string, EntityState >();
	const collectionStates = new Map< ObjectType, CollectionState >();
	/*
	 * The collaborative undo manager (inverse intents; see
	 * intent-log-undo.ts). Created lazily on the first entity load —
	 * mirroring the framework manager's lifecycle — and exposed via the
	 * `undoManager` getter, which routes core-data's undo/redo through it.
	 * Stack changes fan out to every loaded entity's onUndoStackChange
	 * handler (they all drive the one syncUndoManagerState).
	 */
	let undoManager: IntentLogUndoManager | undefined;
	const ensureUndoManager = (): IntentLogUndoManager => {
		if ( ! undoManager ) {
			undoManager = createIntentLogUndoManager( {
				onStackChange: ( stackState ) => {
					for ( const [ , state ] of entityStates ) {
						state.handlers.onUndoStackChange?.( stackState );
					}
				},
			} );
		}
		return undoManager;
	};
	const userId =
		Number(
			( window as { _wpCollaborationUserId?: unknown } )
				._wpCollaborationUserId
		) || 0;

	const log = ( message: string, context: object = {} ) => {
		if ( debug ) {
			// eslint-disable-next-line no-console
			console.log( `[IntentLogManager]: ${ message }`, context );
		}
	};

	const entityKey = ( objectType: ObjectType, objectId: ObjectID | null ) =>
		`${ objectType }_${ objectId }`;

	/**
	 * The post type's attached taxonomies as synced-property names (their
	 * rest_base), mirroring how the framework's entities.js builds its
	 * dynamic syncedProperties entries. Cached per post type for the
	 * manager's lifetime; failure degrades to the static scalar set (terms
	 * then ride saves, as before).
	 */
	const taxonomyPropertiesByPostType = new Map<
		string,
		Promise< string[] >
	>();
	// A load can still be fetching taxonomy metadata when its record unloads.
	const pendingLoads = new Map< string, symbol >();
	const taxonomyProperties = ( postType: string ): Promise< string[] > => {
		let promise = taxonomyPropertiesByPostType.get( postType );
		if ( ! promise ) {
			promise = ( async () => {
				try {
					const [ types, taxonomies ] = await Promise.all( [
						apiFetch< {
							[ name: string ]: { taxonomies?: string[] };
						} >( { path: '/wp/v2/types?context=view' } ),
						apiFetch< {
							[ name: string ]: { rest_base?: string };
						} >( { path: '/wp/v2/taxonomies?context=view' } ),
					] );
					return ( types?.[ postType ]?.taxonomies ?? [] )
						.map(
							( taxonomy ) => taxonomies?.[ taxonomy ]?.rest_base
						)
						.filter( ( base ): base is string => Boolean( base ) );
				} catch {
					return [];
				}
			} )();
			taxonomyPropertiesByPostType.set( postType, promise );
		}
		return promise;
	};

	async function loadEntity(
		syncConfig: SyncConfig,
		objectType: ObjectType,
		objectId: ObjectID,
		record: ObjectData,
		handlers: RecordHandlers
	): Promise< void > {
		const key = entityKey( objectType, objectId );
		if ( entityStates.has( key ) || pendingLoads.has( key ) ) {
			return;
		}
		if ( false === syncConfig.shouldSync?.( objectType, objectId ) ) {
			return;
		}
		const providerCreators = getProviderCreators();
		if ( 0 === providerCreators.length ) {
			return;
		}
		const loadToken = Symbol();
		pendingLoads.set( key, loadToken );

		/*
		 * This entity's synced properties: the static scalar whitelist plus
		 * the post type's attached taxonomies (objectType is
		 * `postType/<slug>`). Resolved before any state exists; check that
		 * this load still owns the record after the await.
		 */
		const syncedProperties = [
			...SYNCED_PROPERTIES,
			...( await taxonomyProperties(
				objectType.split( '/' )[ 1 ] ?? ''
			) ),
		];
		if ( pendingLoads.get( key ) !== loadToken ) {
			return;
		}
		pendingLoads.delete( key );

		/*
		 * The presence surface: the entity's syncConfig constructs the typed
		 * Awareness (e.g. PostEditorAwareness with collaborator info and
		 * selection tracking). The y-protocols Awareness base only reads
		 * `clientID` (and a destroy listener) from its doc argument, so a
		 * stub suffices — presence is transport data, engine-independent.
		 */
		const clientId = randomClientId();
		const awareness = syncConfig.createAwareness?.(
			createAwarenessDoc( clientId ) as never,
			objectId
		);
		registerAwareness( objectType, objectId, awareness );
		const session = createIntentLogSession( {
			userId,
			clientId,
			awareness,
		} );
		ensureUndoManager().attachSession( session );
		/*
		 * Seed property echo suppression from the record the editor loaded:
		 * a genesis snapshot whose properties match what the editor already
		 * shows must not be re-pushed as an edit. A ROOM value that differs
		 * (another client changed the title before we joined) still pushes.
		 *
		 * The "Auto Draft" placeholder is normalized to the empty string the
		 * server genesis seeds (a fresh auto-draft stores the placeholder
		 * title while the editor shows an empty field), so opening a new
		 * post does not push a spurious title edit.
		 */
		const initialProps: Record< string, unknown > = {};
		for ( const name of syncedProperties ) {
			let value = rawPropertyValue(
				record as Record< string, unknown >,
				name
			);
			if ( undefined === value ) {
				continue;
			}
			if (
				'title' === name &&
				'Auto Draft' === value &&
				'auto-draft' === ( record as Record< string, unknown > ).status
			) {
				value = '';
			}
			initialProps[ name ] = canonicalPropertyValue( value );
		}
		// Meta registers seed the same way, under their prefixed names.
		const recordMeta =
			metaObject( record as Record< string, unknown > ) ?? {};
		for ( const [ metaKey, metaValue ] of Object.entries( recordMeta ) ) {
			if (
				DISALLOWED_META_KEYS.has( metaKey ) ||
				undefined === metaValue
			) {
				continue;
			}
			initialProps[ META_PROPERTY_PREFIX + metaKey ] = metaValue;
		}

		const recordContent = rawPropertyValue(
			record as Record< string, unknown >,
			'content'
		);

		const state: EntityState = {
			session,
			awareness,
			handlers,
			providers: [],
			unloaded: false,
			observed: null,
			pendingPushes: [],
			preInitTree: null,
			lastEditorEditAt: 0,
			staleVoidRecapturePending: false,
			resetRecapturePending: false,
			lastEditorTree: null,
			capturing: false,
			// Record seeding (source 1 of the editorIds contract): the ids
			// persisted in the content this editor loaded and rendered.
			editorIds: collectPersistedSyncIds(
				'string' === typeof recordContent ? recordContent : undefined
			),
			genesisSeeded: false,
			prevDocIds: new Set(),
			docTombstones: new Set(),
			clientIds: new Map(),
			pushSeq: 0,
			syncTimer: null,
			syncForce: false,
			lastPushedProps: initialProps,
			syncedProperties,
			knownMeta: { ...recordMeta },
			fieldsResolver:
				syncConfig.richTextFields ?? ( () => [ 'content' ] ),
			rawContent:
				syncConfig.isRawContentBlock && syncConfig.serializeRawContent
					? {
							is: syncConfig.isRawContentBlock,
							serialize: syncConfig.serializeRawContent,
							hydrate: syncConfig.hydrateRawContent,
					  }
					: undefined,
		};
		entityStates.set( key, state );

		/**
		 * Pushes engine property values the editor has not seen yet.
		 *
		 * `date` is deliberately pushed like any other scalar — WITHOUT the
		 * framework sync config's floating-date guard. That guard protects
		 * a "publish immediately" editor from the genesis-seeded concrete
		 * date, a case this engine prevents at the source: genesis never
		 * seeds a floating date, and a seeded concrete date always equals
		 * the joining record's value (echo-suppressed). Registers therefore
		 * only ever carry DELIBERATE date changes — a sidebar edit or the
		 * post-save mutation feed — and guarding those made propagation
		 * depend on the peer's stale `modified` value and save history
		 * (dates synced or not seemingly at random).
		 */
		const pushPropertyChanges = () => {
			const doc = session.getDocument();
			if ( ! doc ) {
				return;
			}
			const edits: Record< string, unknown > = {};
			for ( const name of state.syncedProperties ) {
				const value = canonicalPropertyValue( doc.props?.[ name ] );
				if (
					undefined === value ||
					! isSyncablePropertyValue( value )
				) {
					continue;
				}
				if (
					samePropertyValue( state.lastPushedProps[ name ], value )
				) {
					continue;
				}
				// An invalid status never reaches the editor.
				if ( 'status' === name && 'auto-draft' === value ) {
					continue;
				}
				state.lastPushedProps[ name ] = value;
				edits[ name ] = value;
			}
			/*
			 * Meta registers: changed `meta.<key>` values merge over the
			 * known meta and dispatch as ONE whole meta object (the raw
			 * editRecord dispatch replaces `meta`, so a partial object
			 * would wipe sibling keys' local edits).
			 */
			const metaEdits: Record< string, unknown > = {};
			for ( const [ name, value ] of Object.entries( doc.props ?? {} ) ) {
				if ( ! name.startsWith( META_PROPERTY_PREFIX ) ) {
					continue;
				}
				const metaKey = name.slice( META_PROPERTY_PREFIX.length );
				if ( DISALLOWED_META_KEYS.has( metaKey ) ) {
					continue;
				}
				if ( jsonDeepEqual( state.lastPushedProps[ name ], value ) ) {
					continue;
				}
				// Orphaned-register guard: a key with no counterpart in
				// this post's meta is not registered here; pushing it
				// would mark the post permanently dirty.
				if ( ! ( metaKey in state.knownMeta ) ) {
					continue;
				}
				state.lastPushedProps[ name ] = value;
				metaEdits[ metaKey ] = value;
			}
			if ( Object.keys( metaEdits ).length > 0 ) {
				state.knownMeta = { ...state.knownMeta, ...metaEdits };
				edits.meta = state.knownMeta;
			}
			if ( Object.keys( edits ).length > 0 ) {
				handlers.editRecord( edits, { undoIgnore: true } );
			}
		};

		session.onChange( () => {
			if ( state.unloaded || ! session.isInitialized() ) {
				return;
			}
			const doc = session.getDocument()!;
			const blocks = documentBlocks( state, doc );
			const docIds = collectBlockIds( blocks );
			/*
			 * Genesis seeding (source 2 of the editorIds contract): a seq-0
			 * bootstrap is the room GENESIS, derived from the saved post
			 * content this editor itself parsed and rendered — its blocks
			 * are provably displayed, so they are removable immediately.
			 * Without this, a WHOLESALE first edit (select-all paste)
			 * captures a tree that never contained the genesis blocks, their
			 * absence reads as staleness, and the dropped deletions resurrect
			 * on every client. Checkpoint bootstraps (seq > 0) may carry
			 * blocks a late joiner never displayed and must NOT seed (record
			 * seeding covers the ids that joiner did render). The first
			 * post-init change event fires synchronously on snapshot receipt,
			 * so `blocks` here is exactly the bootstrap document.
			 */
			if ( ! state.genesisSeeded ) {
				state.genesisSeeded = true;
				if ( 0 === session.getBootstrapSeq() ) {
					for ( const id of docIds ) {
						state.editorIds.add( id );
					}
				}
			}
			/*
			 * Tombstone maintenance: ids that left the document through
			 * REMOTE intents (own authorship is under the capturing guard)
			 * must not be resurrected by a stale editor tree. Reappearing
			 * ids clear their tombstone.
			 */
			if ( ! state.capturing ) {
				for ( const id of state.prevDocIds ) {
					if ( ! docIds.has( id ) ) {
						state.docTombstones.add( id );
					}
				}
			}
			for ( const id of docIds ) {
				state.docTombstones.delete( id );
			}
			state.prevDocIds = docIds;

			if ( state.capturing ) {
				return;
			}
			// Entity properties push independently of the block logic below
			// (its early returns must not swallow a title change).
			pushPropertyChanges();
			if ( ! state.observed ) {
				/*
				 * Bootstrap. The snapshot is the best account of what the
				 * editor displays: the genesis is derived from the saved
				 * content this editor itself parsed and rendered, and a
				 * compaction checkpoint is the nearest approximation (the
				 * editorIds retention guard covers the difference).
				 */
				const bootstrap = {
					doc,
					seq: session.getBootstrapSeq() ?? 0,
					json: canonicalBlocksJson( blocks ),
				};
				setObserved( state, bootstrap );
				/*
				 * A mid-session horizon reset with local work on the canvas:
				 * pushing the checkpoint document would CLOBBER that work
				 * (the replica just dropped its pending intents, and the
				 * transport may still void the in-flight ones). Re-derive
				 * from the editor's own tree against the reset document
				 * instead; the capture's own editor sync then pushes the
				 * properly merged view.
				 */
				if ( state.resetRecapturePending ) {
					state.resetRecapturePending = false;
					scheduleTreeRecapture( 'reset-recapture' );
					return;
				}
				/*
				 * Never push an EMPTY shared document over a live editor as
				 * the first push (fresh post: the genesis is empty while the
				 * user may already be typing). The first capture seeds the
				 * document instead — but that capture is edge-triggered, so
				 * an edit made DURING the join round trip has already missed
				 * it: update() buffered the tree, and it is recovered below.
				 * Without that the edit stays local forever (the fuzzer's
				 * reload-straddling-insert stall on an empty-genesis room).
				 *
				 * The recovery is DEFERRED past the current delivery burst
				 * and runs only if the document is STILL empty then. The
				 * genesis snapshot is just the first row of its response: a
				 * rejoiner's room replays its whole history right behind it,
				 * and capturing the buffered tree against the bare genesis
				 * baseline would re-author every saved block as new work —
				 * the history rows then land beside the fabrications and
				 * every block duplicates (found by fuzz:quick when this
				 * recovery ran synchronously). A still-empty document after
				 * the burst means the room truly holds only its genesis —
				 * exactly the stranded case. Any post-init editor tree
				 * supersedes the buffer (update() clears it), and non-empty
				 * bootstraps reconcile through pushDocument as before.
				 */
				if ( 0 === blocks.length ) {
					if ( state.preInitTree?.length ) {
						setTimeout( () => {
							const buffered = state.preInitTree;
							state.preInitTree = null;
							if (
								! buffered ||
								state.unloaded ||
								! state.session.isInitialized() ||
								documentBlocks(
									state,
									state.session.getDocument()!
								).length > 0
							) {
								return;
							}
							manager.update(
								objectType,
								objectId,
								{ blocks: buffered },
								'pre-init-capture'
							);
						}, 0 );
					}
					return;
				}
				state.preInitTree = null;
				pushDocument( state, bootstrap, blocks );
				return;
			}
			/*
			 * Deliberately NOT marking the pushed ids as editor-displayed:
			 * a push only proves we dispatched, not that the editor
			 * rendered it. Ids become removable when the editor itself
			 * hands us a tree containing them (its echo of this push).
			 */
			/*
			 * Typing-quiet gate for remote application: pushing a merged
			 * view while the user's burst is hot remounts the caret block
			 * and eats the next keystrokes at the canvas. Mid-burst
			 * arrivals wait for the burst to settle via the existing
			 * deferred editor sync (which any later capture resets); a
			 * quiet editor still gets remote work immediately.
			 */
			if ( Date.now() - state.lastEditorEditAt < PUSH_QUIET_MS ) {
				scheduleEditorSync( state );
				return;
			}
			syncEditor( state );
		} );

		session.onReset( () => {
			/*
			 * Horizon reset: the replica re-bootstrapped from a server
			 * checkpoint and pending intents were dropped. Drop the observed
			 * baseline (its seq belongs to trimmed history) so the change
			 * event that follows re-seeds from the checkpoint and pushes it,
			 * and clear staleness bookkeeping derived from the old replica.
			 * The editor tree still holds any un-acked local work; the next
			 * capture diffs it against the reset document and re-authors.
			 */
			state.observed = null;
			state.pendingPushes = [];
			state.pushSeq++;
			state.lastPushedProps = {};
			state.docTombstones.clear();
			state.prevDocIds = new Set();
			/*
			 * A reset LANDING MID-BURST must not clobber the live canvas
			 * with the checkpoint document: the editor tree holds local
			 * work the replica just dropped (and the transport queue may
			 * still carry now-stale intents the server will void). Flag
			 * the bootstrap branch to recapture the editor's own tree
			 * instead of pushing over it. A reset with no local edits yet
			 * (a genuine late-joiner catch-up) keeps the push.
			 */
			if ( Array.isArray( state.lastEditorTree ) ) {
				state.resetRecapturePending = true;
			}
			log( 'session reset from server checkpoint', { key } );
		} );

		/**
		 * Re-derives local work from the last editor-fed tree against the
		 * CURRENT document at the CURRENT seq — the shared recovery for
		 * both horizon-reset and stale-base-void paths (deferred past the
		 * settle/replan/bootstrap that scheduled it). The tree reference
		 * comes from the ordinary update() feed: core-data's
		 * getEditedRecord() returns blocks whose attribute values the
		 * bridge's derive/verify pass rejects wholesale.
		 *
		 * @param origin Capture origin tag for the re-derived batch.
		 */
		const scheduleTreeRecapture = ( origin: string ): void => {
			if ( state.staleVoidRecapturePending ) {
				return;
			}
			state.staleVoidRecapturePending = true;
			setTimeout( () => {
				state.staleVoidRecapturePending = false;
				if ( state.unloaded || ! state.session.isInitialized() ) {
					return;
				}
				const blocks = state.lastEditorTree;
				if ( ! Array.isArray( blocks ) ) {
					return;
				}
				const doc = state.session.getDocument();
				if ( ! doc ) {
					return;
				}
				// Authoring must move to a retained frame: re-seed the
				// observed baseline at the current document and seq.
				setObserved( state, {
					doc,
					seq: state.session.getSeq(),
					json: canonicalBlocksJson( documentBlocks( state, doc ) ),
				} );
				state.pendingPushes = [];
				state.pushSeq++;
				log( 'recapturing the editor tree', { key, origin } );
				manager.update( objectType, objectId, { blocks }, origin );
			}, 0 );
		};

		session.onDisposition( ( settled ) => {
			/*
			 * Stale-base voids: the server compacted the room past the seq
			 * these intents were authored at (their priors are gone, so a
			 * one-sided transform is impossible) and voided them without
			 * planning. The engine's contract expects the CLIENT to
			 * re-derive the work — but the snapshot-reset path (onReset
			 * above) only fires when the client's CURSOR fell below the
			 * horizon. A live, connected client whose cursor is current
			 * gets only the voids: the replan then drops the optimistic
			 * effect and the next editor sync pushes the REVERTED document
			 * over the canvas — the user watches their own typing vanish
			 * (found by A2's retry-free e2e runs: a table-cell edit burst
			 * landed right after its author's earlier burst pushed the room
			 * past the checkpoint trim). Recover by re-capturing the CURRENT
			 * editor tree against the current document, at the current seq:
			 * the tree still holds the voided work until the revert push
			 * lands, and the deferred recapture below runs first (the revert
			 * waits out CAPTURE_SYNC_DELAY).
			 */
			if (
				'voided' !== settled.status ||
				'stale-base' !== settled.reason
			) {
				return;
			}
			if ( state.session.hasDeferredReset() ) {
				/*
				 * A horizon reset is queued behind this burst: these voids
				 * are the coherent old-frame remainder, and the reset's own
				 * recapture re-derives everything at the new frame once the
				 * outbox drains. Recapturing now would author more
				 * old-frame intents and starve the release.
				 */
				return;
			}
			// A whole authoring ladder voids together: one recovery per burst.
			scheduleTreeRecapture( 'stale-void-recapture' );
		} );

		session.onDiscard( ( updates ) => {
			/*
			 * The transport dropped the room with unsent updates (terminal
			 * error: lost permission, engine mismatch, a limit). The content
			 * is still in the editor but will never sync — surface the loss
			 * instead of letting it stay silent. The editor keeps the post
			 * dirty, so saving preserves the work through the classic path.
			 */
			// eslint-disable-next-line no-console
			console.error(
				'[gutenberg-sync-engines] Real-time sync stopped with unsent changes:',
				updates.map( ( update ) => update.type )
			);
			// Duck-typed runtime global: the manager deliberately avoids a
			// module dependency on the data registry; outside wp-admin (unit
			// tests) this is a no-op.
			const wpGlobal = (
				window as Window & {
					wp?: {
						data?: {
							dispatch?: ( store: string ) => {
								createErrorNotice?: (
									message: string,
									options?: Record< string, unknown >
								) => void;
							};
						};
					};
				}
			 ).wp;
			wpGlobal?.data
				?.dispatch?.( 'core/notices' )
				?.createErrorNotice?.(
					'Real-time collaboration stopped before your latest changes were sent. They are still in this editor — save the post to keep them.',
					{
						id: 'gutenberg-sync-engines-discarded-updates',
						isDismissible: true,
					}
				);
		} );

		/*
		 * Escalation notices derive from the SETTLED open-proposal list, on
		 * a microtask after the delivery batch: a bootstrap replay delivers
		 * parked rows before their resolution rows, and notifying on raw
		 * arrival would re-surface long-resolved conflicts on every reload.
		 */
		const notifiedProposalIds = new Set< string >();
		let proposalsNotifyScheduled = false;
		const summarizeProposal = ( proposal: {
			intent: { type: string; payload: Record< string, unknown > };
		} ): string | undefined => {
			const { type, payload } = proposal.intent;
			switch ( type ) {
				case 'insert_text':
				case 'replace_text':
					return payload.text as string;
				case 'replace_attr_content':
					return payload.newText as string;
				case 'delete_text':
					return undefined; // A lost deletion has no content to show.
				case 'set_attr':
					return `${ payload.key as string }: ${ JSON.stringify(
						payload.value
					) }`;
				case 'set_property':
					return `${ payload.name as string }: ${ JSON.stringify(
						payload.value
					) }`;
				case 'format_text':
					return payload.format as string;
				case 'insert_block': {
					// The reviewer must SEE what they would approve —
					// notably a raw-attr block's markup (core/html).
					const block = payload.block as
						| {
								blockType?: string;
								text?: string;
								fields?: {
									content?: { text?: string };
								};
								attrs?: Record< string, unknown >;
						  }
						| undefined;
					const text =
						block?.fields?.content?.text ??
						block?.text ??
						( typeof block?.attrs?.content === 'string'
							? ( block.attrs.content as string )
							: undefined );
					return text
						? `${ block?.blockType ?? 'block' }: ${ text }`
						: block?.blockType;
				}
				default:
					return undefined;
			}
		};
		// A parked new-block proposal (insert_block) has no block in the
		// reviewer's canvas to anchor to. Surface its intended position and
		// a readable content preview so the editor can render it INLINE
		// where it would land, with approve/discard in place.
		const proposedInsertionFor = ( proposal: {
			intent: { type: string; payload: Record< string, unknown > };
		} ) => {
			if ( 'insert_block' !== proposal.intent.type ) {
				return undefined;
			}
			const payload = proposal.intent.payload;
			const block = payload.block as
				| {
						blockType?: string;
						fields?: {
							content?: { text: string; formats?: unknown[] };
						};
						attrs?: Record< string, unknown >;
				  }
				| undefined;
			const field = block?.fields?.content;
			let html = '';
			if ( field ) {
				html = fieldToHtml( field as never );
			} else if ( typeof block?.attrs?.content === 'string' ) {
				html = block.attrs.content as string;
			}
			return {
				blockType: block?.blockType,
				html,
				afterSiblingId:
					typeof payload.afterSiblingId === 'string'
						? payload.afterSiblingId
						: undefined,
				parentId:
					typeof payload.parentId === 'string'
						? payload.parentId
						: undefined,
			};
		};
		const mapReviewItems = () =>
			session.getOpenProposals().map( ( proposal ) => ( {
				id: proposal.intent.intentId,
				unitId: proposal.intent.txnId ?? proposal.intent.intentId,
				isLocal: proposal.actorId === session.actorId,
				actorId: proposal.actorId,
				reason: proposal.reason,
				intentType: proposal.intent.type,
				summary: summarizeProposal( proposal ),
				excerpt: proposal.context?.excerpt,
				targetId:
					typeof proposal.intent.payload.syncId === 'string'
						? proposal.intent.payload.syncId
						: undefined,
				proposedInsertion: proposedInsertionFor( proposal ),
			} ) );
		session.onProposalsChange( () => {
			if ( proposalsNotifyScheduled ) {
				return;
			}
			proposalsNotifyScheduled = true;
			void Promise.resolve().then( () => {
				proposalsNotifyScheduled = false;
				if ( state.unloaded ) {
					return;
				}
				const items = mapReviewItems();
				handlers.onProposalsChange?.( items );
				for ( const item of items ) {
					if ( notifiedProposalIds.has( item.id ) ) {
						continue;
					}
					notifiedProposalIds.add( item.id );
					if ( handlers.onEscalation ) {
						handlers.onEscalation( {
							reason: item.reason,
							isLocal: item.isLocal,
							proposalId: item.id,
							summary: item.summary,
							excerpt: item.excerpt,
						} );
					} else {
						// eslint-disable-next-line no-console
						console.warn(
							'[IntentLog] An edit was escalated for review (%s): %s',
							item.reason,
							item.id
						);
					}
				}
			} );
		} );

		log( 'connecting', { key } );
		state.providers = await Promise.all(
			providerCreators.map( async ( create: ProviderCreator ) => {
				const provider = await create( {
					objectType,
					objectId,
					session,
				} );
				provider.on( 'status', handlers.onStatusChange );
				return provider;
			} )
		);

		if ( state.unloaded ) {
			state.providers.forEach( ( provider ) => provider.destroy() );
			return;
		}
		void record;
	}

	/**
	 * Loads a collection room (the notification-and-refetch lane): the
	 * room's document holds only per-client save registers, and a change
	 * to a PEER's register triggers a REST refetch of the collection
	 * query. The server needs nothing new — collection rooms already
	 * initialize with an empty document, and save registers are ordinary
	 * set_property intents through the existing log machinery
	 * (compaction included).
	 * @param syncConfig
	 * @param objectType
	 * @param handlers
	 */
	async function loadCollection(
		syncConfig: SyncConfig,
		objectType: ObjectType,
		handlers: CollectionHandlers
	): Promise< void > {
		if ( collectionStates.has( objectType ) ) {
			return;
		}
		if ( false === syncConfig.shouldSync?.( objectType, null ) ) {
			return;
		}
		const providerCreators = getProviderCreators();
		if ( 0 === providerCreators.length ) {
			return;
		}

		const clientId = randomClientId();
		const awareness = syncConfig.createAwareness?.(
			createAwarenessDoc( clientId ) as never
		);
		const session = createIntentLogSession( {
			userId,
			clientId,
			awareness,
		} );
		const state: CollectionState = {
			session,
			providers: [],
			unloaded: false,
			awareness,
			selfRegister: `${ COLLECTION_SAVE_PREFIX }u${ userId }c${ clientId }`,
			saveSeq: 0,
			pendingSave: false,
			lastSignature: null,
		};
		collectionStates.set( objectType, state );

		/**
		 * The peer save registers as a comparable signature. The client's
		 * own register is excluded: its own saves must not refetch.
		 */
		const peerSignature = () => {
			const doc = session.getDocument();
			const entries = Object.entries( doc?.props ?? {} )
				.filter(
					( [ name ] ) =>
						name.startsWith( COLLECTION_SAVE_PREFIX ) &&
						name !== state.selfRegister
				)
				.sort( ( [ a ], [ b ] ) => ( a < b ? -1 : 1 ) );
			return JSON.stringify( entries );
		};

		session.onChange( () => {
			if ( state.unloaded || ! session.isInitialized() ) {
				return;
			}
			if ( state.pendingSave ) {
				state.pendingSave = false;
				announceCollectionSave( objectType );
			}
			const signature = peerSignature();
			if ( null === state.lastSignature ) {
				/*
				 * Bootstrap baseline: the resolver fetched the collection
				 * via REST immediately before loading the room, so the
				 * registers in the bootstrap document are already
				 * reflected — refetching would be redundant.
				 */
				state.lastSignature = signature;
				return;
			}
			if ( signature === state.lastSignature ) {
				return;
			}
			state.lastSignature = signature;
			void handlers.refetchRecords().catch( () => {} );
		} );

		log( 'connecting collection', { objectType } );
		state.providers = await Promise.all(
			providerCreators.map( async ( create: ProviderCreator ) => {
				const provider = await create( {
					objectType,
					objectId: null,
					session,
				} );
				provider.on( 'status', handlers.onStatusChange );
				return provider;
			} )
		);

		if ( state.unloaded ) {
			state.providers.forEach( ( provider ) => provider.destroy() );
		}
	}

	/**
	 * Announces a saved record of this object type to its collection room
	 * (when one is loaded) by bumping this client's save register. Peers
	 * observe the register change and refetch their collection query —
	 * how a newly created term reaches every collaborator's checklist.
	 *
	 * @param objectType Object type whose record was saved.
	 */
	function announceCollectionSave( objectType: ObjectType ): void {
		const state = collectionStates.get( objectType );
		if ( ! state || state.unloaded ) {
			return;
		}
		if ( ! state.session.isInitialized() ) {
			state.pendingSave = true; // Replayed on bootstrap.
			return;
		}
		const doc = state.session.getDocument();
		state.saveSeq++;
		state.session.author( 'set_property', {
			name: state.selfRegister,
			value: state.saveSeq,
			observedVersion: doc?.propVersions?.[ state.selfRegister ] ?? 0,
		} );
	}

	const manager: SyncManager = {
		load: loadEntity,

		loadCollection,

		update( objectType, objectId, changes, origin, options = {} ) {
			/*
			 * A record SAVE announces to the object type's collection room
			 * regardless of whether an entity is loaded: term saves arrive
			 * here with no entity state (nobody edits a term record in the
			 * editor), and the collection contract is save-notification,
			 * not content sync.
			 */
			if ( options.isSave ) {
				announceCollectionSave( objectType );
			}

			const state = entityStates.get( entityKey( objectType, objectId ) );
			if ( ! state || state.unloaded ) {
				return;
			}
			if ( ! state.session.isInitialized() ) {
				/*
				 * Snapshot not yet received; the editor still owns state and
				 * there is no document to author against. Buffer the tree
				 * (latest testimony wins) so the bootstrap change event can
				 * capture edits made during the join round trip — otherwise
				 * they stay local forever (the capture lane is edge-
				 * triggered, and an empty-genesis bootstrap pushes nothing
				 * that would reconcile the trees either).
				 */
				const preInit = changes.blocks as BridgeBlock[] | undefined;
				if ( preInit ) {
					state.preInitTree = preInit;
				}
				return;
			}

			// A deliberate undo-level boundary ends the current capture
			// chain: the next authored batch starts a fresh undo unit.
			if ( options.isNewUndoLevel ) {
				undoManager?.stopCapturing();
			}

			// core-data's `undoIgnore` edits and save responses carry this
			// origin: they sync like any edit but never become undo steps
			// (the Yjs undo manager does not track the origin either).
			const undoable = LOCAL_UNDO_IGNORED_ORIGIN !== origin;

			/*
			 * Entity property capture: an edits object carries a property
			 * only when the editor changed it, so presence IS intent (unlike
			 * block-tree absence). Same-value writes are echoes of our own
			 * push or of the document state and are suppressed.
			 */
			const doc = state.session.getDocument()!;
			// Property writes captured in THIS update call form one undo unit.
			const propertyEnvelopes: import('./intent-log/engine-types').IntentEnvelope[] =
				[];
			for ( const name of state.syncedProperties ) {
				if ( ! ( name in changes ) ) {
					continue;
				}
				let value = rawPropertyValue(
					changes as Record< string, unknown >,
					name
				) as SyncedPropertyValue | undefined;
				if ( undefined === value ) {
					continue;
				}
				// Term-ID arrays author in canonical (numeric) order.
				value = canonicalPropertyValue( value ) as SyncedPropertyValue;
				/*
				 * Per-property capture guards, mirroring the framework's
				 * applyPostChangesToCRDTDoc: the "Auto Draft" placeholder
				 * never overwrites an empty shared title, an invalid
				 * auto-draft status never syncs, and an empty slug (the
				 * auto-generated default) never syncs.
				 */
				if (
					'title' === name &&
					'Auto Draft' === value &&
					! doc.props?.title
				) {
					value = '';
				}
				if ( 'status' === name && 'auto-draft' === value ) {
					continue;
				}
				if ( 'slug' === name && ! value ) {
					continue;
				}
				if ( samePropertyValue( doc.props?.[ name ], value ) ) {
					continue;
				}
				state.lastPushedProps[ name ] = value;
				state.capturing = true;
				try {
					propertyEnvelopes.push(
						state.session.author( 'set_property', {
							name,
							value,
							observedVersion: doc.propVersions?.[ name ] ?? 0,
						} )
					);
				} finally {
					state.capturing = false;
				}
			}

			/*
			 * Meta capture: per-key registers under `meta.<key>` names. The
			 * edits object carries meta as the FULL merged object (editor
			 * edits, via mergedEdits) or a PARTIAL subkey set (the
			 * post-save server-mutation feed) — merging into knownMeta and
			 * per-key echo suppression handle both shapes.
			 */
			const metaChanges = metaObject(
				changes as Record< string, unknown >
			);
			if ( metaChanges ) {
				state.knownMeta = { ...state.knownMeta, ...metaChanges };
				for ( const [ metaKey, metaValue ] of Object.entries(
					metaChanges
				) ) {
					if (
						DISALLOWED_META_KEYS.has( metaKey ) ||
						undefined === metaValue ||
						'function' === typeof metaValue
					) {
						continue;
					}
					const name = META_PROPERTY_PREFIX + metaKey;
					if ( jsonDeepEqual( doc.props?.[ name ], metaValue ) ) {
						continue;
					}
					state.lastPushedProps[ name ] = metaValue;
					state.capturing = true;
					try {
						propertyEnvelopes.push(
							state.session.author( 'set_property', {
								name,
								value: metaValue,
								observedVersion:
									doc.propVersions?.[ name ] ?? 0,
							} )
						);
					} finally {
						state.capturing = false;
					}
				}
			}

			if ( undoable && propertyEnvelopes.length > 0 ) {
				undoManager?.noteAuthored( state.session, propertyEnvelopes );
			}

			const blocks = changes.blocks as BridgeBlock[] | undefined;
			if ( ! blocks ) {
				return; // Only whitelisted properties and blocks sync.
			}
			// This tree supersedes any buffered pre-init testimony.
			state.preInitTree = null;
			state.lastEditorEditAt = Date.now();
			// The stale-void recovery re-derives from this tree (see the
			// onDisposition handler in loadEntity).
			state.lastEditorTree = blocks;

			/*
			 * The incoming tree is the editor's own testimony about what it
			 * displays: every id it carries becomes removable from now on.
			 * (A push becomes removable when its echo arrives here.)
			 */
			const treeIds = collectBlockIds( blocks );
			for ( const id of treeIds ) {
				state.editorIds.add( id );
			}

			/*
			 * Capture against the state this tree was authored against, not
			 * the current head (see the module note): remote work that
			 * landed since is simply absent from the baseline, so the diff
			 * can neither delete it nor re-author it, and the intents carry
			 * the baseline's seq for the transform to merge over.
			 */
			chooseObservedBaseline( state, blocks );
			if ( ! state.observed ) {
				// Defensive: initialized without a change event.
				setObserved( state, {
					doc,
					seq: state.session.getSeq(),
					json: canonicalBlocksJson( documentBlocks( state, doc ) ),
				} );
			}
			const baseDoc = state.observed!.doc;

			const derived = deriveIntents( baseDoc, blocks, {
				// Only blocks the editor has displayed may be deleted
				// by its tree's absence; never-seen blocks are retained.
				removableIds: state.editorIds,
				// Remotely removed blocks in a stale tree are not
				// resurrected.
				excludeIds: state.docTombstones,
				richTextFields: state.fieldsResolver,
				rawContent: state.rawContent,
				// Save-accurate wrapper/content authoring.
				saveMarkup: saveMarkupAdapter,
			} );

			if ( derived ) {
				// Id-less blocks in the tree confirm their adopted/minted ids.
				const confirmIds = ( specs: typeof derived.specs ) => {
					for ( const spec of specs ) {
						state.editorIds.add( spec.syncId as string );
						confirmIds(
							( spec.children as typeof derived.specs ) ?? []
						);
					}
				};
				confirmIds( derived.specs );
				/*
				 * Blocks whose identity this capture assigned keep the
				 * editor's own clientId in every future push. Without the
				 * seed, the first identity write-back mints a fresh
				 * clientId for a just-created block, and the swap remounts
				 * it, destroying component-local UI state (the HTML
				 * block's just-opened edit modal, focus, open dropdowns).
				 */
				for ( const [ syncId, clientId ] of derived.editorClientIds ) {
					state.clientIds.set( syncId, clientId );
				}
				if ( derived.coarseBlockCount > 0 ) {
					log( 'coarse capture', {
						origin,
						blocks: derived.coarseBlockCount,
					} );
				}
				state.capturing = true;
				try {
					const envelopes = state.session.authorBatch(
						derived.intents
					);
					if ( undoable ) {
						undoManager?.noteAuthored( state.session, envelopes );
					}
				} finally {
					state.capturing = false;
				}
				/*
				 * The editor now displays the baseline plus what it just
				 * told us — NOT the merged head, which it has not seen. Its
				 * seq is unchanged: this tree observed no new remote work.
				 */
				const observedDoc = applyDerivedIntents(
					baseDoc,
					derived.intents
				);
				setObserved( state, {
					doc: observedDoc,
					seq: state.session.getObservedSeq(),
					json: canonicalBlocksJson(
						documentBlocks( state, observedDoc )
					),
				} );
			}

			/*
			 * Push the editor forward when its tree was behind the shared
			 * document. Content divergence is caught by syncEditor's own
			 * comparison; these are the cases where the tree diverges from
			 * the baseline in ways that comparison cannot see:
			 *
			 * - missing identities (freshly parsed or new blocks needing
			 *   their adopted/minted ids — the churn bug): the baseline
			 *   carries the ids, the editor's tree does not;
			 * - retained never-displayed blocks: the baseline keeps them,
			 *   the editor does not show them. Without this forced push,
			 *   deleting a just-arrived remote block BEFORE any tree
			 *   testified it left the editor silently behind the document
			 *   forever (found by the fuzzer after a peer re-joined). The
			 *   push visibly resurrects the block; the next tree then makes
			 *   the id removable, so repeating the deletion works;
			 * - blocks dropped because a remote deletion outranked the
			 *   stale tree.
			 */
			const editorHadAllIds = blocks.every( function hasId(
				block: BridgeBlock
			): boolean {
				const metadata = block.attributes?.metadata as
					| { syncId?: string }
					| undefined;
				return !! metadata?.syncId && block.innerBlocks.every( hasId );
			} );
			const treeHasTombstoned = [ ...treeIds ].some( ( id ) =>
				state.docTombstones.has( id )
			);
			const specIdSet = new Set< string >();
			const collectFromSpecs = (
				specs: Array< Record< string, unknown > > = []
			) => {
				for ( const spec of specs ) {
					specIdSet.add( spec.syncId as string );
					collectFromSpecs(
						spec.children as Array< Record< string, unknown > >
					);
				}
			};
			collectFromSpecs( derived?.specs );
			/*
			 * Identity remapping also counts as "behind": when adoption
			 * resolved a tree id onto a different document identity (or
			 * minted one), the editor must receive the document's
			 * authoritative ids — the document is the identity authority,
			 * and saved content must carry ITS ids, identical across all
			 * peers, for identity to be durable across sessions.
			 */
			const idsRemapped = [ ...specIdSet ].some(
				( id ) => ! treeIds.has( id )
			);
			scheduleEditorSync(
				state,
				! editorHadAllIds ||
					idsRemapped ||
					treeHasTombstoned ||
					( derived?.retainedIds.size ?? 0 ) > 0
			);
		},

		getAwareness: < State extends Awareness >(
			objectType: ObjectType,
			objectId: ObjectID | null
		) => {
			return entityStates.get( entityKey( objectType, objectId ) )
				?.awareness as State | undefined;
		},

		resolveProposal( objectType, objectId, proposalId, resolution ) {
			const state = entityStates.get( entityKey( objectType, objectId ) );
			if ( ! state || state.unloaded ) {
				return;
			}
			state.session.resolveProposal( proposalId, resolution );
		},

		restoreProposal( objectType, objectId, proposalId ) {
			const state = entityStates.get( entityKey( objectType, objectId ) );
			if ( ! state || state.unloaded ) {
				return;
			}
			const session = state.session;
			const proposal = session
				.getOpenProposals()
				.find( ( open ) => open.intent.intentId === proposalId );
			if ( ! proposal ) {
				return;
			}
			/*
			 * Best-effort re-author at the current head — restoration is an
			 * ORDINARY edit through the normal planning rules, never a
			 * privileged replay. Text appends to the target field (or a
			 * fresh paragraph when the block is gone); register writes
			 * re-apply at current observed versions. Types with no sensible
			 * auto-restore just resolve; the notice showed the content for
			 * manual recovery.
			 */
			const { type, payload } = proposal.intent;
			const doc = session.getDocument();
			const findBlock = (
				blocks: import('./intent-log/engine-types').EngineBlock[],
				id: string
			): import('./intent-log/engine-types').EngineBlock | null => {
				for ( const block of blocks ) {
					if ( block.syncId === id ) {
						return block;
					}
					const inChildren = findBlock( block.children, id );
					if ( inChildren ) {
						return inChildren;
					}
				}
				return null;
			};
			const restoreText = ( text: string ) => {
				const targetId = payload.syncId as string;
				const field = ( payload.field as string ) ?? 'content';
				const block = doc ? findBlock( doc.root, targetId ) : null;
				if ( block ) {
					const current = block.fields[ field ]?.text ?? '';
					session.author( 'insert_text', {
						syncId: targetId,
						field,
						offset: current.length,
						text,
					} );
				} else {
					session.author( 'insert_block', {
						block: {
							syncId: mintSyncId(),
							blockType: 'core/paragraph',
							text,
						},
						parentId: null,
						afterSiblingId: doc?.root.at( -1 )?.syncId ?? null,
					} );
				}
			};
			let restoredText: string | null = null;
			if ( 'insert_text' === type || 'replace_text' === type ) {
				restoredText = payload.text as string;
			} else if ( 'replace_attr_content' === type ) {
				restoredText = payload.newText as string;
			}
			if ( restoredText ) {
				restoreText( restoredText );
			} else if ( 'set_attr' === type && doc ) {
				const block = findBlock( doc.root, payload.syncId as string );
				if ( block ) {
					session.author( 'set_attr', {
						syncId: payload.syncId as string,
						key: payload.key as string,
						value: payload.value,
						observedVersion:
							block.attrVersions[ payload.key as string ] ?? 0,
					} );
				}
			} else if ( 'set_property' === type && doc ) {
				session.author( 'set_property', {
					name: payload.name as string,
					value: payload.value,
					observedVersion:
						doc.propVersions?.[ payload.name as string ] ?? 0,
				} );
			} else if ( 'insert_block' === type && doc ) {
				/*
				 * Re-insert the parked block spec under FRESH identities
				 * (the original insert never applied; reminting sidesteps
				 * any duplicate/tombstone history). Anchors degrade: a
				 * vanished parent falls back to the root, a vanished
				 * sibling to the end. This is what makes restoring a
				 * requires-approval block an approval — the re-authored
				 * intent carries the RESTORER's capability.
				 */
				type SpecShape = {
					syncId: string;
					children?: SpecShape[];
					[ key: string ]: unknown;
				};
				const remint = ( spec: SpecShape ): SpecShape => ( {
					...spec,
					syncId: mintSyncId(),
					children: ( spec.children ?? [] ).map( remint ),
				} );
				const parentId =
					typeof payload.parentId === 'string' &&
					findBlock( doc.root, payload.parentId )
						? ( payload.parentId as string )
						: null;
				const afterSiblingId =
					typeof payload.afterSiblingId === 'string' &&
					findBlock( doc.root, payload.afterSiblingId )
						? ( payload.afterSiblingId as string )
						: ( ! parentId && doc.root.at( -1 )?.syncId ) || null;
				session.author( 'insert_block', {
					block: remint( payload.block as SpecShape ),
					parentId,
					afterSiblingId,
				} );
			}
			session.resolveProposal( proposalId, 'restored' );
		},

		// The server materializes; there is no client-side persisted doc.
		createPersistedCRDTDoc: async () => null,
		getEntitySnapshot: () => undefined,
		entityContainsSnapshot: () => false,

		// Collaborative undo: inverse intents over the accepted log (see
		// the module note and intent-log-undo.ts). Lazily created on the
		// first entity load, hence the getter.
		get undoManager() {
			return undoManager;
		},

		unload( objectType, objectId ) {
			// A null objectId addresses the object type's collection room.
			if ( null === objectId ) {
				const collection = collectionStates.get( objectType );
				if ( ! collection ) {
					return;
				}
				collection.unloaded = true;
				collection.providers.forEach( ( provider ) =>
					provider.destroy()
				);
				collection.awareness?.destroy();
				collection.session.destroy();
				collectionStates.delete( objectType );
				return;
			}
			const key = entityKey( objectType, objectId );
			pendingLoads.delete( key );
			const state = entityStates.get( key );
			if ( ! state ) {
				return;
			}
			state.unloaded = true;
			if ( state.syncTimer ) {
				clearTimeout( state.syncTimer );
			}
			state.providers.forEach( ( provider ) => provider.destroy() );
			state.awareness?.destroy();
			state.session.destroy();
			entityStates.delete( key );
		},

		unloadAll() {
			pendingLoads.clear();
			for ( const [ , state ] of entityStates ) {
				state.unloaded = true;
				if ( state.syncTimer ) {
					clearTimeout( state.syncTimer );
				}
				state.providers.forEach( ( provider ) => provider.destroy() );
				state.awareness?.destroy();
				state.session.destroy();
			}
			entityStates.clear();
			for ( const [ , collection ] of collectionStates ) {
				collection.unloaded = true;
				collection.providers.forEach( ( provider ) =>
					provider.destroy()
				);
				collection.awareness?.destroy();
				collection.session.destroy();
			}
			collectionStates.clear();
			undoManager?.reset();
			undoManager = undefined;
		},

		// Transport-agnostic retry: ask every live provider to retry after a
		// connection error (wired to the editor's connection-error modal).
		retry() {
			for ( const [ , state ] of entityStates ) {
				state.providers.forEach( ( provider ) => provider.retry?.() );
			}
			for ( const [ , collection ] of collectionStates ) {
				collection.providers.forEach(
					( provider ) => provider.retry?.()
				);
			}
		},
	};
	return manager;
}
