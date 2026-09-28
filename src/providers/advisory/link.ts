/**
 * Internal dependencies
 */
import type { DiscoveredPeer } from './signaling';

/**
 * The advisory channel comes in two shapes, chosen on the settings screen
 * (`gutenberg_sync_engines_advisory_channel`):
 *
 * - `webrtc-advisory` (default): a browser-to-browser mesh, one WebRTC
 *   data channel per discovered tab, negotiated through the heartbeat.
 * - `websocket-advisory`: one socket per tab to the plugin's sync daemon,
 *   which relays presence and notices between the tabs in a room and
 *   never carries rows. It reaches peers WebRTC cannot (a symmetric NAT
 *   without TURN, a blocking extension, tabs on different networks) and
 *   asks nothing of the daemon but a fan-out.
 *
 * Both are a LINK under the same channel: `channel.ts` owns what the
 * polling manager sees (presence overlay, notices, coverage, the on/off
 * switch); a link only moves messages and answers "who is reachable".
 */

export type AdvisoryChannelSlug = 'webrtc-advisory' | 'websocket-advisory';

export const WEBRTC_ADVISORY: AdvisoryChannelSlug = 'webrtc-advisory';
export const WEBSOCKET_ADVISORY: AdvisoryChannelSlug = 'websocket-advisory';

export interface PresenceEntry {
	room: string;
	clientId: number;
	state: unknown;
}

/**
 * What a link may tell the channel.
 */
export interface AdvisoryLinkHost {
	/** Whether the channel wants the link up right now. */
	isActive: () => boolean;
	/** A peer landed rows in a room (or `*`): poll. */
	announce: ( room: string ) => void;
	/** A peer's base presence for a room; null or undefined removes it. */
	presence: ( room: string, clientId: number, state: unknown ) => void;
	/** A peer is gone: drop its presence from every room. */
	forgetPeer: ( clientId: number ) => void;
	/** Reachability changed (a peer arrived, dropped, or identified itself). */
	coverageChanged: () => void;
	/** This tab's last-sent presence, to greet a peer that just arrived. */
	sentPresence: () => PresenceEntry[];
}

export interface AdvisoryLink {
	readonly slug: AdvisoryChannelSlug;
	/** Whether this page has what the link needs (a socket URL, WebRTC). */
	isAvailable: () => boolean;
	/** Whether the link stood itself down (the WebRTC peer cap). */
	isStoodDown: () => boolean;
	start: ( host: AdvisoryLinkHost ) => void;
	/** Says goodbye and closes everything; the link may be started again. */
	stop: () => void;
	/** The transport's switch: closed while suspended, reconnects after. */
	setSuspended: ( suspended: boolean ) => void;
	/** Whether a presence message would reach anyone right now. */
	canSend: () => boolean;
	sendPresence: ( entry: PresenceEntry ) => void;
	sendAnnounce: ( room: string ) => void;
	/** The tab is going away. */
	sendBye: () => void;
	/**
	 * Whether every discovered tab and every listed client id (own id
	 * already excluded) is reachable over the link.
	 *
	 * @param discovered The tabs the heartbeat reported.
	 * @param clientIds  The other client ids the last awareness map carried.
	 */
	coversPeers: (
		discovered: DiscoveredPeer[],
		clientIds: number[]
	) => boolean;
	debugState: () => Record< string, unknown >;
	/** Resets the module state. Test use only. */
	reset: () => void;
}
