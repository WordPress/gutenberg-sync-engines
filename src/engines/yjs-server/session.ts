/**
 * External dependencies
 */
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Internal dependencies
 */
import type {
	EngineLocalUpdateListener,
	EngineSessionCodec,
	EngineUpdate,
} from '@wordpress/sync';
import { applyServerAwarenessStates } from '../awareness-sync';
import { SyncUpdateType } from '../../providers/http-polling/types';
import type { TransportSessionExtensions } from '../../providers/session-extensions';
import {
	base64ToUint8Array,
	createSyncUpdate,
} from '../../providers/http-polling/utils';

/**
 * Origin tag for Yjs transactions applied by this session, so updates the
 * session applies are not reported back as local updates.
 */
const YJS_SERVER_SESSION_ORIGIN = 'yjs-server-session';

/**
 * Slug of the yjs-server engine. Must match WP_Yjs_Server_Engine::SLUG on
 * the PHP side.
 */
export const YJS_SERVER_ENGINE_SLUG = 'yjs-server';

/**
 * Protocol version of the yjs-server engine. Must match
 * WP_Yjs_Server_Engine::PROTOCOL_VERSION on the PHP side.
 */
export const YJS_SERVER_ENGINE_PROTOCOL = 1;

/**
 * Server-emitted row type carrying a full-state snapshot as JSON
 * `{ doc: <base64 V2> }`: the room genesis and compaction checkpoints.
 * Matches WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT. Receive-only —
 * clients never send it.
 */
export const YJS_SERVER_SNAPSHOT_TYPE = 'snapshot';

/**
 * The yjs-server session codec: EngineSessionCodec plus the transport
 * capabilities this engine declares.
 */
export interface YjsServerSessionCodec
	extends EngineSessionCodec,
		Pick< TransportSessionExtensions, 'onRoomRestart' > {
	/**
	 * Transport capability: flush queued updates even with no collaborator
	 * present. The SERVER's document is the source of truth for every
	 * (re)joining client, so the room must track a solo session too: updates
	 * held back while solo are invisible to the client's own next page load,
	 * which bootstraps from the server snapshot and would wipe the editor
	 * back to the room's stale state. Ingest is idempotent (redelivered
	 * updates settle as benign already-merged voids), so solo sends are safe.
	 */
}

/**
 * Options for creating a yjs-server session codec.
 */
export interface YjsServerSessionOptions {
	/**
	 * The awareness instance tracking collaborator presence. When omitted, a
	 * standalone instance is created so remote awareness states can still be
	 * applied.
	 */
	awareness?: Awareness;

	/** The Yjs document holding the entity state. */
	doc: Y.Doc;
}

/**
 * Encodes the document's full state as an `update` row. Full-state uploads
 * are safe against this engine: the server merges idempotently and stores
 * only the diff of what it did not already have.
 *
 * @param doc The Yjs document.
 */
function createFullStateUpdate( doc: Y.Doc ): EngineUpdate {
	return createSyncUpdate(
		Y.encodeStateAsUpdateV2( doc ),
		SyncUpdateType.UPDATE
	);
}

/**
 * Creates the yjs-server engine's session codec for one entity/room.
 *
 * Unlike the relay codec there is no sync_step1/step2 peer dance: the
 * SERVER holds the canonical document. A joining client receives the
 * genesis/checkpoint snapshot plus the update tail, sends its own edits as
 * incremental V2 `update` rows, and — when it already holds local state
 * (a rejoin) — uploads its full state as an ordinary update the server
 * dedups via diffing.
 *
 * @param options The Yjs document and optional awareness to wrap.
 * @return The transport-facing session codec.
 */
export function createYjsServerSessionCodec(
	options: YjsServerSessionOptions
): YjsServerSessionCodec {
	const { doc } = options;
	const awareness = options.awareness ?? new Awareness( doc );

	let localUpdateListener: EngineLocalUpdateListener | null = null;
	let isDocListenerAttached = false;
	// The first snapshot this session received, byte for byte. A room
	// restart whose genesis is identical to it is safe to rejoin (the
	// server builds genesis deterministically, so an unchanged saved post
	// yields the same items and a full-state upload is an ordinary merge).
	let firstSnapshotData: string | null = null;

	function snapshotDocData( update: EngineUpdate ): string | null {
		try {
			const decoded = JSON.parse( update.data );
			return 'string' === typeof decoded?.doc ? decoded.doc : null;
		} catch {
			return null;
		}
	}

	function onDocUpdate( update: Uint8Array, origin: unknown ): void {
		if ( YJS_SERVER_SESSION_ORIGIN === origin ) {
			return;
		}

		localUpdateListener?.(
			createSyncUpdate( update, SyncUpdateType.UPDATE ),
			update.byteLength
		);
	}

	function processDocUpdate( update: EngineUpdate ): EngineUpdate | void {
		switch ( update.type ) {
			case YJS_SERVER_SNAPSHOT_TYPE: {
				// Snapshot rows carry JSON, not raw base64 (the transport
				// moves `data` opaquely either way).
				try {
					const decoded = JSON.parse( update.data );
					if ( 'string' === typeof decoded?.doc ) {
						if ( null === firstSnapshotData ) {
							firstSnapshotData = decoded.doc;
						}
						Y.applyUpdateV2(
							doc,
							base64ToUint8Array( decoded.doc ),
							YJS_SERVER_SESSION_ORIGIN
						);
					}
				} catch {
					// A malformed snapshot cannot be applied; the next
					// checkpoint or update row resynchronizes.
				}
				return;
			}

			case SyncUpdateType.UPDATE: {
				Y.applyUpdateV2(
					doc,
					base64ToUint8Array( update.data ),
					YJS_SERVER_SESSION_ORIGIN
				);
			}
		}
	}

	return {
		applyRemoteAwareness: ( state ) =>
			applyServerAwarenessStates(
				state,
				awareness,
				YJS_SERVER_SESSION_ORIGIN
			),
		clientId: doc.clientID,
		engineSlug: YJS_SERVER_ENGINE_SLUG,
		engineProtocol: YJS_SERVER_ENGINE_PROTOCOL,
		// The server compacts by itself and never nominates a client, so
		// the optional compaction members are omitted. Unknown-outcome
		// recovery re-sends full state; the server stores only what it was
		// actually missing.
		createRecoveryUpdate: () => createFullStateUpdate( doc ),
		destroy() {
			if ( isDocListenerAttached ) {
				doc.off( 'updateV2', onDocUpdate );
				isDocListenerAttached = false;
			}
			localUpdateListener = null;
		},
		// A fresh client has nothing to announce: the server's snapshot row
		// bootstraps it. A client that already holds state (a rejoin after a
		// dropped session) uploads it; the server diffs out what it already
		// has, so redundancy costs bytes, never correctness.
		getInitialUpdates: () =>
			0 === doc.store.clients.size
				? []
				: [ createFullStateUpdate( doc ) ],
		getLocalAwareness: () => awareness.getLocalState() ?? {},
		onLocalUpdate( listener ) {
			localUpdateListener = listener;
			if ( ! isDocListenerAttached ) {
				doc.on( 'updateV2', onDocUpdate );
				isDocListenerAttached = true;
			}
		},
		receiveUpdate: ( update ) => processDocUpdate( update ),
		/*
		 * Room restart: the client's Y.Doc is bound to the editor and
		 * cannot be replaced, and two documents built separately can only
		 * be merged when they share their genesis items. If the new genesis
		 * is byte-identical to the one this session started from (the
		 * saved post did not change), rejoin: the initial full-state upload
		 * re-establishes local edits as an ordinary merge. Otherwise the
		 * new genesis reuses the fixed genesis client id with DIFFERENT
		 * content — merging would corrupt, not merge — so the session
		 * leaves the room and the editor keeps its edits as unsaved
		 * changes.
		 */
		onRoomRestart: ( updates ) => {
			const snapshot = updates.find(
				( update ) => YJS_SERVER_SNAPSHOT_TYPE === update.type
			);
			const genesis = snapshot ? snapshotDocData( snapshot ) : null;
			if (
				null !== genesis &&
				null !== firstSnapshotData &&
				genesis === firstSnapshotData
			) {
				return 'rebootstrap';
			}
			return 'disconnect';
		},
	};
}
