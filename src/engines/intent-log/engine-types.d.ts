/**
 * Shared types for the intent-log engine core.
 *
 * The core modules are JavaScript (they run under Node with no build step
 * and mirror a PHP twin), typed through JSDoc that references these shared
 * interfaces. Every module is checked by `tsc` (`checkJs`), and TypeScript
 * consumers get their types from the modules' JSDoc directly — there are no
 * hand-written per-module declarations to drift. Behavior itself is pinned
 * by the jest suites and the frozen cross-language vectors.
 */

export interface FormatSpan {
	start: number;
	end: number;
	format: string;
}

export interface EngineField {
	text: string;
	formats: FormatSpan[];
}

export interface EngineBlock {
	syncId: string;
	blockType: string;
	attrs: Record< string, unknown >;
	attrVersions: Record< string, number >;
	fields: Record< string, EngineField >;
	syncParent: string | null;
	children: EngineBlock[];
}

export interface EngineDocument {
	root: EngineBlock[];
	/** Entity properties (title, excerpt, …); absent until first write. */
	props?: Record< string, unknown >;
	propVersions?: Record< string, number >;
}

export interface IntentEnvelope {
	intentId: string;
	actorId: string;
	baseSeq: number;
	txnId: string | null;
	type: string;
	payload: Record< string, unknown >;
}

export interface IntentDisposition {
	status: 'applied' | 'escalated' | 'voided';
	reason?: string;
}

export interface ClientReplica extends LogReplica {
	actorId: string;
	cursor: number;
	online: boolean;
	outbox: IntentEnvelope[];
	nextIntent: number;
	/**
	 * Lowest seq the log must stay sliceable from beyond what the outbox
	 * needs; null imposes nothing (see trimClientLog).
	 */
	retainFrom: number | null;
	baseDoc: EngineDocument;
	doc: EngineDocument;
	predictions: Map< string, IntentDisposition >;
}

/** A rebased intent set aside for human review (never auto-merged). */
export interface IntentProposal {
	intent: IntentEnvelope;
	actorId: string;
	reason: string;
}

/** The planner's verdict on one intent of a batch. */
export interface PlanRow {
	intent: IntentEnvelope;
	disposition: IntentDisposition;
	accepted: IntentEnvelope | null;
	proposal: IntentProposal | null;
}

/**
 * What `serverDocAt` needs: a log prefix plus a seq → document cache. Both
 * the server and a client replica have this shape.
 */
export interface LogReplica {
	/** Engine seq of log[0] (> 0 after a checkpoint bootstrap or trim). */
	firstSeq: number;
	log: IntentEnvelope[];
	docCache: Map< number, EngineDocument >;
}

/** The in-memory reference server (the PHP twin's model). */
export interface IntentLogServer extends LogReplica {
	initialDoc: EngineDocument;
	proposals: IntentProposal[];
	dispositions: Map< string, IntentDisposition >;
	recorder?: IntentEnvelope[][];
}

/**
 * Per-family payload fields, as validated by intents.js (its
 * PAYLOAD_SCHEMAS). Payloads travel as `Record< string, unknown >` and are
 * validated per intent type at creation; the reducer and planner trust that
 * validation and read each family's fields by name through `IntentPayload`.
 */

/** The map family: block attribute registers. */
export interface AttrPayload {
	/** Target block. */
	syncId: string;
	/** Attribute name. */
	key: string;
	/** New value (set_attr only). */
	value: unknown;
	/** Register version the author saw. */
	observedVersion: number;
}

/** The entity family: document-level property registers. */
export interface PropertyPayload {
	/** Property name. */
	name: string;
	/** New value. */
	value: unknown;
	/** Register version the author saw. */
	observedVersion: number;
}

/** The structure family: block insert/remove/move/split/merge/transform. */
export interface StructurePayload {
	/** Target block (or split head). */
	syncId: string;
	/** Inserted subtree (insert_block). */
	block: import( './document.js' ).BlockSpec;
	/** Insert parent, null at the root. */
	parentId: string | null;
	/** Insert/move anchor, null = first. */
	afterSiblingId: string | null;
	/** Move destination, null = root. */
	newParentId: string | null;
	/** Split tail's id. */
	newSyncId: string;
	/** Merge survivor. */
	survivorId: string;
	/** Merge absorbed block. */
	absorbedId: string;
	/** Transform target type. */
	newBlockType: string;
}

/** The text family: edits within one named rich-text field. */
export interface TextPayload {
	/** Target block. */
	syncId: string;
	/** Field name. */
	field: string;
	/** Insert/split position. */
	offset: number;
	/** Range start (delete/format/replace). */
	start: number;
	/** Range end (exclusive). */
	end: number;
	/** Inserted text. */
	text: string;
	/** Whether format_text adds (true) or removes. */
	on: boolean;
	/** Format id (format_text). */
	format: string;
	/** Whole replacement (replace_attr_content). */
	newText: string;
}

/**
 * Every field any intent family may carry. An intersection, not a union:
 * the core destructures a payload before switching on the intent type.
 */
export type IntentPayload = AttrPayload &
	PropertyPayload &
	StructurePayload &
	TextPayload;
