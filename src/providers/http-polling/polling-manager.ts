/**
 * WordPress dependencies
 */
import { applyFilters } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import { SseExchange } from '../sse/sse-exchange';
import {
	DEFAULT_CLIENT_LIMIT_PER_ROOM,
	ERROR_RETRY_DELAYS_SOLO_MS,
	ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS,
	MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES,
	MIN_SYNC_REQUEST_BODY_SIZE_LIMIT_IN_BYTES,
	MAX_ROOMS_PER_REQUEST,
	MAX_UPDATE_SIZE_IN_BYTES,
	POLLING_INTERVAL_IN_MS,
	POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS,
	POLLING_INTERVAL_BACKGROUND_TAB_IN_MS,
	DISCONNECT_DIALOG_RETRY_MS,
	MANUAL_RETRY_INTERVAL_MS,
	LOCAL_UPDATE_POLL_DELAY_MS,
	ANNOUNCE_POLL_COALESCE_MS,
	ANNOUNCE_POLL_MIN_GAP_MS,
	FAST_DISCOVERY_WINDOW_MS,
} from './config';
import { ConnectionError, ConnectionErrorCode } from '../../framework';
import {
	advisoryCoversClients,
	getChannelPresence,
	onAdvisoryAnnounce,
	onAdvisoryCoverageChanged,
	onAdvisoryPresence,
	setAdvisoryDisabledByTransport,
	setPresenceSource,
	startAdvisoryChannel,
	stopAdvisoryChannel,
} from '../advisory/channel';
import {
	announceLocalWrite,
	onLocalAwarenessChange,
} from '../advisory/announce';
import { BLOCK_FIELD } from '../../awareness/channels/sync-channel';
import {
	applyAnswer,
	buildProbe,
	probeFailed,
	installSignaling,
	installSignalingLifecycle,
	isSignalingAvailable,
	onOthersChanged,
	onRoomCursor,
	onRoomEngine,
	othersPresent,
	getPresenceRoom,
	getPresenceToken,
	setSignalCarrier,
	setSyncClientId,
} from '../advisory/signaling';
import { registerSaveFlush } from './save-flush';
import type {
	ConnectionStatus,
	EngineDisposition,
	EngineSessionCodec,
} from '@wordpress/sync';
import type { TransportSessionCodec } from '../session-extensions';
import {
	installSyncDebug,
	isSyncDebugEnabled,
	recordPoll,
	registerDebugSession,
	unregisterDebugSession,
} from '../../debug/inspector';
import type {
	AwarenessState,
	SyncPayload,
	SyncResponse,
	SyncUpdate,
	UpdateQueue,
} from './types';
import {
	createUpdateQueue,
	intValueOrDefault,
	postSyncUpdate,
	postSyncUpdateNonBlocking,
	rotateWindow,
} from './utils';

type LogFunction = (
	message: string,
	debug?: object,
	errorLevel?: 'error' | 'log' | 'warn',
	force?: boolean
) => void;

interface PollingManager {
	registerRoom: ( options: RegisterRoomOptions ) => void;
	releaseRoom: ( room: string ) => Promise< ReleasedRoom >;
	retryNow: () => void;
	unregisterRoom: (
		room: string,
		options?: { sendDisconnectSignal?: boolean }
	) => void;
}

interface RegisterRoomOptions {
	room: string;
	session: EngineSessionCodec;
	log: LogFunction;
	onStatusChange: ( status: ConnectionStatus ) => void;
	/**
	 * Where to resume in the room's history: a preferred transport
	 * (websocket) hands a room to short polling at the cursor its socket
	 * had reached, so nothing is replayed or skipped.
	 */
	initialCursor?: number;
	/** Updates to queue behind the session's own initial ones. */
	initialUpdates?: SyncUpdate[];
}

/**
 * What a preferred transport takes back when it reclaims a room from
 * short polling (see releaseRoom).
 */
export interface ReleasedRoom {
	cursor: number;
	unsent: SyncUpdate[];
}

/**
 * What a send's answer carries, waiting for the receive lane to bring the
 * room's cursor up to the head the write saw (see the send lane).
 */
interface HeldTail {
	endCursor: number;
	updates: SyncUpdate[];
	dispositions?: EngineDisposition[];
	shouldCompact?: boolean;
}

interface RoomState {
	endCursor: number;
	/** The room generation this session bootstrapped under (see types). */
	generation?: string;
	/** Answers to sends made beside the stream, oldest first. */
	heldTails: HeldTail[];
	isPrimaryRoom: boolean;
	/** The awareness map the last poll response carried for this room. */
	lastServerAwareness: AwarenessState;
	/** Whether this room's queue is held while the tab is alone. */
	holdWhileAlone: boolean;
	log: LogFunction;
	onStatusChange: ( status: ConnectionStatus ) => void;
	room: string;
	session: EngineSessionCodec;
	unregister: () => void;
	updateQueue: UpdateQueue;
}

/**
 * Minimal shape of a WordPress REST API error as it arrives on the client
 * via apiFetch. WP_Error is serialized to JSON with a `data.status` field
 * containing the HTTP status code; `code` and `message` are best-effort.
 */
interface WPRestError {
	code?: string;
	message?: string;
	data: { status: number; rooms?: string[]; room?: string };
}

/**
 * Check if an error is a forbidden (403) response from the WordPress REST
 * API. These errors have a `data.status` property set by WP_Error.
 *
 * @param error The caught error to inspect.
 */
function isForbiddenError( error: unknown ): error is WPRestError {
	return ( error as WPRestError | undefined )?.data?.status === 403;
}

/**
 * Check if an error is the sync server's deterministic request-body-size
 * rejection. The server rejects this before the sync handler stores updates, so
 * the client can safely retry the exact same updates in smaller request bodies.
 *
 * @param error The caught error to inspect.
 */
function isRequestBodyTooLargeError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.data?.status === 413 &&
		( error as WPRestError | undefined )?.code ===
			'rest_sync_body_too_large'
	);
}

/**
 * Check if an error is the sync server's protocol mismatch signal. This
 * indicates the client is running an outdated version of the code that is
 * incompatible with the server, and the user should refresh to recover.
 *
 * @param error The caught error to inspect.
 */
function isProtocolMismatchError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.code ===
		'rest_sync_protocol_mismatch'
	);
}

/**
 * Check if an error is the sync server's engine mismatch signal (409). The
 * room is bound to a different sync engine than this client speaks — either
 * the site configuration changed mid-session (stale tab) or the room's
 * storage lineage predates an engine swap. Retrying cannot succeed; the
 * affected room must fall back to the lock posture.
 *
 * @param error The caught error to inspect.
 */
function isEngineMismatchError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.code ===
		'rest_sync_engine_mismatch'
	);
}

/**
 * Handle a 403 from the sync endpoint. Silently unregisters the affected
 * rooms listed in the error data, and restores pending updates for the
 * remaining rooms so they retry on the next poll cycle.
 *
 * If the error does not include room details, it is treated as a generic auth
 * failure and all rooms are unregistered.
 *
 * @param error          The forbidden error, narrowed via isForbiddenError.
 * @param requestedRooms The rooms that were in the failing request.
 */
function handleForbiddenError(
	error: WPRestError,
	requestedRooms: SyncPayload[ 'rooms' ]
): void {
	const requestedRoomNames = new Set(
		requestedRooms.map( ( room ) => room.room )
	);
	const forbiddenRooms = Array.isArray( error.data.rooms )
		? error.data.rooms.filter( ( room ) => requestedRoomNames.has( room ) )
		: [];

	if ( forbiddenRooms.length > 0 ) {
		for ( const room of forbiddenRooms ) {
			const state = roomStates.get( room );
			if ( state ) {
				state.log(
					'Permission denied, unregistering room',
					{ error },
					'error',
					true // force
				);
				unregisterRoom( room, { sendDisconnectSignal: false } );
			}
		}

		// Restore updates for remaining rooms so they can be retried on
		// the next poll cycle.
		for ( const room of requestedRooms ) {
			if ( forbiddenRooms.includes( room.room ) ) {
				continue;
			}
			if ( ! roomStates.has( room.room ) ) {
				continue;
			}
			const remainingState = roomStates.get( room.room )!;
			if ( room.updates.length > 0 ) {
				remainingState.updateQueue.restore( room.updates );
			}
		}
	} else {
		// Generic auth failure (e.g. not logged in) — unregister all rooms.
		const rooms = [ ...roomStates.keys() ];
		for ( const room of rooms ) {
			const state = roomStates.get( room );
			if ( state ) {
				state.log(
					'Permission denied, unregistering room',
					{ error },
					'error',
					true // force
				);
				unregisterRoom( room, { sendDisconnectSignal: false } );
			}
		}
	}
}

/**
 * Handle a 409 engine mismatch from the sync endpoint. The server rejects the
 * whole request on the first mismatched room, naming it in the error data.
 * That room is terminally incompatible — its status is set to disconnected
 * with an ENGINE_MISMATCH error (the lock posture) and it is unregistered
 * without a disconnect signal (the server would 409 that request too).
 * Pending updates for the other rooms in the request are restored so they
 * retry on the next poll cycle.
 *
 * Without a room in the error data (defensively), all requested rooms are
 * treated as mismatched.
 *
 * @param error          The mismatch error, narrowed via isEngineMismatchError.
 * @param requestedRooms The rooms that were in the failing request.
 */
function handleEngineMismatchError(
	error: WPRestError,
	requestedRooms: SyncPayload[ 'rooms' ]
): void {
	const mismatchedRooms =
		'string' === typeof error.data.room
			? [ error.data.room ]
			: requestedRooms.map( ( room ) => room.room );

	for ( const room of mismatchedRooms ) {
		const state = roomStates.get( room );
		if ( ! state ) {
			continue;
		}
		state.log(
			'Sync engine mismatch, unregistering room',
			{ error },
			'error',
			true // force
		);
		state.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.ENGINE_MISMATCH,
				'Sync engine mismatch between client and server'
			),
		} );
		unregisterRoom( room, { sendDisconnectSignal: false } );
	}

	// Restore updates for remaining rooms so they can be retried on the
	// next poll cycle.
	for ( const room of requestedRooms ) {
		if ( mismatchedRooms.includes( room.room ) ) {
			continue;
		}
		if ( ! roomStates.has( room.room ) ) {
			continue;
		}
		const remainingState = roomStates.get( room.room )!;
		if ( room.updates.length > 0 ) {
			remainingState.updateQueue.restore( room.updates );
		}
	}
}

const roomStates: Map< string, RoomState > = new Map();

// Console stub for the sync inspector (wpSync.enable() and friends).
installSyncDebug();

/**
 * Check whether the awareness state exceeds the configured connection limit.
 *
 * @param awareness The awareness state from the server response.
 * @param roomState The room state corresponding to the awareness state
 * @return True if a peer limit has been exceeded.
 */
function checkConnectionLimit(
	awareness: AwarenessState,
	roomState: RoomState
): boolean {
	if ( ! roomState.isPrimaryRoom || hasCheckedConnectionLimit ) {
		return false;
	}

	// Limits are only enforced on the initial connection.
	hasCheckedConnectionLimit = true;

	const maxClientsPerRoom = applyFilters(
		'sync.pollingProvider.maxClientsPerRoom',
		DEFAULT_CLIENT_LIMIT_PER_ROOM,
		roomState.room
	);

	const clientCount = Object.keys( awareness ).length;
	const validatedLimit = intValueOrDefault(
		maxClientsPerRoom,
		DEFAULT_CLIENT_LIMIT_PER_ROOM
	);

	if ( clientCount > validatedLimit ) {
		roomState.log( 'Connection limit exceeded', {
			clientCount,
			maxClientsPerRoom: validatedLimit,
			room: roomState.room,
		} );

		return true;
	}

	return false;
}

let areListenersRegistered = false;
let consecutiveFailures = 0;
let hasCheckedConnectionLimit = false;
let isManualRetry = false;
let hasCollaborators = false;
let isActiveBrowser = 'visible' === document.visibilityState;
let isPolling = false;
let isUnloadPending = false;
let pollInterval = POLLING_INTERVAL_IN_MS;
let pollingTimeoutId: ReturnType< typeof setTimeout > | null = null;
/*
 * Set when a room restarted under us during this poll: the next poll must
 * follow at once (cursor 0) instead of waiting out the interval.
 */
let repollImmediately = false;
let syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;

/*
 * THE CADENCE RULES (docs/plan/advisory-channel.md).
 *
 * Short polling is the base transport everyone has. What changes is WHEN
 * the loop polls:
 *
 * - Alone (the signaling lane says nobody else is in this post's room):
 *   no timer once the first poll has bootstrapped the session (except a
 *   30 s discovery window after load and after regaining focus), and the
 *   room queues are HELD — local edits wait in the
 *   browser until company arrives, a save (flush-before-save), or the
 *   tab going hidden. Codecs that declare `sendsWhileAlone` (de-rtc) are
 *   exempt. Company (a heartbeat or poll answer, or an awareness map
 *   with more than one client) releases the queues and the cadence.
 * - Company, but some known peer is NOT reachable over the advisory
 *   channel: today's timer cadence (the configured interval).
 * - Company, every known peer reachable over the channel: no timer at
 *   all. Polls happen on demand — after a queued local update, after a
 *   peer announces new rows, and when a heartbeat answer reports the
 *   room's head cursor ahead of this tab's (rows from writers not on
 *   the channel: scripts, WP-CLI, a dropped peer). The heartbeat slows
 *   to 120 s on blur, so a backgrounded tab notices such a write late;
 *   accepted, nobody is looking.
 * - No signaling lane on this page (a screen with no per-post room, or
 *   the channel disabled site-wide): the always-on cadence, unchanged.
 *
 * SSE keeps its own re-issue cadence (the next exchange right behind
 * each stream event) and turns the channel off while its stream is up;
 * the alone rule still applies to it (a held stream for a lone editor
 * pins a PHP worker for nothing).
 */
let hasBootstrapped = false;
let pollAgainRequested = false;
let hiddenFlushTimer: ReturnType< typeof setTimeout > | null = null;
/*
 * A lone tab has no timer, so it would notice a joiner on its next
 * heartbeat (10 s) at best. For a while after the page loads and
 * after the tab regains focus — the moments a second person most often
 * turns up — it polls at the solo cadence instead (4 s by default).
 */
let fastDiscoveryUntil = 0;
/*
 * Requests that could carry updates (a poll off the stream, or a send on
 * the send lane), started and finished: what a flush waits for. A stream
 * receive never carries updates and is not counted.
 */
let sendsStarted = 0;
let sendsFinished = 0;
/** Flush waiters: resolve once request number `target` has finished. */
const sendDoneResolvers: Array< { target: number; resolve: () => void } > = [];
let localUpdatePollTimer: ReturnType< typeof setTimeout > | null = null;
let announcePollTimer: ReturnType< typeof setTimeout > | null = null;
let lastAnnouncePollAt = 0;
let advisoryHooksInstalled = false;

function hasQueuedUpdates(): boolean {
	for ( const state of roomStates.values() ) {
		if ( state.updateQueue.peek().length > 0 ) {
			return true;
		}
	}
	return false;
}

/**
 * Never let a slow (or absent) timer sit on queued local work: a safety
 * or background delay, or no timer at all, is cut down to the on-demand
 * send delay (the normal timer cadences send soon enough). The cadence
 * rules decide how often to LOOK for rows; queued rows go out promptly
 * regardless (found by a coverage flip that replaced a pending 1 s timer
 * with the 25 s safety timer while an undo's inverse intents were queued).
 *
 * @param delay The delay the cadence rules chose.
 */
function boundedByQueuedWork( delay: number | null ): number | null {
	if (
		hasQueuedUpdates() &&
		( null === delay || delay >= POLLING_INTERVAL_BACKGROUND_TAB_IN_MS )
	) {
		return LOCAL_UPDATE_POLL_DELAY_MS;
	}
	return delay;
}

function isAlone(): boolean {
	return isSignalingAvailable() && ! hasCollaborators && ! othersPresent();
}

/**
 * Pauses the holdable queues while alone, resumes them with company.
 */
function applyHolds(): void {
	// A pending flush has released the queues for the poll that will carry
	// them; a poll finishing meanwhile must not pause them again.
	const alone = isAlone() && 0 === sendDoneResolvers.length;
	roomStates.forEach( ( state ) => {
		if ( alone && state.holdWhileAlone ) {
			state.updateQueue.pause();
		} else {
			state.updateQueue.resume();
		}
	} );
}

function hasHeldUpdates(): boolean {
	for ( const state of roomStates.values() ) {
		if ( state.updateQueue.size() > 0 ) {
			return true;
		}
	}
	return false;
}

/**
 * Releases the held queues, sends, and resolves once that request has
 * returned (or failed); the holds are then re-applied for a tab still
 * alone. Used before a save and when the tab goes hidden.
 */
export function flushHeldUpdates(): Promise< void > {
	if ( 0 === roomStates.size || ! hasHeldUpdates() ) {
		return Promise.resolve();
	}
	roomStates.forEach( ( state ) => state.updateQueue.resume() );
	return new Promise< void >( ( resolve ) => {
		/*
		 * Wait for a request that STARTS after this call: a request
		 * already in flight was built before the queues were released,
		 * so its successor is the one that carries the held work.
		 * Re-applying the holds any earlier would pause the queues
		 * before that successor takes from them. On the stream the
		 * successor is a send; off it, the next poll.
		 */
		sendDoneResolvers.push( {
			target: sendsStarted + 1,
			resolve: () => {
				applyHolds();
				resolve();
			},
		} );
		if ( streamReceiving() ) {
			scheduleSend();
		} else {
			pollNow();
		}
	} );
}

function cancelHiddenFlush(): void {
	if ( hiddenFlushTimer ) {
		clearTimeout( hiddenFlushTimer );
		hiddenFlushTimer = null;
	}
}

function hasCompany(): boolean {
	return hasCollaborators || othersPresent();
}

/**
 * Whether every peer this tab knows about is reachable over the advisory
 * channel: the discovered tokens, and the client ids the primary room's
 * last awareness map carried.
 */
function advisoryCoversEveryone(): boolean {
	const clientIds: number[] = [];
	roomStates.forEach( ( state ) => {
		if ( state.isPrimaryRoom ) {
			for ( const id of Object.keys( state.lastServerAwareness ) ) {
				clientIds.push( Number( id ) );
			}
		}
	} );
	return advisoryCoversClients( clientIds );
}

/**
 * The delay before the next scheduled poll after a successful one, or null
 * for "do not schedule" (quiet while alone).
 */
function nextScheduledDelay(): number | null {
	if ( hasBootstrapped && isAlone() ) {
		// Alone: the discovery window, then quiet. Under SSE quiet means no
		// held stream either (scheduleNext closes it); the heartbeat's
		// company report reopens it, as it restarts any HTTP transport.
		if ( Date.now() >= fastDiscoveryUntil ) {
			return null;
		}
		return sseStreaming() ? sseDelay() : POLLING_INTERVAL_IN_MS;
	}
	if ( sseStreaming() ) {
		return sseDelay();
	}
	// Short polling proper, including SSE while no stream can be opened:
	// receiving then runs on the base transport, with its cadence rules
	// and its advisory channel (switched back on by the failed exchange).
	// A hidden SSE tab lands here too, with the channel still off (no
	// mesh to rebuild on every tab switch), so it takes the background
	// cadence below.
	if ( advisoryCoversEveryone() ) {
		return null;
	}
	if ( ! isActiveBrowser ) {
		return POLLING_INTERVAL_BACKGROUND_TAB_IN_MS;
	}
	if ( hasCompany() ) {
		return POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS;
	}
	return POLLING_INTERVAL_IN_MS;
}

/**
 * Schedules the next poll, or leaves the loop stopped when the cadence
 * rules say so. `isPolling` stays true only while a poll is scheduled or
 * in flight, so a stopped loop can be restarted by any wake path.
 *
 * @param delay Milliseconds until the next poll, or null to stop.
 */
function scheduleNext( delay: number | null ): void {
	if ( pollAgainRequested ) {
		// A wake arrived while the last request was in flight.
		pollAgainRequested = false;
		pollingTimeoutId = setTimeout( poll, 0 );
		return;
	}
	if ( null === delay ) {
		isPolling = false;
		pollingTimeoutId = null;
		if ( sseMode ) {
			// A quiet loop holds no PHP worker: drop the receive stream.
			sseExchange.close();
		}
		return;
	}
	pollingTimeoutId = setTimeout( poll, delay );
}

/**
 * Polls now: a stopped loop restarts, a scheduled poll is brought forward,
 * an in-flight poll is followed by another as soon as it returns.
 */
function pollNow(): void {
	if ( 0 === roomStates.size ) {
		return;
	}
	if ( pollingTimeoutId ) {
		clearTimeout( pollingTimeoutId );
		pollingTimeoutId = null;
		poll();
		return;
	}
	if ( ! isPolling ) {
		poll();
		return;
	}
	pollAgainRequested = true;
}

/**
 * Re-evaluates a pending timer against the cadence rules (a peer joined
 * or left the channel, company arrived). A stopped loop restarts only
 * when there is company; an in-flight poll reschedules itself when it
 * returns.
 */
function reschedule(): void {
	if ( 0 === roomStates.size ) {
		return;
	}
	if ( pollingTimeoutId ) {
		clearTimeout( pollingTimeoutId );
		pollingTimeoutId = null;
		const delay = boundedByQueuedWork( nextScheduledDelay() );
		if ( null === delay ) {
			isPolling = false;
			if ( sseMode ) {
				sseExchange.close();
			}
			return;
		}
		pollingTimeoutId = setTimeout( poll, delay );
		return;
	}
	if ( ! isPolling && hasCompany() ) {
		poll();
	}
}

/**
 * Local work is waiting (a queued update): send it on demand when no
 * timer will pick it up soon. On the stream that is the send lane, at
 * once, beside the stream (which stays open). Off it, that is when the
 * loop is quiet (alone), a request is in flight with nothing scheduled
 * behind it (alone, mid-poll), or the pending timer is the slow safety
 * cadence (every peer on the channel). A scheduled timer at the normal
 * cadence needs no help. A stream still parked while the loop is off
 * the stream (the exchange just became unwilling) is woken so the work
 * does not wait for its next event.
 *
 * @param held Whether the work sits in a held queue (alone, holdable
 *             codec), which waits for company or a flush instead.
 */
function wakeForLocalWork( held = false ): void {
	if ( held ) {
		return;
	}
	if ( streamReceiving() ) {
		scheduleSend();
		return;
	}
	const needsWake = sseMode
		? ! isPolling
		: ! pollingTimeoutId || isAlone() || advisoryCoversEveryone();
	if ( needsWake ) {
		pollSoonForLocalUpdate();
	}
	abortParkedStream();
}

/**
 * Drops a parked stream exchange on purpose (the tab went hidden, the
 * room set changed, the page is going away): the exchange sees a
 * deliberate abort, not a failure, and the loop re-polls at once. Under
 * short polling nothing is ever parked.
 */
function abortParkedStream(): void {
	if ( ! sseMode || ! inFlightParkController ) {
		return;
	}
	parkAbortedOnPurpose = true;
	const controller = inFlightParkController;
	inFlightParkController = null;
	controller.abort();
}

/**
 * Slow awareness named a new block on the local awareness state. Under
 * short polling the advisory channel's presence lane carries the field
 * to reachable peers, and the timer polls carry it to the rest, so
 * nothing needs to happen here. Under SSE the channel is off and the
 * value rides the send lane: send it now, beside the stream.
 */
function onLocalAwarenessChanged(): void {
	if ( streamReceiving() ) {
		scheduleSend();
		return;
	}
	abortParkedStream();
}

/**
 * A local update was queued while the loop is quiet or on the slow safety
 * cadence: poll shortly. The delay lets the rest of a burst pile in; it is
 * NOT reset by later updates, so a long burst cannot starve the send.
 */
function pollSoonForLocalUpdate(): void {
	if ( localUpdatePollTimer ) {
		return;
	}
	localUpdatePollTimer = setTimeout( () => {
		localUpdatePollTimer = null;
		pollNow();
	}, LOCAL_UPDATE_POLL_DELAY_MS );
}

/**
 * A peer announced new rows over the advisory channel: poll, coalescing a
 * burst of announcements into one request and never faster than the floor.
 */
function pollSoonForAnnounce(): void {
	if ( announcePollTimer ) {
		return;
	}
	const sinceLast = Date.now() - lastAnnouncePollAt;
	const delay = Math.max(
		ANNOUNCE_POLL_COALESCE_MS,
		ANNOUNCE_POLL_MIN_GAP_MS - sinceLast
	);
	announcePollTimer = setTimeout( () => {
		announcePollTimer = null;
		lastAnnouncePollAt = Date.now();
		pollNow();
	}, delay );
}

/**
 * The awareness map to hand a session: the poll response's copy with the
 * fresher channel copy overlaid for peers on the channel (a 25-second-old
 * server cursor must not jump a live cursor back).
 *
 * @param state The room.
 */
function mergedAwareness( state: RoomState ): AwarenessState {
	const merged: AwarenessState = { ...state.lastServerAwareness };
	const channel = getChannelPresence( state.room ) as AwarenessState;
	for ( const clientId of Object.keys( channel ) ) {
		const base = channel[ clientId ];
		const server = merged[ clientId ];
		merged[ clientId ] =
			base && 'object' === typeof base
				? {
						...( server && 'object' === typeof server
							? server
							: {} ),
						...base,
				  }
				: server ?? base;
	}
	return merged;
}

const BASE_PRESENCE_FIELDS = [
	'collaboratorInfo',
	'name',
	'isActive',
	BLOCK_FIELD,
];

/**
 * The part of an awareness state that says WHO this is and, under slow
 * awareness, WHICH BLOCK they are in (not where their cursor is): the
 * fields the channel carries.
 *
 * @param state The local awareness state.
 */
function basePresence( state: unknown ): unknown {
	if ( ! state || 'object' !== typeof state ) {
		return state;
	}
	const picked: Record< string, unknown > = {};
	for ( const field of BASE_PRESENCE_FIELDS ) {
		if ( field in ( state as Record< string, unknown > ) ) {
			picked[ field ] = ( state as Record< string, unknown > )[ field ];
		}
	}
	return picked;
}

function installAdvisoryHooks(): void {
	if ( advisoryHooksInstalled ) {
		return;
	}
	advisoryHooksInstalled = true;
	installSignaling();
	installSignalingLifecycle();
	onOthersChanged( ( others ) => {
		applyHolds();
		if ( others ) {
			pollNow();
			if ( streamReceiving() && hasQueuedUpdates() ) {
				// Company released the held queues: on the stream the
				// send lane carries them, not the next event.
				scheduleSend();
			}
		} else {
			reschedule();
		}
	} );
	// An active loop carries queued handshake messages on its next poll;
	// a quiet one leaves them to the heartbeat. So does an SSE loop: its
	// exchanges send no probe (an open stream carries no request at all,
	// so a probe could be dropped unanswered), which matters when SSE is
	// down and the channel is back on as the fallback.
	setSignalCarrier( () => {
		if ( isPolling && ! sseMode ) {
			pollNow();
			return true;
		}
		return false;
	} );
	registerSaveFlush( flushHeldUpdates );
	onAdvisoryCoverageChanged( reschedule );
	onAdvisoryAnnounce( pollSoonForAnnounce );
	onRoomCursor( ( cursor ) => {
		// Rows landed that no nudge announced (a writer off the channel):
		// the primary room's cursor is behind the head the beat reported.
		roomStates.forEach( ( state ) => {
			if ( state.isPrimaryRoom && cursor > state.endCursor ) {
				pollSoonForAnnounce();
			}
		} );
	} );
	onRoomEngine( ( engine ) => {
		// The site's engine changed under this session: poll so the
		// server's 409 fence drops the room into the lock posture.
		roomStates.forEach( ( state ) => {
			if (
				state.isPrimaryRoom &&
				state.session.engineSlug &&
				engine !== state.session.engineSlug
			) {
				pollNow();
			}
		} );
	} );
	onAdvisoryPresence( ( room ) => {
		const state = roomStates.get( room );
		if ( state ) {
			state.session.applyRemoteAwareness( mergedAwareness( state ) );
		}
	} );
	// Only BASE presence rides the channel (who is here: user info, name,
	// activity, and the slow-awareness block name, which names a block
	// the receiver may not hold yet and then shows nothing until it
	// does). Cursors and selections stay on the polls by decision: over
	// the channel they would point at content positions the receiver
	// has not polled for yet.
	setPresenceSource( () =>
		Array.from( roomStates.values() ).map( ( state ) => ( {
			room: state.room,
			clientId: state.session.clientId,
			state: basePresence( state.session.getLocalAwareness() ),
		} ) )
	);
}

/*
 * SSE mode: receiving rides one long-lived stream response per tab (the
 * SseExchange), each exchange returning the next stream event, so on a
 * successful exchange the client re-issues almost immediately rather than
 * waiting out a fixed interval. Sends go through the updates request
 * BESIDE the stream, which stays open across them (see the send lane,
 * sendNow). Failure backoff is unchanged. After a failed stream the
 * exchange refuses to open one for a while (growing with each failure in
 * a row); receiving then runs on short polling under ITS cadence rules —
 * the collaborator interval, quiet under channel coverage, the background
 * cadence — until the exchange is willing again, when the next receive
 * reopens a stream. Set once by the SSE provider (a single site-wide
 * transport). See providers/sse.
 */
let sseMode = false;
const sseExchange = new SseExchange();

/*
 * After a room registers, the tab receives over ordinary requests for a
 * moment instead of opening a stream. The editor registers its rooms one
 * by one at load and its presence fills in right after, and each of those
 * would otherwise close and reopen the stream (two or three throwaway
 * streams per tab, each costing the server a worker, a subscription, and
 * a full read). Once the room set has been still for this long, one
 * stream opens with all of it; the bootstrap reads ride the requests.
 */
const SSE_SETTLE_MS = 1000;
let sseSettleUntil = 0;

/**
 * Whether receiving is on the stream (or about to be, once the room set
 * settles): SSE is selected, the tab is visible, and the exchange is
 * willing to open one. When it is not, receiving is short polling: after
 * a failed stream (the exchange refuses to open one for a while), and
 * while the tab is hidden — a stream holds a PHP worker for its whole
 * length, renewed for as long as the tab lives, and nobody is looking at
 * a hidden tab, so it polls at the background cadence like short polling
 * and the stream reopens the moment the tab is visible again
 * (handleVisibilityChange polls at once).
 */
function sseStreaming(): boolean {
	return sseMode && isActiveBrowser && sseExchange.available;
}

/**
 * Whether the next pure receive should open (or read from) the stream.
 */
function sseStreamReady(): boolean {
	return sseStreaming() && Date.now() >= sseSettleUntil;
}

/**
 * The delay before the next exchange while streaming: right behind each
 * stream event, or the rest of the settling window.
 */
function sseDelay(): number {
	return Math.max( STREAM_REISSUE_MS, sseSettleUntil - Date.now() );
}

/**
 * Select SSE receiving with ordinary REST sends.
 *
 * @param enabled Whether SSE is selected.
 */
export function setSseMode( enabled: boolean ): void {
	if ( sseMode !== enabled ) {
		sseExchange.close();
	}
	sseMode = enabled;
}

/*
 * A parked stream exchange in flight (a pure receive, waiting for the next
 * stream event). Local work never waits for that event: it goes out on
 * the send lane beside the stream. The park is aborted only on purpose —
 * the tab went hidden, the room set changed, the page is going away —
 * and the loop then re-polls at once without recording a failure.
 */
let inFlightParkController: AbortController | null = null;
let parkAbortedOnPurpose = false;

// Small delay between a delivered stream event and the next exchange, to
// yield to the event loop without idling.
const STREAM_REISSUE_MS = 50;

// How long a tab going hidden waits before flushing held work (pagehide,
// which follows a hide on reload/close, cancels it).
const HIDDEN_FLUSH_DELAY_MS = 1500;

// When more rooms are registered than the server allows per request
// (MAX_ROOMS_PER_REQUEST), the primary room is sent every poll and the
// remaining "overflow" rooms are rotated across polls. This offset
// points into the overflow list at the next room to include.
let roomOverflowOffset = 0;

/**
 * Mark that a page unload has been requested. This fires on
 * `beforeunload` which happens before the browser aborts in-flight
 * fetches, allowing us to distinguish poll failures caused by
 * navigation from genuine server errors in the catch block.
 *
 * If the user cancels the unload (e.g. by dismissing a "Save Changes?" dialog),
 * the flag is reset at the start of the next poll cycle so that polling can
 * resume.
 */
function handleBeforeUnload(): void {
	isUnloadPending = true;
}

/**
 * Send a disconnect signal for all registered rooms when the page is
 * being unloaded. Uses `sendBeacon` so the request survives navigation.
 */
function handlePageHide(): void {
	cancelHiddenFlush();
	if ( sseMode ) {
		// Drop the stream on purpose: through the park signal, so the
		// exchange in flight sees a deliberate abort (no failure backoff,
		// no "will retry" error logged as the page goes away).
		abortParkedStream();
		sseExchange.close();
	}
	const rooms = Array.from( roomStates.entries() ).map(
		( [ room, state ] ) => ( {
			after: 0,
			awareness: null,
			client_id: state.session.clientId,
			room,
			updates: [],
		} )
	);

	for ( let i = 0; i < rooms.length; i += MAX_ROOMS_PER_REQUEST ) {
		postSyncUpdateNonBlocking( {
			rooms: rooms.slice( i, i + MAX_ROOMS_PER_REQUEST ),
		} );
	}
}

/**
 * Hangle change in visibility state of browser tab.
 *
 * Used to trigger a slow down of the collaboration syncs when the
 * browser tab becomes inactive (either the user switches tabs or the
 * screen saver comes on).
 *
 * Fires on the document's visibilitychange event.
 */
function handleVisibilityChange() {
	const wasActive = isActiveBrowser;
	isActiveBrowser = document.visibilityState === 'visible';

	if ( ! isActiveBrowser ) {
		if ( sseMode ) {
			/*
			 * A hidden tab holds no stream (sseStreaming). Drop it the
			 * way pagehide does: through the park signal, so the exchange
			 * in flight sees a deliberate abort (no failure backoff, no
			 * "will retry" error logged) and the loop goes on over
			 * ordinary requests at the background cadence (sseDelay).
			 */
			abortParkedStream();
			sseExchange.close();
		}
		/*
		 * Going hidden while alone with held work: a hidden tab's heartbeat
		 * slows to two minutes, too slow to answer a joiner, so put the
		 * held work in the room once. Hiding is also the first thing a
		 * reload or close does (visibilitychange precedes pagehide), so
		 * the flush waits a beat and pagehide cancels it.
		 */
		cancelHiddenFlush();
		if ( isAlone() && hasHeldUpdates() ) {
			hiddenFlushTimer = setTimeout( () => {
				hiddenFlushTimer = null;
				void flushHeldUpdates();
			}, HIDDEN_FLUSH_DELAY_MS );
		}
		return;
	}
	cancelHiddenFlush();

	if ( isActiveBrowser && ! wasActive ) {
		fastDiscoveryUntil = Date.now() + FAST_DISCOVERY_WINDOW_MS;
		/*
		 * Remove scheduled polling and repoll immediately when reactivated.
		 *
		 * This ensures that any updates by collaborators are immediately
		 * reflected in the document once the browser tab becomes active.
		 * Otherwise there would be a delay of up to 30 seconds before the
		 * updates came through.
		 *
		 * Only repoll if we cleared a pending timeout, meaning the poll loop
		 * was idle between cycles. If no timeout is pending, a poll request
		 * is already in-flight and will pick up the updated isActiveBrowser
		 * value when it schedules the next cycle.
		 */
		if ( pollingTimeoutId ) {
			clearTimeout( pollingTimeoutId );
			pollingTimeoutId = null;
			poll();
		} else if ( ! isPolling && 0 < roomStates.size ) {
			// A stopped loop: poll once now (company may have arrived while
			// hidden, and the discovery window just reopened).
			poll();
		}
	}
}

/**
 * Select which rooms to include in the next sync request.
 *
 * The server caps requests at MAX_ROOMS_PER_REQUEST rooms. When fewer rooms are
 * registered than the cap, every room is included on every poll. When the cap
 * is exceeded, the primary room is sent on every poll (so the main document
 * stays fully synced) and the remaining overflow rooms are rotated across
 * successive polls so each one is included (at a reduced frequency).
 *
 * Rooms that are skipped on a given poll keep their queued updates; the updates
 * are drained on the next poll that includes them.
 *
 * @return The RoomStates to include in this request, in send order.
 */
function selectRoomsForRequest(): RoomState[] {
	const allRooms = Array.from( roomStates.values() );

	// Fast path: everything fits in a single request.
	if ( allRooms.length <= MAX_ROOMS_PER_REQUEST ) {
		return allRooms;
	}

	// Rotation path: pin the primary room to every request (if one exists)
	// and rotate the remaining overflow rooms across successive polls.
	const primaryRoom = allRooms.find( ( state ) => state.isPrimaryRoom );
	const overflowRooms = allRooms.filter( ( state ) => state !== primaryRoom );
	const overflowSlotsPerRequest =
		MAX_ROOMS_PER_REQUEST - ( primaryRoom ? 1 : 0 );

	const { window: overflowSlice, nextOffset } = rotateWindow(
		overflowRooms,
		roomOverflowOffset,
		overflowSlotsPerRequest
	);
	roomOverflowOffset = nextOffset;

	if ( primaryRoom ) {
		return [ primaryRoom, ...overflowSlice ];
	}

	return overflowSlice;
}

const textEncoder = new TextEncoder();

function getJsonByteLength( value: unknown ): number {
	return textEncoder.encode( JSON.stringify( value ) ).byteLength;
}

function createPayloadRoom(
	state: RoomState,
	updates: SyncUpdate[] = []
): SyncPayload[ 'rooms' ][ number ] {
	return {
		after: state.endCursor ?? 0,
		awareness: state.session.getLocalAwareness(),
		client_id: state.session.clientId,
		...( state.session.engineSlug
			? {
					engine: state.session.engineSlug,
					engine_protocol: state.session.engineProtocol,
			  }
			: {} ),
		// This tab's presence token, on its post's room only: the first
		// request carrying it is the tab's join (docs/plan/room-lifetime.md).
		...( getPresenceRoom() === state.room && getPresenceToken()
			? { presence_token: getPresenceToken()! }
			: {} ),
		// The inspector's server-envelope opt-in (see debug/inspector.ts).
		...( isSyncDebugEnabled() ? { debug: true } : {} ),
		room: state.room,
		updates,
	};
}

function getUpdatePayloadSizeDelta(
	existingUpdateCount: number,
	update: SyncUpdate
): number {
	const commaSize = existingUpdateCount === 0 ? 0 : 1;
	return commaSize + getJsonByteLength( update );
}

/**
 * Builds the request for the given rooms, packing queued updates into it
 * under the body-size limit.
 *
 * @param selectedRoomStates The rooms, in send order.
 * @param takeUpdates        Whether to take queued updates out of the
 *                           room queues into the request. A stream
 *                           receive never carries updates (the send lane
 *                           owns them), nor does a poll while a send is
 *                           in flight.
 */
function buildPayloadForRequest(
	selectedRoomStates: RoomState[],
	takeUpdates = true
): {
	payload: SyncPayload;
	roomsInRequest: RoomState[];
} {
	const payload: SyncPayload = { rooms: [] };
	const roomsInRequest: RoomState[] = [];
	const probe = ! sseMode && isSignalingAvailable() ? buildProbe() : null;
	if ( probe ) {
		payload.advisory = probe;
	}

	for ( const state of selectedRoomStates ) {
		const room = createPayloadRoom( state );
		const candidate = { rooms: [ ...payload.rooms, room ] };
		if (
			payload.rooms.length > 0 &&
			getJsonByteLength( candidate ) > syncRequestBodySizeLimit
		) {
			break;
		}

		payload.rooms.push( room );
		roomsInRequest.push( state );
	}

	if ( ! takeUpdates ) {
		return { payload, roomsInRequest };
	}

	const pendingUpdates = roomsInRequest.map( ( state ) =>
		state.updateQueue.peek()
	);
	const sentUpdateCounts = roomsInRequest.map( () => 0 );

	let payloadSize = getJsonByteLength( payload );
	let addedUpdate = true;

	while ( addedUpdate ) {
		addedUpdate = false;

		for ( let i = 0; i < roomsInRequest.length; i++ ) {
			const update = pendingUpdates[ i ][ sentUpdateCounts[ i ] ];

			if ( ! update ) {
				continue;
			}

			const sizeDelta = getUpdatePayloadSizeDelta(
				sentUpdateCounts[ i ],
				update
			);
			if ( payloadSize + sizeDelta > syncRequestBodySizeLimit ) {
				continue;
			}

			sentUpdateCounts[ i ]++;
			payloadSize += sizeDelta;
			addedUpdate = true;
		}
	}

	for ( let i = 0; i < roomsInRequest.length; i++ ) {
		payload.rooms[ i ].updates = roomsInRequest[ i ].updateQueue.take(
			sentUpdateCounts[ i ]
		);
	}

	return { payload, roomsInRequest };
}

function restoreExactUpdates( payload: SyncPayload ): void {
	for ( const room of payload.rooms ) {
		if ( ! roomStates.has( room.room ) || room.updates.length === 0 ) {
			continue;
		}

		roomStates.get( room.room )!.updateQueue.restoreExact( room.updates );
	}
}

/**
 * Which lane a response came from. A RECEIVE (a poll, or a stream event)
 * delivers stored rows and moves the room's cursor. A SEND (the updates
 * request marked `rows_received_separately: true`, issued beside an open stream) carries
 * no stored rows: its verdicts and any never-stored rows are HELD until
 * the stream has moved the cursor to the head the server saw at that
 * write, then applied in the usual order. See sendNow.
 */
type ResponseLane = 'receive' | 'send';

/**
 * Applies one room's rows, then its dispositions, then a compaction
 * request, in that order. Rows already settle the pending state they
 * supersede, so the ack covers only outcomes without a row and the
 * session's state never regresses mid-response.
 *
 * @param state         The room.
 * @param updates       The rows to apply.
 * @param dispositions  The server's verdicts on rows this client sent.
 * @param shouldCompact Whether the server nominated this client to compact.
 */
function applyRoomRows(
	state: RoomState,
	updates: SyncUpdate[],
	dispositions: EngineDisposition[] | undefined,
	shouldCompact: boolean | undefined
): void {
	// Process each incoming update and collect any responses.
	const responseUpdates: SyncUpdate[] = [];
	for ( const update of updates ) {
		try {
			const response = state.session.receiveUpdate( update );
			if ( response ) {
				responseUpdates.push( response );
			}
		} catch ( error ) {
			state.log(
				'Failed to apply sync update',
				{ error, update },
				'error',
				true // force
			);
		}
	}

	state.updateQueue.addBulk( responseUpdates );

	/*
	 * Deliver per-update dispositions (the server's ack for the batch
	 * this client sent) AFTER the updates above: rows already settle the
	 * pending state they supersede, so the ack covers only outcomes
	 * without a row and the session's state never regresses mid-response.
	 */
	if ( dispositions && state.session.receiveDispositions ) {
		try {
			state.session.receiveDispositions( dispositions );
		} catch ( error ) {
			state.log(
				'Failed to apply dispositions',
				{ error },
				'error',
				true // force
			);
		}
	}

	// Respond to compaction requests from server. The server asks only one
	// client at a time to compact (lowest active client ID). We encode our
	// full document state to replace all prior updates on the server.
	// (No current engine nominates a client — they all compact
	// server-side — so codecs without the optional method are
	// simply never asked, and a request to one is ignored.)
	if ( shouldCompact ) {
		state.log( 'Server requested compaction update' );
		try {
			// Create BEFORE clearing: a failed creation must not
			// destroy the queued updates for nothing.
			const compactionUpdate = state.session.createCompactionUpdate?.();
			if ( compactionUpdate ) {
				state.updateQueue.clear();
				state.updateQueue.add( compactionUpdate );
			}
		} catch ( error ) {
			state.log(
				'Failed to create compaction update',
				{ error },
				'error',
				true // force
			);
		}
	}
}

/**
 * Applies the tails the send lane left behind, oldest first, as far as
 * the room's cursor has come: a tail waits until the receive lane has
 * delivered every stored row up to the head its write saw.
 *
 * @param state The room.
 */
function drainHeldTails( state: RoomState ): void {
	while (
		state.heldTails.length > 0 &&
		state.heldTails[ 0 ].endCursor <= state.endCursor
	) {
		const tail = state.heldTails.shift()!;
		applyRoomRows(
			state,
			tail.updates,
			tail.dispositions,
			tail.shouldCompact
		);
	}
}

function hasHeldTails(): boolean {
	for ( const state of roomStates.values() ) {
		if ( state.heldTails.length > 0 ) {
			return true;
		}
	}
	return false;
}

/**
 * Applies one room's response envelope.
 *
 * @param state       The room.
 * @param room        Its envelope in the response.
 * @param lane        Which lane the response came from.
 * @param sentUpdates How many updates the request carried for this room.
 */
function applyRoomResponse(
	state: RoomState,
	room: SyncResponse[ 'rooms' ][ number ],
	lane: ResponseLane,
	sentUpdates: number
): void {
	if ( 'receive' === lane ) {
		/*
		 * Room generation: the server restarted this room (reset to
		 * a fresh genesis from the saved post) if the token differs
		 * from the one we bootstrapped under. Nothing else in this
		 * response is ours to apply — its rows belong to the new
		 * room and are re-fetched from cursor 0 by the immediate
		 * re-poll (or the room is dropped, per the session).
		 */
		if ( 'string' === typeof room.generation ) {
			if ( undefined === state.generation ) {
				state.generation = room.generation;
			} else if ( state.generation !== room.generation ) {
				restartRoom( state, room.generation, room.updates );
				return;
			}
		}

		if ( room.end_cursor < state.endCursor ) {
			// The room went back (a reset with no genesis yet reports
			// cursor 0 and no token): tails waiting for the old head
			// could never drain.
			state.heldTails.length = 0;
		}
		state.endCursor = room.end_cursor;

		// If a limit is exceeded, disconnect immediately without processing updates.
		if ( checkConnectionLimit( room.awareness, state ) ) {
			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.CONNECTION_LIMIT_EXCEEDED,
					'Connection limit exceeded'
				),
			} );
			unregisterRoom( room.room );
			return;
		}
	}

	// Process awareness update: the server's copy, with the
	// fresher channel copy overlaid for peers on the channel.
	state.lastServerAwareness = room.awareness ?? {};
	state.session.applyRemoteAwareness( mergedAwareness( state ) );

	// Another collaborator on the primary entity means company:
	// the loop keeps its timer cadence (or the safety cadence
	// under full channel coverage). Only the primary room is
	// checked to avoid false positives from shared collection
	// rooms (e.g. taxonomy/category).
	if ( state.isPrimaryRoom && Object.keys( room.awareness ).length > 1 ) {
		hasCollaborators = true;
	}

	// Rows this tab just landed: tell the peers on the channel
	// to poll. A rumor only — the poll is what delivers them.
	if ( sentUpdates ) {
		announceLocalWrite( room.room );
	}

	if ( 'send' === lane ) {
		/*
		 * A send's answer carries no stored rows, and the cursor is the
		 * receive lane's to move. Hold what it does carry (verdicts, a
		 * never-stored row an engine synthesized for us) until the
		 * stream has delivered the head this write saw; its own notice
		 * wakes the stream, so that is one round trip. An answer from a
		 * room the server restarted meanwhile belongs to the old room:
		 * the receive lane restarts the session, which re-derives its
		 * pending work.
		 */
		if (
			'string' === typeof room.generation &&
			undefined !== state.generation &&
			state.generation !== room.generation
		) {
			return;
		}
		if (
			room.updates.length > 0 ||
			( room.dispositions && room.dispositions.length > 0 ) ||
			room.should_compact
		) {
			state.heldTails.push( {
				endCursor: room.end_cursor,
				updates: room.updates,
				dispositions: room.dispositions,
				shouldCompact: room.should_compact,
			} );
		}
	} else {
		applyRoomRows(
			state,
			room.updates,
			room.dispositions,
			room.should_compact
		);
	}

	drainHeldTails( state );
}

/**
 * Applies a whole response: every room still registered, in order, with
 * the inspector's wire tap.
 *
 * @param rooms     The response envelopes.
 * @param payload   The request they answer.
 * @param lane      Which lane the response came from.
 * @param startedAt When the request started (for the inspector).
 */
function applyResponseRooms(
	rooms: SyncResponse[ 'rooms' ],
	payload: SyncPayload,
	lane: ResponseLane,
	startedAt: number
): void {
	// Reset before checking each room
	hasCollaborators = false;

	rooms.forEach( ( room ) => {
		const state = roomStates.get( room.room );
		if ( ! state ) {
			return;
		}

		const requested = payload.rooms.find(
			( sent ) => sent.room === room.room
		);

		// The inspector's wire tap: decoded traffic, both ways.
		if ( isSyncDebugEnabled() ) {
			recordPoll( {
				room: room.room,
				sent: requested?.updates ?? [],
				received: room.updates,
				dispositions: room.dispositions as
					| Array< Record< string, unknown > >
					| undefined,
				cursorBefore: requested?.after,
				cursorAfter: room.end_cursor,
				durationMs: Date.now() - startedAt,
				serverDebug: (
					room as {
						_debug?: Record< string, unknown >;
					}
				 )._debug,
			} );
		}

		applyRoomResponse( state, room, lane, requested?.updates.length ?? 0 );
	} );
}

/**
 * A request came back: the rooms it carried are connected.
 *
 * @param roomsInRequest The rooms the request carried.
 */
function markConnected( roomsInRequest: RoomState[] ): void {
	consecutiveFailures = 0;
	isManualRetry = false;
	syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;
	roomsInRequest.forEach( ( state ) => {
		// Skip rooms unregistered during the await (e.g. the
		// size-limit handler in onDocUpdate). Their terminal
		// status was already set by whatever unregistered them.
		if ( roomStates.get( state.room ) !== state ) {
			return;
		}

		state.onStatusChange( { status: 'connected' } );
	} );
}

/**
 * Handles a failed request on either lane: permission and engine fences
 * drop the affected rooms, a too-large body shrinks the next one, a
 * protocol mismatch ends everything, and anything else backs off with
 * the sent updates restored (or replaced by the codec's recovery update).
 *
 * @param error          What the request threw.
 * @param payload        The request.
 * @param roomsInRequest The rooms it carried.
 * @param lane           Which lane it was on.
 * @param startedAt      When it started (for the inspector).
 * @return Whether the loop must stop: every room is gone, or the server
 *         cannot speak our protocol.
 */
function handleRequestFailure(
	error: unknown,
	payload: SyncPayload,
	roomsInRequest: RoomState[],
	lane: ResponseLane,
	startedAt: number
): boolean {
	if ( isSyncDebugEnabled() ) {
		for ( const requested of payload.rooms ) {
			recordPoll( {
				room: requested.room,
				sent: requested.updates,
				received: [],
				durationMs: Date.now() - startedAt,
				error: String( error ),
			} );
		}
	}

	// A 403 response means the user does not have permission to
	// sync a specific entity. Silently unregister the affected
	// room(s) and let polling continue for the rest.
	if ( isForbiddenError( error ) ) {
		handleForbiddenError( error, payload.rooms );
		// If every room was unregistered, stop the poll loop instead of
		// scheduling another tick.
		return roomStates.size === 0;
	}

	if ( isEngineMismatchError( error ) ) {
		// A 409 means the room is bound to a different sync engine.
		// Retrying can never succeed — drop the affected room into
		// the lock posture and keep polling for the rest.
		handleEngineMismatchError( error, payload.rooms );
		return roomStates.size === 0;
	}

	if ( isRequestBodyTooLargeError( error ) ) {
		syncRequestBodySizeLimit = Math.max(
			MIN_SYNC_REQUEST_BODY_SIZE_LIMIT_IN_BYTES,
			Math.floor( syncRequestBodySizeLimit / 2 )
		);
		pollInterval = hasCollaborators
			? ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS[ 0 ]
			: ERROR_RETRY_DELAYS_SOLO_MS[ 0 ];
		restoreExactUpdates( payload );

		for ( const room of payload.rooms ) {
			if ( ! roomStates.has( room.room ) ) {
				continue;
			}

			roomStates.get( room.room )!.log(
				'Sync request body too large, retrying with smaller batches',
				{
					error,
					nextPoll: pollInterval,
					syncRequestBodySizeLimit,
				},
				'error',
				true // force
			);
		}
		return false;
	}

	if ( isProtocolMismatchError( error ) ) {
		// The server explicitly signaled a protocol mismatch, so we fail
		// gracefully instead of retrying indefinitely. This can happen if
		// the client is running an outdated version of the code that is
		// incompatible with the server.
		const affectedRooms = [ ...roomStates.entries() ];

		for ( const [ , state ] of affectedRooms ) {
			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.PROTOCOL_MISMATCH,
					'Protocol mismatch between client and server'
				),
			} );
		}

		// Skip the server-side disconnect signal: by definition the
		// server can't speak our protocol, so sending one is pointless.
		for ( const [ room ] of affectedRooms ) {
			unregisterRoom( room, { sendDisconnectSignal: false } );
		}

		return true;
	}

	// A disconnected transport has no wake of its own: let the
	// advisory channel back in (a no-op unless a stream had
	// switched it off). A failed SEND says nothing about the stream.
	if ( 'receive' === lane ) {
		setAdvisoryDisabledByTransport( false );
	}

	// Use the explicit retry delay schedule for backoff.
	consecutiveFailures++;
	const retrySchedule = hasCollaborators
		? ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS
		: ERROR_RETRY_DELAYS_SOLO_MS;
	if ( consecutiveFailures <= retrySchedule.length ) {
		pollInterval = retrySchedule[ consecutiveFailures - 1 ];
	} else {
		pollInterval = DISCONNECT_DIALOG_RETRY_MS;
	}

	// After a manual retry, use a shorter interval for one cycle.
	if ( isManualRetry ) {
		pollInterval = MANUAL_RETRY_INTERVAL_MS;
		isManualRetry = false;
	}

	// Recover from the failed request. We don't know whether the
	// server stored our updates before the error occurred (e.g. a
	// network timeout after a successful write). Recovery is
	// CODEC-DRIVEN: an engine whose updates are not idempotent on
	// the server (Yjs deltas) provides createRecoveryUpdate — a
	// full-state update that safely supersedes either outcome.
	// Engines without it (the intent log dedupes ingest by
	// intentId) get their exact updates restored and re-sent.
	// The recovery update is created BEFORE the queue is cleared
	// so a throwing codec can never lose queued work.
	for ( const room of payload.rooms ) {
		if ( ! roomStates.has( room.room ) ) {
			continue;
		}

		const state = roomStates.get( room.room )!;

		if ( room.updates.length > 0 ) {
			let recoveryUpdate: SyncUpdate | null = null;
			if ( state.session.createRecoveryUpdate && state.endCursor > 0 ) {
				try {
					recoveryUpdate = state.session.createRecoveryUpdate();
				} catch ( recoveryError ) {
					state.log(
						'Recovery update failed; restoring original updates',
						{ error: recoveryError },
						'error',
						true // force
					);
				}
			}
			if ( recoveryUpdate ) {
				state.updateQueue.clear();
				state.updateQueue.add( recoveryUpdate );
			} else {
				state.updateQueue.restore( room.updates );
			}
		}

		state.log(
			'Error posting sync update, will retry with backoff',
			{ error, nextPoll: pollInterval },
			'error',
			true // force
		);
	}

	// Don't report disconnected status when the request was aborted
	// due to page unload (e.g. during a refresh) to avoid briefly
	// flashing the disconnect dialog before the new page loads.
	if ( ! isUnloadPending ) {
		const backgroundRetriesFailed =
			consecutiveFailures > retrySchedule.length;

		roomsInRequest.forEach( ( state ) => {
			// Skip rooms unregistered during the await so
			// their terminal status isn't overwritten.
			if ( roomStates.get( state.room ) !== state ) {
				return;
			}

			state.onStatusChange( {
				status: 'disconnected',
				canManuallyRetry: true,
				consecutiveFailures,
				backgroundRetriesFailed,
				willAutoRetryInMs: pollInterval,
			} );
		} );
	}

	return false;
}

/*
 * THE SEND LANE (SSE). While the receive lane is on the stream, local
 * work does not wait for the stream and does not close it: it goes out
 * on the updates request beside the stream, marked `rows_received_separately: true`.
 * The server stores the updates and answers with its verdicts, any
 * never-stored row an engine synthesizes for this client (de-rtc's
 * fetch answer), and the room's head cursor — but no stored rows, and
 * the answer moves no cursor. The stream stays the only path that
 * delivers stored rows, so nothing is delivered twice or skipped, and
 * the answer is held (see applyRoomResponse) until the stream has
 * carried the cursor to that head: rows first, verdicts after, the
 * order every engine relies on. The tab's awareness state (its cursor,
 * its selection) rides the same lane on change (checkAwareness), so a
 * cursor move never reopens the stream either.
 *
 * One send at a time: two requests carrying updates must never be in
 * flight together (an engine's rows have an order), so a poll takes no
 * updates while a send is in flight, and a send is never built while
 * one is. Outside the stream (the settling window, a hidden tab, a
 * failed stream's backoff, a stopped loop) nothing here runs: sends ride
 * the polls as under short polling.
 */
let updatesInFlight = false;
let pollInFlightCounted = false;
let sendTimer: ReturnType< typeof setTimeout > | null = null;
/** Per room, the awareness state (serialized) the server last got. */
const lastSentAwareness = new Map< string, string >();
// How often a streaming tab compares its awareness state with the copy
// the server has (the framework already throttles cursor moves).
const AWARENESS_SEND_CHECK_MS = 1000;
let awarenessCheckTimer: ReturnType< typeof setInterval > | null = null;

/**
 * Whether the receive lane is on the stream, so sends go beside it.
 */
function streamReceiving(): boolean {
	return sseStreamReady() && isPolling;
}

/**
 * Sends soon: at once by default (a burst coalesces behind the request
 * in flight), or after a backoff delay when the last send failed.
 *
 * @param delay Milliseconds to wait.
 */
function scheduleSend( delay = 0 ): void {
	if ( sendTimer ) {
		return;
	}
	sendTimer = setTimeout( () => {
		sendTimer = null;
		void sendNow();
	}, delay );
}

/**
 * Notes the awareness state a request carries to the server.
 *
 * @param payload The request.
 */
function recordAwarenessSent( payload: SyncPayload ): void {
	for ( const room of payload.rooms ) {
		lastSentAwareness.set( room.room, JSON.stringify( room.awareness ) );
	}
}

function awarenessChanged(): boolean {
	for ( const state of roomStates.values() ) {
		if (
			lastSentAwareness.get( state.room ) !==
			JSON.stringify( state.session.getLocalAwareness() )
		) {
			return true;
		}
	}
	return false;
}

/**
 * A streaming tab with company sends its awareness state when it
 * changed since the server last got it (a solo tab has nobody to tell).
 */
function checkAwareness(): void {
	if ( streamReceiving() && hasCompany() && awarenessChanged() ) {
		scheduleSend();
	}
}

/**
 * Finishes a request that could carry updates (a poll off the stream,
 * or a send): the flush waiters count these.
 */
function finishSend(): void {
	sendsFinished++;
	for ( const waiter of sendDoneResolvers.splice( 0 ) ) {
		if ( waiter.target <= sendsFinished ) {
			waiter.resolve();
		} else {
			sendDoneResolvers.push( waiter );
		}
	}
}

async function sendNow(): Promise< void > {
	if ( 0 === roomStates.size || updatesInFlight ) {
		// The send in flight re-checks the queues when it returns.
		return;
	}
	if ( ! streamReceiving() ) {
		// The receive lane is off the stream: the polls carry sends.
		if ( hasQueuedUpdates() ) {
			pollNow();
		}
		return;
	}
	if ( ! hasQueuedUpdates() && ! awarenessChanged() ) {
		return;
	}

	const { payload, roomsInRequest } = buildPayloadForRequest(
		selectRoomsForRequest(),
		true
	);
	for ( const room of payload.rooms ) {
		room.rows_received_separately = true;
	}
	recordAwarenessSent( payload );
	updatesInFlight = true;
	sendsStarted++;
	const startedAt = Date.now();
	let stopped = false;
	try {
		const { rooms } = await postSyncUpdate( payload );
		markConnected( roomsInRequest );
		applyResponseRooms( rooms, payload, 'send', startedAt );
		applyHolds();
		if ( hasHeldTails() && ! isPolling ) {
			// The loop stopped meanwhile (the tab is alone now): nothing
			// would carry the cursor to the held tails. One receive does.
			pollNow();
		}
	} catch ( error ) {
		stopped = handleRequestFailure(
			error,
			payload,
			roomsInRequest,
			'send',
			startedAt
		);
		if ( ! stopped && hasQueuedUpdates() ) {
			scheduleSend( pollInterval );
		}
	}
	updatesInFlight = false;
	finishSend();
	if (
		! stopped &&
		! sendTimer &&
		( hasQueuedUpdates() || awarenessChanged() )
	) {
		// Work that arrived while this send was in flight.
		scheduleSend();
	}
}

function poll(): void {
	isPolling = true;
	pollingTimeoutId = null;

	async function start(): Promise< void > {
		if ( 0 === roomStates.size ) {
			isPolling = false;
			return;
		}

		// Reset the unloading flag at the start of each poll cycle so
		// it doesn't permanently suppress disconnect after the user
		// cancels a beforeunload dialog.
		isUnloadPending = false;

		/*
		 * Decided once, before the payload is built: a stream receive
		 * takes no updates (the send lane owns them, see sendNow), and
		 * neither does a poll while a send is in flight (two requests
		 * carrying updates must never overlap: an engine's rows have an
		 * order).
		 */
		const streamReceive = sseStreamReady();
		const takeUpdates = ! streamReceive && ! updatesInFlight;

		// Create a payload with queued updates. We include rooms even if they
		// have no updates to ensure we receive any incoming updates, while keeping
		// the serialized body below the server's aggregate request-size limit.
		const { payload, roomsInRequest } = buildPayloadForRequest(
			selectRoomsForRequest(),
			takeUpdates
		);
		pollInFlightCounted = takeUpdates;
		if ( takeUpdates ) {
			sendsStarted++;
		} else if ( streamReceive && hasQueuedUpdates() ) {
			// Queued work this receive leaves behind (the loop restarting
			// onto the stream with edits waiting): the send lane's.
			scheduleSend();
		}

		// Emit 'connecting' status only for rooms in this request. Rooms
		// rotated out of this poll keep their prior status.
		roomsInRequest.forEach( ( state ) => {
			state.onStatusChange( { status: 'connecting' } );
		} );

		const pollStarted = Date.now();
		let succeeded = false;
		let nextDelay: number | null = null;
		const isPureReceive = payload.rooms.every(
			( room ) => 0 === room.updates.length
		);
		let parkSignal: AbortSignal | undefined;
		if ( sseMode && isPureReceive ) {
			inFlightParkController = new AbortController();
			parkSignal = inFlightParkController.signal;
		}
		if ( ! streamReceive || ! sseExchange.isOpen() ) {
			// This payload reaches the server: as a request, or as the
			// stream that opens with it. (A reissue on an open stream
			// sends nothing.)
			recordAwarenessSent( payload );
		}
		try {
			const { rooms, advisory } = streamReceive
				? await sseExchange.exchange( payload, parkSignal )
				: await postSyncUpdate( payload, parkSignal );
			inFlightParkController = null;
			parkAbortedOnPurpose = false;
			// The signaling answer rode this poll: company, peers, mailbox.
			applyAnswer( advisory, payload.advisory?.seq );

			markConnected( roomsInRequest );
			applyResponseRooms( rooms, payload, 'receive', pollStarted );

			/*
			 * A stream delivers its own wake (an event the instant a row
			 * lands), so while one is up the advisory channel would only
			 * duplicate it: switch the channel off. While receiving runs
			 * on polling instead (no stream could be opened), the channel
			 * is the wake path again; a failed poll below also switches
			 * it back on.
			 */
			if ( sseMode ) {
				setAdvisoryDisabledByTransport( sseExchange.available );
			}

			// The first successful poll is the genesis handshake; from
			// here on the cadence rules decide the timer, and the holds
			// follow the company this response revealed.
			hasBootstrapped = true;
			applyHolds();
			succeeded = true;
			nextDelay = boundedByQueuedWork( nextScheduledDelay() );
			if ( null !== nextDelay ) {
				pollInterval = nextDelay;
			}
		} catch ( error ) {
			// Whatever the cause, the probe's signals never arrived: back to
			// the outbox for the next carrier.
			probeFailed( payload.advisory?.seq );
			if ( parkAbortedOnPurpose ) {
				/*
				 * Deliberate wake: the parked request carried no updates, so
				 * there is nothing to restore and no failure to record —
				 * re-poll immediately (the tab went hidden, or the room
				 * set changed under the stream).
				 */
				parkAbortedOnPurpose = false;
				inFlightParkController = null;
				if ( pollInFlightCounted ) {
					pollInFlightCounted = false;
					finishSend();
				}
				pollingTimeoutId = setTimeout( poll, 0 );
				return;
			}
			inFlightParkController = null;
			if (
				handleRequestFailure(
					error,
					payload,
					roomsInRequest,
					'receive',
					pollStarted
				)
			) {
				// Reset isPolling so a future registerRoom() call can
				// restart the loop.
				isPolling = false;
				return;
			}
		}

		if ( pollInFlightCounted ) {
			pollInFlightCounted = false;
			finishSend();
		}
		if ( repollImmediately ) {
			// A room restarted under us during this poll: the next poll
			// must follow at once (cursor 0) instead of waiting out the
			// interval.
			repollImmediately = false;
			scheduleNext( 0 );
			return;
		}
		scheduleNext( succeeded ? nextDelay : pollInterval );
	}

	// Start polling.
	void start();
}

/**
 * Handles a room whose generation changed mid-session: the server reset it
 * to a fresh genesis. The session decides whether it can rejoin (drop its
 * room-bound state and re-bootstrap from cursor 0) or must leave (its
 * local state cannot safely meet the new room); sessions without an
 * opinion re-bootstrap.
 *
 * @param roomState  The room's transport state.
 * @param generation The new generation token.
 * @param updates    The rows the response carried for the new room.
 */
function restartRoom(
	roomState: RoomState,
	generation: string,
	updates: SyncUpdate[]
): void {
	const session = roomState.session as TransportSessionCodec;
	const previous = roomState.generation;
	let decision: 'rebootstrap' | 'disconnect' = 'rebootstrap';
	try {
		decision = session.onRoomRestart?.( updates ) ?? 'rebootstrap';
	} catch ( error ) {
		roomState.log(
			'Session failed to handle the room restart; disconnecting',
			{ error },
			'error',
			true // force
		);
		decision = 'disconnect';
	}
	roomState.log(
		'Room restarted by the server',
		{ from: previous, to: generation, decision },
		'error',
		true // force
	);

	if ( 'disconnect' === decision ) {
		roomState.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.UNKNOWN_ERROR,
				'The shared document was restarted by the server'
			),
		} );
		unregisterRoom( roomState.room, { sendDisconnectSignal: true } );
		return;
	}

	roomState.generation = generation;
	roomState.endCursor = 0;
	// Answers to sends against the old room have nothing left to settle.
	roomState.heldTails.length = 0;
	// The queue held work written against the old room; the session
	// re-derives anything still relevant after it re-bootstraps.
	roomState.updateQueue.clear();
	roomState.updateQueue.restoreExact( session.getInitialUpdates() );
	repollImmediately = true;
}

function registerRoom( {
	room,
	session,
	log,
	onStatusChange,
	initialCursor = 0,
	initialUpdates = [],
}: RegisterRoomOptions ): void {
	if ( roomStates.has( room ) ) {
		return;
	}

	// State accessors for the console inspector (duck-typed; inert unless
	// the inspector is enabled).
	registerDebugSession( room, session );

	/*
	 * A lone tab holds its queue until company arrives (released by a
	 * heartbeat or poll answer, a save, or the tab going hidden). Codecs
	 * that declare `sendsWhileAlone` (de-rtc: commits ride the autosave
	 * lane, and its queued rows are advisories that must flow) are exempt.
	 */
	const holdWhileAlone = ! (
		session as EngineSessionCodec & { sendsWhileAlone?: boolean }
	 ).sendsWhileAlone;
	const updateQueue = createUpdateQueue(
		[ ...session.getInitialUpdates(), ...initialUpdates ],
		holdWhileAlone && isAlone()
	);

	/**
	 * Connection limits are enforced on the first entity to be loaded for sync.
	 * This is an inelegant solution to a hard problem: This sync provider and the
	 * sync package in general intentionally have no knowledge of the individual
	 * entities being synced.
	 *
	 * Let's say a user opens a document (Entity A) for editing. If you asked the
	 * user what they are doing, they would reply "I'm editing Entity A." You might
	 * say that Entity A is "primary."
	 *
	 * However, the action of editing Entity A also triggers the loading of a
	 * collection of document categories (Entity B) and another document (Entity C)
	 * that is embedded in Entity A. You might therefore say that Entity B and
	 * Entity C are "secondary" in this session.
	 *
	 * Meanwhile, a different user opens Entity C for editing, which also triggers
	 * the loading of Entity B. In this session, Entity C is "primary" and Entity B
	 * is "secondary."
	 *
	 * How do we enforce limits? The intuitive answer is that we only want to count
	 * connections when the entity is "primary." However, we have no ability to
	 * detect this. A document might be loaded as a primary entity in one session
	 * and a secondary entity in another.
	 *
	 * In practice, we can consider the first-loaded entity as "primary" and use it
	 * to enforce our connection limit. This is an imperfect assumption of consumer
	 * behavior.
	 *
	 * How might this approach be improved? We could develop some way to annotate
	 * entity loading so that the consumer can indicate which entity is primary.
	 */
	const isPrimaryRoom = 0 === roomStates.size;

	function onLocalUpdate( update: SyncUpdate, sizeInBytes: number ): void {
		if ( sizeInBytes > MAX_UPDATE_SIZE_IN_BYTES ) {
			const state = roomStates.get( room );
			if ( ! state ) {
				return;
			}

			state.log( 'Document size limit exceeded', {
				maxUpdateSizeInBytes: MAX_UPDATE_SIZE_IN_BYTES,
				updateSizeInBytes: sizeInBytes,
			} );

			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.DOCUMENT_SIZE_LIMIT_EXCEEDED,
					'Document size limit exceeded'
				),
			} );

			// This is an unrecoverable error. Unregister the room to prevent syncing.
			unregisterRoom( room );
			return;
		}

		updateQueue.add( update );

		// A held queue (alone, holdable codec) waits for company or a
		// flush; see wakeForLocalWork for when a wake is needed.
		wakeForLocalWork( holdWhileAlone && isAlone() );
	}

	function unregister(): void {
		// Never destroy unsent local work silently: report what is being
		// discarded and give the session a chance to surface it to the
		// user before it is gone.
		const unsent = updateQueue.drain();
		if ( unsent.length > 0 ) {
			log(
				`Discarding ${ unsent.length } unsent sync update(s) at room teardown`,
				{ types: unsent.map( ( update ) => update.type ) },
				'error',
				true // force
			);
			( session as TransportSessionCodec ).onUpdatesDiscarded?.( unsent );
		}
		session.destroy();
	}

	const roomState: RoomState = {
		endCursor: initialCursor,
		heldTails: [],
		isPrimaryRoom,
		lastServerAwareness: {},
		holdWhileAlone,
		log,
		onStatusChange,
		room,
		session,
		unregister,
		updateQueue,
	};

	session.onLocalUpdate( onLocalUpdate );
	roomStates.set( room, roomState );
	if ( sseMode ) {
		// Let the room set settle before a stream (re)opens: the new
		// room's bootstrap rides an ordinary request meanwhile, and an
		// open stream would not cover it.
		sseSettleUntil = Date.now() + SSE_SETTLE_MS;
		abortParkedStream();
		sseExchange.close();
		if ( ! awarenessCheckTimer ) {
			awarenessCheckTimer = setInterval(
				checkAwareness,
				AWARENESS_SEND_CHECK_MS
			);
		}
	}

	if ( ! areListenersRegistered ) {
		window.addEventListener( 'beforeunload', handleBeforeUnload );
		window.addEventListener( 'pagehide', handlePageHide );
		document.addEventListener( 'visibilitychange', handleVisibilityChange );
		onLocalAwarenessChange( onLocalAwarenessChanged );
		areListenersRegistered = true;
	}

	if ( isPrimaryRoom ) {
		fastDiscoveryUntil = Date.now() + FAST_DISCOVERY_WINDOW_MS;
		// The signaling lane and the advisory channel are per page, keyed
		// by the primary room's session (the post being edited).
		setSyncClientId( session.clientId );
		installAdvisoryHooks();
		startAdvisoryChannel();
	}

	if ( ! isPolling ) {
		poll();
	} else {
		// A room that arrives mid-session (an entity loaded later) needs
		// its bootstrap promptly, whatever the cadence rules have the timer
		// at (the 25 s safety poll under coverage or alone).
		pollSoonForLocalUpdate();
	}
}

function unregisterRoom(
	room: string,
	{ sendDisconnectSignal = true }: { sendDisconnectSignal?: boolean } = {}
): void {
	if ( sseMode ) {
		abortParkedStream();
		sseExchange.close();
	}
	const state = roomStates.get( room );
	if ( state ) {
		if ( sendDisconnectSignal ) {
			// Send a disconnect signal so the server removes this client's
			// awareness entry immediately instead of waiting for the timeout.
			const rooms = [
				{
					after: 0,
					awareness: null,
					client_id: state.session.clientId,
					room,
					updates: [],
				},
			];

			postSyncUpdateNonBlocking( { rooms } );
		}

		state.unregister();
		dropRoom( room );
		return;
	}
	unregisterDebugSession( room );
}

/**
 * Hands a room back to a preferred transport: waits for any request in
 * flight (so the cursor is final and nothing is delivered twice), then
 * drops the room WITHOUT destroying its session or telling the server it
 * left, returning the cursor to resume from and the updates that never
 * went out.
 *
 * @param room The room.
 */
function releaseRoom( room: string ): Promise< ReleasedRoom > {
	const state = roomStates.get( room );
	if ( ! state ) {
		return Promise.resolve( { cursor: 0, unsent: [] } );
	}
	const finish = (): ReleasedRoom => {
		if ( roomStates.get( room ) !== state ) {
			return { cursor: 0, unsent: [] };
		}
		const released = {
			cursor: state.endCursor,
			unsent: state.updateQueue.drain(),
		};
		dropRoom( room );
		return released;
	};
	const inFlight =
		updatesInFlight ||
		( isPolling && null === pollingTimeoutId && pollInFlightCounted );
	if ( ! inFlight ) {
		return Promise.resolve( finish() );
	}
	return new Promise< ReleasedRoom >( ( resolve ) => {
		sendDoneResolvers.push( {
			target: sendsStarted,
			resolve: () => resolve( finish() ),
		} );
	} );
}

/**
 * Removes a room from the loop and, when it was the last one, resets the
 * shared state. The session is left to the caller.
 *
 * @param room The room.
 */
function dropRoom( room: string ): void {
	roomStates.delete( room );
	unregisterDebugSession( room );

	if ( 0 === roomStates.size && areListenersRegistered ) {
		window.removeEventListener( 'beforeunload', handleBeforeUnload );
		window.removeEventListener( 'pagehide', handlePageHide );
		document.removeEventListener(
			'visibilitychange',
			handleVisibilityChange
		);
		areListenersRegistered = false;
		hasCheckedConnectionLimit = false;
		consecutiveFailures = 0;
		roomOverflowOffset = 0;
		syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;
		hasBootstrapped = false;
		hasCollaborators = false;
		pollAgainRequested = false;
		cancelHiddenFlush();
		for ( const waiter of sendDoneResolvers.splice( 0 ) ) {
			waiter.resolve();
		}
		if ( localUpdatePollTimer ) {
			clearTimeout( localUpdatePollTimer );
			localUpdatePollTimer = null;
		}
		if ( sendTimer ) {
			clearTimeout( sendTimer );
			sendTimer = null;
		}
		if ( awarenessCheckTimer ) {
			clearInterval( awarenessCheckTimer );
			awarenessCheckTimer = null;
		}
		lastSentAwareness.clear();
		if ( announcePollTimer ) {
			clearTimeout( announcePollTimer );
			announcePollTimer = null;
		}
		stopAdvisoryChannel();
	}
}

/**
 * Immediately retry the sync connection by cancelling any pending
 * timeout and triggering a new poll. If the retry fails, the next
 * auto-retry waits 15s (MANUAL_RETRY_INTERVAL_MS) instead of the
 * usual 30s, then falls back to 30s for subsequent auto-retries.
 */
function retryNow(): void {
	isManualRetry = true;
	pollNow();
}

export const pollingManager: PollingManager = {
	registerRoom,
	releaseRoom,
	retryNow,
	unregisterRoom,
};
