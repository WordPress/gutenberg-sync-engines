/**
 * WordPress dependencies
 */
import { addAction } from '@wordpress/hooks';

/**
 * The signaling side of the advisory channel: discovery of the other tabs
 * editing this post, the "is anyone else here?" answer the transports use
 * to go quiet or wake, and the mailbox that carries the WebRTC handshake
 * between tabs. All of it rides the heartbeat WordPress already sends from
 * every editor screen (every 10 s on a focused editor tab, 120 s when the
 * tab lacks focus), so no request cadence is added to the site.
 *
 * Each editor tab has a per-tab token, stamped server-side when the page
 * renders and refreshed on every heartbeat. The heartbeat answer lists the
 * OTHER tokens in the room, says whether anyone else is present (tokens plus
 * live sync awareness), and delivers the handshake messages addressed to
 * this tab. Sending a message calls `wp.heartbeat.connectNow()` so the
 * sender never waits for its own tick; the receiver still sees it on its
 * next tick, which is what makes a handshake two heartbeat hops.
 *
 * When the injected settings or `wp.heartbeat` are missing (a screen with no
 * per-post room, or the channel disabled on the site), the lane reports
 * itself unavailable and the transports keep their always-on cadence.
 */

const HOOK_NAMESPACE = 'gutenberg-sync-engines/advisory-signaling';

/**
 * Key used in both directions of the heartbeat payload. Mirrors
 * Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY on the server.
 */
export const HEARTBEAT_DATA_KEY = 'gutenberg_sync_engines_advisory';

export type SignalKind = 'offer' | 'answer' | 'ice' | 'bye';

export interface Signal {
	from: string;
	kind: SignalKind;
	data: string;
	/** Sender-assigned id; a retry may deliver the same signal twice. */
	id?: string;
}

export interface DiscoveredPeer {
	token: string;
	clientId: number;
	userId: number;
	/**
	 * Slow awareness over Heartbeat (src/awareness/channels/heartbeat-
	 * channel.ts): present only when this tab's probe carried a block.
	 */
	block?: string | null;
	name?: string;
	avatar?: string;
}

export interface AdvisorySettings {
	room: string;
	token: string;
	othersPresent?: boolean;
	/** The link the site chose: `webrtc-advisory` (default) or `websocket-advisory`. */
	channel?: string;
	/** WebRTC: the ICE servers. */
	iceServers?: RTCIceServer[];
	maxPeers?: number;
	/** WebSocket: the sync daemon's URL. */
	socketUrl?: string;
	/** The leave beacon's REST URL (the nonce is appended at send time). */
	leaveUrl?: string;
	/** The REST nonce minted at page render (fallback for the beacon). */
	nonce?: string;
}

interface HeartbeatApi {
	interval: ( ...args: unknown[] ) => unknown;
	connectNow?: () => unknown;
}

interface OutgoingSignal {
	id: string;
	to: string;
	kind: SignalKind;
	data: string;
}

let installed = false;
let lifecycleInstalled = false;
let settingsOverride: AdvisorySettings | null = null;
let leaveSent = false;
let believesInitialized = false;
let othersBelieved = false;
let peers: DiscoveredPeer[] = [];
let syncClientId: number | null = null;
const outbox: OutgoingSignal[] = [];
let connectNowScheduled = false;
/*
 * Reliability: a probe's signals stay in `inFlight` until the request that
 * carried them is answered; a failed request puts them back at the front
 * of the outbox. Every probe carries a sequence number so an answer that
 * arrives after a newer one (a slow heartbeat overtaken by a poll) cannot
 * regress the peer list; its signals are still delivered. Each signal has
 * an id so a receiver can ignore the duplicate a retry may produce.
 */
let probeSeq = 0;
let signalSeq = 0;
let lastAppliedSeq = 0;
let lastHeartbeatSeq = 0;
const inFlight: Map< number, OutgoingSignal[] > = new Map();

let signalCarrier: ( () => boolean ) | null = null;
let probeFields: ( () => Record< string, unknown > ) | null = null;

const signalListeners: Array< ( signal: Signal ) => void > = [];
const peersListeners: Array< ( peers: DiscoveredPeer[] ) => void > = [];
const answerListeners: Array< ( peers: DiscoveredPeer[] ) => void > = [];
const othersListeners: Array< ( others: boolean ) => void > = [];
const cursorListeners: Array< ( cursor: number ) => void > = [];
const engineListeners: Array< ( engine: string ) => void > = [];

/**
 * The advisory settings the server injected for this editor page, or null
 * when this page has no per-post room (or the channel is disabled).
 */
export function getAdvisorySettings(): AdvisorySettings | null {
	const settings =
		settingsOverride ??
		(
			window as {
				_gutenbergSyncEnginesSettings?: {
					advisory?: AdvisorySettings;
				};
			}
		 )._gutenbergSyncEnginesSettings?.advisory;

	if ( ! settings?.room || ! settings?.token ) {
		return null;
	}

	return settings;
}

function getHeartbeat(): HeartbeatApi | null {
	const heartbeat = (
		window as {
			wp?: { heartbeat?: HeartbeatApi };
		}
	 ).wp?.heartbeat;

	return typeof heartbeat?.interval === 'function' ? heartbeat : null;
}

/**
 * Whether the signaling lane can run on this page: the server injected a
 * room and per-tab token, and the heartbeat API is present to carry the
 * probe. When false, transports keep their always-on behavior.
 */
export function isSignalingAvailable(): boolean {
	return null !== getAdvisorySettings() && null !== getHeartbeat();
}

/**
 * This tab's presence token, or null off a per-post editor screen.
 */
export function getPresenceToken(): string | null {
	return getAdvisorySettings()?.token ?? null;
}

/**
 * The room this tab's presence token belongs to.
 */
export function getPresenceRoom(): string | null {
	return getAdvisorySettings()?.room ?? null;
}

function initializeBelief(): void {
	if ( believesInitialized ) {
		return;
	}
	believesInitialized = true;
	othersBelieved = true === getAdvisorySettings()?.othersPresent;
}

/**
 * The current belief about company: true when the page-load flag or the
 * most recent heartbeat answer said another tab or live sync session is in
 * this post's room. While true, transports must not go quiet.
 */
export function othersPresent(): boolean {
	initializeBelief();
	return othersBelieved;
}

/**
 * The other tabs the last heartbeat answer reported in this room.
 */
export function getDiscoveredPeers(): DiscoveredPeer[] {
	return peers;
}

/**
 * Records the primary room session's client id: it rides the probe so the
 * server can tell this tab's own sync awareness entry apart from a peer's,
 * and so peers can map this tab's token to its client id.
 *
 * @param clientId The engine session's client id.
 */
export function setSyncClientId( clientId: number ): void {
	syncClientId = clientId;
}

/**
 * The client id recorded by setSyncClientId, or null.
 */
export function getSyncClientId(): number | null {
	return syncClientId;
}

/**
 * Queues a handshake message for another tab and asks the heartbeat to
 * beat now so it leaves right away (the heartbeat coalesces several calls
 * into one request; a beat already in flight carries the next one).
 *
 * @param to   The recipient's presence token.
 * @param kind The message kind.
 * @param data The message payload (SDP or a serialized ICE candidate).
 */
export function sendSignal( to: string, kind: SignalKind, data: string ): void {
	if ( ! isSignalingAvailable() ) {
		return;
	}
	signalSeq++;
	outbox.push( {
		id: `${ getPresenceToken() ?? '' }-${ signalSeq }`,
		to,
		kind,
		data,
	} );
	install();
	if ( connectNowScheduled ) {
		return;
	}
	connectNowScheduled = true;
	// Let a burst of signals (an offer plus late candidates) share one
	// request. An active poll loop is the faster carrier (its next request
	// is brought forward); a quiet tab beats the heartbeat now.
	setTimeout( () => {
		connectNowScheduled = false;
		if ( signalCarrier?.() ) {
			return;
		}
		getHeartbeat()?.connectNow?.();
	}, 50 );
}

/**
 * Registers a faster carrier for queued signals than the heartbeat: the
 * polling manager, whose next poll carries the probe. The carrier returns
 * true when it took the signals (a poll is coming), false when its loop is
 * quiet and the heartbeat should beat instead.
 *
 * @param carrier The carrier, or null to fall back to the heartbeat.
 */
export function setSignalCarrier( carrier: ( () => boolean ) | null ): void {
	signalCarrier = carrier;
}

/**
 * The probe to attach to an outgoing request (a heartbeat beat or a sync
 * poll): this tab's room and token, its sync client id, and the queued
 * handshake messages, which it drains. Null off a per-post editor screen.
 */
export function buildProbe():
	| ( Record< string, unknown > & { seq: number } )
	| null {
	const settings = getAdvisorySettings();
	if ( ! settings ) {
		return null;
	}
	const seq = ++probeSeq;
	const signals = outbox.splice( 0, outbox.length );
	if ( signals.length > 0 ) {
		inFlight.set( seq, signals );
	}
	return {
		seq,
		room: settings.room,
		token: settings.token,
		...( null !== syncClientId ? { client_id: syncClientId } : {} ),
		...( signals.length > 0 ? { signals } : {} ),
		...( probeFields ? probeFields() : {} ),
	};
}

/**
 * Registers extra fields every probe carries (slow awareness over
 * Heartbeat adds the block this tab is in). Null removes them.
 *
 * @param source Returns the fields, read when a probe is built.
 */
export function setProbeFields(
	source: ( () => Record< string, unknown > ) | null
): void {
	probeFields = source;
}

/**
 * The request that carried a probe failed (or was aborted): its signals
 * go back to the front of the outbox for the next carrier.
 *
 * @param seq The probe's sequence number.
 */
export function probeFailed( seq: number | undefined ): void {
	if ( undefined === seq ) {
		return;
	}
	const signals = inFlight.get( seq );
	inFlight.delete( seq );
	if ( signals && signals.length > 0 ) {
		outbox.unshift( ...signals );
		if ( ! connectNowScheduled ) {
			connectNowScheduled = true;
			setTimeout( () => {
				connectNowScheduled = false;
				if ( ! signalCarrier?.() ) {
					getHeartbeat()?.connectNow?.();
				}
			}, 50 );
		}
	}
}

/**
 * Registers a listener for handshake messages addressed to this tab.
 *
 * @param callback Called once per delivered message, oldest first.
 */
export function onSignal( callback: ( signal: Signal ) => void ): void {
	signalListeners.push( callback );
	install();
}

/**
 * Registers a listener for changes to the discovered peer list.
 *
 * @param callback Called with the new list whenever it changes.
 */
export function onPeersChanged(
	callback: ( peers: DiscoveredPeer[] ) => void
): void {
	peersListeners.push( callback );
	install();
}

/**
 * Registers a listener for every applied answer, with the peers it
 * reported (stale answers are skipped). Unlike `onPeersChanged` this
 * fires whether or not the list changed, so a listener can treat each
 * answer as a fresh roster.
 *
 * @param callback Called with the peers.
 * @return Unsubscribe.
 */
export function onAnswer(
	callback: ( peers: DiscoveredPeer[] ) => void
): () => void {
	answerListeners.push( callback );
	install();
	return () => {
		const index = answerListeners.indexOf( callback );
		if ( index >= 0 ) {
			answerListeners.splice( index, 1 );
		}
	};
}

/**
 * Registers a listener for the room's head cursor, as each fresh answer
 * reports it (the transport compares it with its own cursor and polls
 * when behind).
 *
 * @param callback Called with the head cursor.
 */
export function onRoomCursor( callback: ( cursor: number ) => void ): void {
	cursorListeners.push( callback );
	install();
}

/**
 * Registers a listener for the engine the site resolves for the room, as
 * each fresh answer reports it (a change mid-session makes the transport
 * poll into the server's fence instead of never noticing).
 *
 * @param callback Called with the engine slug.
 */
export function onRoomEngine( callback: ( engine: string ) => void ): void {
	engineListeners.push( callback );
	install();
}

/**
 * Registers a listener for the company belief flipping either way.
 *
 * @param callback Called with the new belief.
 */
export function onOthersChanged( callback: ( others: boolean ) => void ): void {
	othersListeners.push( callback );
	install();
}

function currentRestNonce(): string | null {
	const middlewareNonce = (
		window as {
			wp?: { apiFetch?: { nonceMiddleware?: { nonce?: unknown } } };
		}
	 ).wp?.apiFetch?.nonceMiddleware?.nonce;
	if ( 'string' === typeof middlewareNonce && middlewareNonce ) {
		return middlewareNonce;
	}
	const settingsNonce = getAdvisorySettings()?.nonce;
	return 'string' === typeof settingsNonce && settingsNonce
		? settingsNonce
		: null;
}

/**
 * Tells the server this tab is leaving its post's room. Sent once, on
 * `pagehide`, with `navigator.sendBeacon` so it survives the navigation.
 * Peers stop counting this tab on their next heartbeat.
 */
export function sendLeaveBeacon(): boolean {
	if ( leaveSent ) {
		return false;
	}
	const settings = getAdvisorySettings();
	if ( ! settings?.leaveUrl ) {
		return false;
	}
	const nonce = currentRestNonce();
	if ( ! nonce ) {
		return false;
	}
	leaveSent = true;
	const url =
		settings.leaveUrl +
		( settings.leaveUrl.includes( '?' ) ? '&' : '?' ) +
		'_wpnonce=' +
		encodeURIComponent( nonce );
	const body = JSON.stringify( {
		room: settings.room,
		token: settings.token,
		...( null !== syncClientId ? { client_id: syncClientId } : {} ),
	} );
	if ( 'function' === typeof navigator.sendBeacon ) {
		return navigator.sendBeacon(
			url,
			new Blob( [ body ], { type: 'application/json' } )
		);
	}
	void fetch( url, {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/json' },
		keepalive: true,
		credentials: 'same-origin',
	} ).catch( () => {} );
	return true;
}

function onPageHide(): void {
	sendLeaveBeacon();
}

function onVisibilityChange(): void {
	// A hidden tab's heartbeat slows to two minutes; beat once now so the
	// server's copy of this tab's presence is fresh going into that lull.
	if ( 'hidden' === document.visibilityState ) {
		getHeartbeat()?.connectNow?.();
	}
}

/**
 * Installs the tab-lifecycle handlers (leave beacon on `pagehide`, a
 * presence refresh when the tab hides). Idempotent; transports call it
 * when they register their first room.
 */
export function installSignalingLifecycle(): void {
	if ( lifecycleInstalled || ! getAdvisorySettings() ) {
		return;
	}
	lifecycleInstalled = true;
	window.addEventListener( 'pagehide', onPageHide );
	document.addEventListener( 'visibilitychange', onVisibilityChange );
}

function onHeartbeatSend( data: Record< string, unknown > ): void {
	const probe = buildProbe();
	if ( probe ) {
		lastHeartbeatSeq = probe.seq;
		data[ HEARTBEAT_DATA_KEY ] = probe;
	}
}

function onHeartbeatError(): void {
	probeFailed( lastHeartbeatSeq );
}

function samePeers( a: DiscoveredPeer[], b: DiscoveredPeer[] ): boolean {
	if ( a.length !== b.length ) {
		return false;
	}
	return a.every(
		( peer, index ) =>
			peer.token === b[ index ].token &&
			peer.clientId === b[ index ].clientId &&
			peer.userId === b[ index ].userId
	);
}

function onHeartbeatTick( data: Record< string, unknown > ): void {
	// The beat went through, whether or not the server answered our key
	// (a disabled channel answers nothing): its signals are delivered.
	applyAnswer( data?.[ HEARTBEAT_DATA_KEY ], lastHeartbeatSeq );
}

/**
 * Reads the server's answer to a probe, whichever request carried it:
 * company, the discovered peers, and this tab's mailbox. Listeners fire on
 * changes and on each delivered message. An answer older than the last
 * applied one (a slow heartbeat overtaken by a poll) delivers its signals
 * but does not touch the peer list or the company belief.
 *
 * @param raw The answer, or anything else (ignored).
 * @param seq The sequence number of the probe this answers, when known.
 */
export function applyAnswer( raw: unknown, seq?: number ): void {
	if ( undefined !== seq ) {
		inFlight.delete( seq );
	}
	const answer = raw as
		| {
				others?: unknown;
				peers?: unknown;
				signals?: unknown;
				cursor?: unknown;
				engine?: unknown;
		  }
		| undefined;
	if (
		! answer ||
		'object' !== typeof answer ||
		'boolean' !== typeof answer.others
	) {
		return;
	}
	const stale = undefined !== seq && seq < lastAppliedSeq;
	if ( ! stale && undefined !== seq ) {
		lastAppliedSeq = seq;
	}
	if ( stale ) {
		deliverSignals( answer.signals );
		return;
	}

	initializeBelief();
	const hadOthers = othersBelieved;
	othersBelieved = answer.others;

	const nextPeers: DiscoveredPeer[] = Array.isArray( answer.peers )
		? answer.peers
				.filter(
					( peer ): peer is { token: string } =>
						!! peer &&
						'object' === typeof peer &&
						'string' ===
							typeof ( peer as { token?: unknown } ).token
				)
				.map( ( peer ) => {
					const fields = peer as {
						client_id?: unknown;
						user_id?: unknown;
						block?: unknown;
						name?: unknown;
						avatar?: unknown;
					};
					const discovered: DiscoveredPeer = {
						token: peer.token,
						clientId: Number( fields.client_id ?? 0 ),
						userId: Number( fields.user_id ?? 0 ),
					};
					if ( 'block' in fields ) {
						discovered.block =
							'string' === typeof fields.block
								? fields.block
								: null;
						discovered.name =
							'string' === typeof fields.name ? fields.name : '';
						discovered.avatar =
							'string' === typeof fields.avatar
								? fields.avatar
								: '';
					}
					return discovered;
				} )
				.sort( ( a, b ) => ( a.token < b.token ? -1 : 1 ) )
		: [];
	const peersChanged = ! samePeers( peers, nextPeers );
	peers = nextPeers;

	if ( hadOthers !== othersBelieved ) {
		for ( const callback of othersListeners ) {
			callback( othersBelieved );
		}
	}
	if ( peersChanged ) {
		for ( const callback of peersListeners ) {
			callback( peers );
		}
	}
	for ( const callback of answerListeners ) {
		callback( peers );
	}
	if (
		'number' === typeof answer.cursor &&
		Number.isFinite( answer.cursor )
	) {
		for ( const callback of cursorListeners ) {
			callback( answer.cursor );
		}
	}
	if ( 'string' === typeof answer.engine && '' !== answer.engine ) {
		for ( const callback of engineListeners ) {
			callback( answer.engine );
		}
	}

	deliverSignals( answer.signals );
}

function deliverSignals( signals: unknown ): void {
	if ( ! Array.isArray( signals ) ) {
		return;
	}
	for ( const signal of signals ) {
		if (
			! signal ||
			'object' !== typeof signal ||
			'string' !== typeof ( signal as Signal ).from ||
			'string' !== typeof ( signal as Signal ).kind ||
			'string' !== typeof ( signal as Signal ).data
		) {
			continue;
		}
		for ( const callback of signalListeners ) {
			callback( signal as Signal );
		}
	}
}

function install(): void {
	if ( installed || ! isSignalingAvailable() ) {
		return;
	}
	installed = true;

	addAction( 'heartbeat.send', HOOK_NAMESPACE, onHeartbeatSend );
	addAction( 'heartbeat.tick', HOOK_NAMESPACE, onHeartbeatTick );
	addAction( 'heartbeat.error', HOOK_NAMESPACE, onHeartbeatError );
}

/**
 * Attaches the probe to the heartbeat without registering any listener.
 * Transports call it when they register their first room so the belief
 * about company stays current even before the channel has peers.
 */
export function installSignaling(): void {
	if ( isSignalingAvailable() ) {
		install();
	}
}

/**
 * Overrides the page settings so several tabs can be simulated in one
 * process. Test use only.
 *
 * @param settings The settings, or null to read the page again.
 */
export function setAdvisorySettingsForTesting(
	settings: AdvisorySettings | null
): void {
	settingsOverride = settings;
	believesInitialized = false;
}

/**
 * Resets the module state. Test use only.
 */
export function resetSignalingForTesting(): void {
	settingsOverride = null;
	signalCarrier = null;
	othersBelieved = false;
	believesInitialized = false;
	peers = [];
	syncClientId = null;
	outbox.length = 0;
	inFlight.clear();
	probeSeq = 0;
	signalSeq = 0;
	lastAppliedSeq = 0;
	lastHeartbeatSeq = 0;
	connectNowScheduled = false;
	probeFields = null;
	signalListeners.length = 0;
	peersListeners.length = 0;
	answerListeners.length = 0;
	othersListeners.length = 0;
	cursorListeners.length = 0;
	engineListeners.length = 0;
	leaveSent = false;
	if ( lifecycleInstalled ) {
		window.removeEventListener( 'pagehide', onPageHide );
		document.removeEventListener( 'visibilitychange', onVisibilityChange );
		lifecycleInstalled = false;
	}
	// The heartbeat handlers stay attached (addAction dedupes by namespace);
	// they are inert without settings.
}
