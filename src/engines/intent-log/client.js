/**
 * Client-side rebase. See SPEC.md ("Client-side rebase and prediction").
 *
 * A client keeps a verbatim copy of the log prefix it has observed
 * (`log`, up to `cursor`) plus its pending outbox, exactly as authored.
 * On every catch-up it replans the outbox with planBatch — the SAME pure
 * planner the server runs at ingest — against its log copy. The plan yields:
 *
 * - the optimistic document (`doc`): acked state plus every pending intent
 *   that would survive, with rebased payloads, applied in authoring order;
 * - a predicted disposition for every pending intent.
 *
 * Because planner inputs are (batch, log) and a caught-up client has the
 * same log the server will plan against, flush-time predictions match the
 * server's dispositions by construction. The simulator's prediction oracle
 * guards that construction: any hidden server-side state or client-side
 * shortcut that breaks the equivalence surfaces as a prediction mismatch.
 *
 * The outbox always ships ORIGINAL intents — envelopes are immutable and
 * the server re-derives every transform itself. Escalated or voided pending
 * intents stay in the outbox too: the server must ingest them to record
 * their dispositions and file proposals; they are merely absent from the
 * optimistic document.
 */

import { cloneDocument } from './document.js';
import { applyIntent } from './reducer.js';
import {
	groupUnits,
	planBatch,
	serverDocAt,
	serverIngestBatch,
} from './rebase.js';

/** @typedef {import('./engine-types').ClientReplica} ClientReplica */
/** @typedef {import('./engine-types').EngineDocument} EngineDocument */
/** @typedef {import('./engine-types').IntentDisposition} IntentDisposition */
/** @typedef {import('./engine-types').IntentEnvelope} IntentEnvelope */
/** @typedef {import('./engine-types').IntentLogServer} IntentLogServer */

/**
 * One flushed intent's predicted vs actual disposition, for the
 * simulator's prediction oracle.
 *
 * @typedef {Object} FlushReportRow
 * @property {string}                 intentId  Intent id.
 * @property {IntentDisposition|null} predicted The client's prediction.
 * @property {IntentDisposition}      [actual]  The server's disposition.
 */

/**
 * Creates a client replica.
 *
 * @param {string}         actorId    Actor id.
 * @param {EngineDocument} initialDoc Genesis document.
 * @param {number}         [firstSeq] Engine seq of the initial document (> 0 when
 *                                    bootstrapping from a server checkpoint).
 * @return {ClientReplica} Client state.
 */
export function createClient( actorId, initialDoc, firstSeq = 0 ) {
	return {
		actorId,
		cursor: firstSeq,
		online: true,
		outbox: [],
		nextIntent: 0,
		// Verbatim copy of the observed log entries [firstSeq ..), plus the
		// same seq → document cache shape the server uses (serverDocAt works
		// on both). firstSeq > 0 when initialized from a server compaction
		// checkpoint, or after trimClientLog().
		firstSeq,
		// Lowest seq the log must stay sliceable from, beyond what the outbox
		// needs (see trimClientLog); null imposes nothing. Owners that author
		// against an OLDER observed state — the entity bridge captures the
		// editor tree against the document that tree last reflected — set it
		// to that state's seq.
		retainFrom: null,
		log: [],
		docCache: new Map( [ [ firstSeq, cloneDocument( initialDoc ) ] ] ),
		baseDoc: cloneDocument( initialDoc ),
		doc: cloneDocument( initialDoc ),
		// intentId → predicted disposition, from the latest replan.
		predictions: /** @type {Map<string, IntentDisposition>} */ ( new Map() ),
	};
}

/**
 * @param {ClientReplica} client Client.
 */
function replan( client ) {
	if ( client.outbox.length === 0 ) {
		client.doc = client.baseDoc;
		client.predictions = new Map();
		return;
	}
	const { rows, headDoc } = planBatch(
		groupUnits( client.outbox ),
		client.log,
		( seq ) => serverDocAt( client, seq ),
		client.firstSeq
	);
	client.predictions = new Map(
		rows.map( ( row ) => [ row.intent.intentId, row.disposition ] )
	);
	client.doc = headDoc;
}

/**
 * Drops log entries (and cached documents) the replica can never need
 * again: nothing below the oldest pending intent's baseSeq (or the cursor,
 * when the outbox is empty) is ever sliced by a replan, and nothing below
 * `retainFrom`, the oldest seq the owner may still author at. Without this
 * the client's log copy grows for the lifetime of the session.
 *
 * Planner-neutral by construction: planBatch only ever slices the log from
 * a pending intent's baseSeq, and rebases against docAt(baseSeq) — both
 * remain reachable after the trim.
 *
 * @param {ClientReplica} client Client.
 */
export function trimClientLog( client ) {
	const pendingFloor = client.outbox.length
		? Math.min( ...client.outbox.map( ( intent ) => intent.baseSeq ) )
		: client.cursor;
	const floor = Math.min( pendingFloor, client.retainFrom ?? pendingFloor );
	if ( floor <= client.firstSeq ) {
		return;
	}
	const floorDoc = serverDocAt( client, floor );
	client.log = client.log.slice( floor - client.firstSeq );
	client.firstSeq = floor;
	client.docCache = new Map( [
		[ floor, floorDoc ],
		[ client.cursor, client.baseDoc ],
	] );
}

/**
 * Queues an intent authored against the client's optimistic state and
 * applies it optimistically. (Equivalent to a full replan: the new intent
 * is last in the batch and its slice is empty at authoring time.)
 *
 * @param {ClientReplica}  client Client.
 * @param {IntentEnvelope} intent Intent (authored against client.doc).
 * @return {IntentDisposition} Local apply disposition.
 */
export function authorIntent( client, intent ) {
	client.outbox.push( intent );
	const { doc, disposition } = applyIntent( client.doc, intent );
	client.doc = doc;
	client.predictions.set( intent.intentId, disposition );
	return disposition;
}

/**
 * Recomputes the optimistic document and predictions from the outbox.
 *
 * authorIntent() applies each new intent straight onto the optimistic head,
 * which is only correct when the intent was authored at that head. An intent
 * authored against an OLDER observed state carries coordinates in that older
 * frame, so its effect on the head is whatever the planner's rebase makes of
 * it — exactly what a replan computes.
 *
 * @param {ClientReplica} client Client.
 */
export function replanClient( client ) {
	replan( client );
}

/**
 * The client's prediction for a pending intent's server disposition. Exact
 * once the client is caught up to the server head.
 *
 * @param {ClientReplica} client   Client.
 * @param {string}        intentId Intent id.
 * @return {IntentDisposition|null} Predicted disposition.
 */
export function predictedDisposition( client, intentId ) {
	return client.predictions.get( intentId ) ?? null;
}

/**
 * Absorbs new log entries and replans pending work over them — the same
 * code path for a poll delta or an "offline for hours" reconnect batch.
 *
 * @param {ClientReplica}    client   Client.
 * @param {IntentEnvelope[]} entries  New log entries, starting at client.cursor.
 * @param {number}           startSeq Log index of entries[0] (=== client.cursor).
 */
export function clientReceive( client, entries, startSeq ) {
	if ( startSeq !== client.cursor ) {
		throw new Error(
			`clientReceive: entries start at ${ startSeq }, cursor is ${ client.cursor }`
		);
	}
	client.log.push( ...entries );
	client.cursor = client.firstSeq + client.log.length;
	client.baseDoc = serverDocAt( client, client.cursor );
	replan( client );
	trimClientLog( client );
}

/**
 * Catches the client up to the server head (replanning pending work),
 * without pushing the outbox. Models a poll or reconnect that receives
 * before it sends.
 *
 * @param {IntentLogServer} server Server.
 * @param {ClientReplica}   client Client.
 */
export function catchUp( server, client ) {
	clientReceive(
		client,
		server.log.slice( client.cursor - ( server.firstSeq ?? 0 ) ),
		client.cursor
	);
}

/**
 * Full sync cycle: catch up, record predictions, push the outbox, verify
 * the server agreed, catch up over the accepted entries.
 *
 * @param {IntentLogServer} server Server.
 * @param {ClientReplica}   client Client.
 * @return {FlushReportRow[]} Per-intent { intentId, predicted, actual } for the
 *                            flushed batch, for the prediction oracle.
 */
export function flushClient( server, client ) {
	catchUp( server, client );
	const batch = client.outbox;
	/** @type {FlushReportRow[]} */
	const report = batch.map( ( intent ) => ( {
		intentId: intent.intentId,
		predicted: predictedDisposition( client, intent.intentId ),
	} ) );
	const dispositions = serverIngestBatch( server, batch );
	for ( let i = 0; i < report.length; i++ ) {
		report[ i ].actual = dispositions[ i ];
	}
	client.outbox = [];
	client.predictions = new Map();
	catchUp( server, client );
	return report;
}
