/**
 * Internal dependencies
 */
import { onLocalWrite } from './announce';
import {
	getAdvisorySettings,
	getDiscoveredPeers,
	getPresenceToken,
	getSyncClientId,
} from './signaling';
import {
	WEBRTC_ADVISORY,
	WEBSOCKET_ADVISORY,
	type AdvisoryChannelSlug,
	type AdvisoryLink,
	type AdvisoryLinkHost,
	type PresenceEntry,
} from './link';
import { webrtcLink } from './webrtc-link';
import { websocketLink } from './websocket-link';

export type { PresenceEntry } from './link';

/**
 * The advisory channel between the tabs editing one post. It carries two
 * things and nothing else: presence (who is here) and the notice "I landed
 * rows on the server, go and poll". No document content ever crosses it,
 * and nothing that arrives on it is trusted for anything but display and a
 * decision to poll sooner. Every correctness property comes from the poll
 * the notice triggers (see docs/plan/advisory-channel.md).
 *
 * The messages travel over a LINK (`link.ts`), chosen on the settings
 * screen: a WebRTC mesh between the tabs (`webrtc-link.ts`, the default)
 * or one socket per tab to the sync daemon, which relays between the tabs
 * in a room (`websocket-link.ts`). This module owns everything the polling
 * manager sees, whichever link is underneath: the presence overlay, the
 * notice and coverage listeners, the presence loop, and the on/off switch.
 *
 * Coverage: the polling manager asks whether every peer it knows about —
 * every discovered token AND every client id in the last awareness map —
 * is reachable over the link. Only then does it stop polling on a timer.
 * A peer that cannot be reached simply keeps everyone on the timer
 * cadence; nothing is lost.
 */

const PRESENCE_SEND_INTERVAL_MS = 250;

let started = false;
let disabledByTransport = false;
let link: AdvisoryLink | null = null;
let localWriteSubscribed = false;
const presence: Map< string, Map< number, unknown > > = new Map();
const lastSentPresence: Map< string, { json: string; entry: PresenceEntry } > =
	new Map();
let presenceTimer: ReturnType< typeof setInterval > | null = null;
let presenceSource: ( () => PresenceEntry[] ) | null = null;

const announceListeners: Array< ( room: string ) => void > = [];
const presenceListeners: Array< ( room: string ) => void > = [];
const coverageListeners: Array< () => void > = [];

/**
 * The link the site chose for this page.
 */
export function getAdvisoryChannelSlug(): AdvisoryChannelSlug {
	return WEBSOCKET_ADVISORY === getAdvisorySettings()?.channel
		? WEBSOCKET_ADVISORY
		: WEBRTC_ADVISORY;
}

function selectLink(): AdvisoryLink {
	return WEBSOCKET_ADVISORY === getAdvisoryChannelSlug()
		? websocketLink
		: webrtcLink;
}

/**
 * Whether the channel is running and allowed to connect: started by a
 * transport, not disabled by the active transport, and its link has what
 * it needs on this page and has not stood itself down.
 */
export function isAdvisoryActive(): boolean {
	return (
		started &&
		! disabledByTransport &&
		null !== link &&
		link.isAvailable() &&
		! link.isStoodDown()
	);
}

function emit( listeners: Array< ( room: string ) => void >, room: string ) {
	for ( const callback of listeners ) {
		callback( room );
	}
}

function emitCoverage(): void {
	for ( const callback of coverageListeners ) {
		callback();
	}
}

const host: AdvisoryLinkHost = {
	isActive: isAdvisoryActive,

	announce( room: string ): void {
		emit( announceListeners, room );
	},

	presence( room: string, clientId: number, state: unknown ): void {
		let states = presence.get( room );
		if ( ! states ) {
			states = new Map();
			presence.set( room, states );
		}
		if ( null === state || undefined === state ) {
			if ( ! states.delete( clientId ) ) {
				return;
			}
		} else {
			states.set( clientId, state );
		}
		emit( presenceListeners, room );
	},

	forgetPeer( clientId: number ): void {
		for ( const [ room, states ] of presence ) {
			if ( states.delete( clientId ) ) {
				emit( presenceListeners, room );
			}
		}
	},

	coverageChanged: emitCoverage,

	sentPresence(): PresenceEntry[] {
		return Array.from( lastSentPresence.values() ).map(
			( { entry } ) => entry
		);
	},
};

function sendPresenceTick(): void {
	if ( ! presenceSource || ! link || ! link.canSend() ) {
		return;
	}
	for ( const entry of presenceSource() ) {
		const json = JSON.stringify( entry.state ?? null );
		if ( lastSentPresence.get( entry.room )?.json === json ) {
			continue;
		}
		lastSentPresence.set( entry.room, { json, entry } );
		link.sendPresence( entry );
	}
}

function onPageHide(): void {
	link?.sendBye();
}

/**
 * Starts the channel over the link the site chose and starts the presence
 * loop. A page without what the link needs (the signaling lane and
 * WebRTC, or a socket URL) stays inert.
 */
export function startAdvisoryChannel(): void {
	if ( started ) {
		return;
	}
	const chosen = selectLink();
	if ( ! chosen.isAvailable() ) {
		return;
	}
	started = true;
	link = chosen;
	if ( ! localWriteSubscribed ) {
		localWriteSubscribed = true;
		onLocalWrite( ( room ) => {
			if ( started ) {
				link?.sendAnnounce( room );
			}
		} );
	}
	window.addEventListener( 'pagehide', onPageHide );
	presenceTimer = setInterval( sendPresenceTick, PRESENCE_SEND_INTERVAL_MS );
	link.setSuspended( disabledByTransport );
	link.start( host );
}

/**
 * Stops the channel and says goodbye to every peer.
 */
export function stopAdvisoryChannel(): void {
	if ( ! started ) {
		return;
	}
	link?.stop();
	started = false;
	window.removeEventListener( 'pagehide', onPageHide );
	if ( presenceTimer ) {
		clearInterval( presenceTimer );
		presenceTimer = null;
	}
	presence.clear();
	lastSentPresence.clear();
	emitCoverage();
}

/**
 * The active transport's switch. A transport that delivers its own wake
 * signal (SSE's open stream) turns the channel off while it is
 * connected; the request is honored only while the transport says it is
 * connected, and turning it back on reconnects.
 *
 * @param disabled Whether the transport wants the channel off.
 */
export function setAdvisoryDisabledByTransport( disabled: boolean ): void {
	if ( disabled === disabledByTransport ) {
		return;
	}
	disabledByTransport = disabled;
	if ( started && link ) {
		link.setSuspended( disabled );
	}
}

/**
 * Whether every known peer is reachable over the channel: every token the
 * heartbeat discovered, and every client id in the given list (the last
 * awareness map, own id excluded). False when nobody is known at all:
 * "alone" is the transports' decision, not the channel's.
 *
 * @param clientIds Client ids the last poll's awareness map reported.
 */
export function advisoryCoversClients( clientIds: number[] ): boolean {
	if ( ! isAdvisoryActive() || ! link ) {
		return false;
	}
	const own = getSyncClientId();
	const others = clientIds.filter( ( id ) => id !== own );
	const discovered = getDiscoveredPeers();
	if ( 0 === discovered.length && 0 === others.length ) {
		return false;
	}
	return link.coversPeers( discovered, others );
}

/**
 * The presence states peers sent over the channel for one room, keyed by
 * client id, for overlaying on the (older) copy a poll response carries.
 *
 * @param room The room name.
 */
export function getChannelPresence( room: string ): Record< string, unknown > {
	const states = presence.get( room );
	const result: Record< string, unknown > = {};
	if ( ! states ) {
		return result;
	}
	for ( const [ clientId, state ] of states ) {
		result[ String( clientId ) ] = state;
	}
	return result;
}

/**
 * Registers the source of this tab's presence: the polling manager's rooms
 * and their sessions' local awareness. Polled every 250 ms while the link
 * can deliver; only changes are sent.
 *
 * @param source Returns the current presence entries.
 */
export function setPresenceSource(
	source: ( () => PresenceEntry[] ) | null
): void {
	presenceSource = source;
}

/**
 * Registers a listener for "a peer landed rows" notices.
 *
 * @param callback Called with the room name (or `*`).
 */
export function onAdvisoryAnnounce( callback: ( room: string ) => void ): void {
	announceListeners.push( callback );
}

/**
 * Registers a listener for presence changes received over the channel.
 *
 * @param callback Called with the room whose presence changed.
 */
export function onAdvisoryPresence( callback: ( room: string ) => void ): void {
	presenceListeners.push( callback );
}

/**
 * Registers a listener for coverage changes (a peer connected, dropped,
 * said hello, or the channel was switched off or on).
 *
 * @param callback Called on every change.
 */
export function onAdvisoryCoverageChanged( callback: () => void ): void {
	coverageListeners.push( callback );
}

/**
 * A snapshot for the sync inspector.
 */
export function getAdvisoryDebugState(): Record< string, unknown > {
	return {
		active: isAdvisoryActive(),
		started,
		disabledByTransport,
		channel: getAdvisoryChannelSlug(),
		token: getPresenceToken(),
		peers: [],
		...( link?.debugState() ?? {} ),
	};
}

/**
 * Resets the module state. Test use only.
 */
export function resetAdvisoryChannelForTesting(): void {
	webrtcLink.reset();
	websocketLink.reset();
	if ( presenceTimer ) {
		clearInterval( presenceTimer );
		presenceTimer = null;
	}
	if ( started ) {
		window.removeEventListener( 'pagehide', onPageHide );
	}
	started = false;
	link = null;
	localWriteSubscribed = false;
	disabledByTransport = false;
	presence.clear();
	lastSentPresence.clear();
	presenceSource = null;
	announceListeners.length = 0;
	presenceListeners.length = 0;
	coverageListeners.length = 0;
}
