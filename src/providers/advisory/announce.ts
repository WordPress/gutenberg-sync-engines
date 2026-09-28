/**
 * Two notices, decoupled from the channels that carry them:
 *
 * - "I just wrote rows". Anything that lands rows on the server outside
 *   the polling manager (de-rtc's commits ride the autosave endpoint)
 *   calls `announceLocalWrite`; the advisory channel subscribes and tells
 *   the peers to poll. A notice is a rumor: it carries a room name (or
 *   `*` for "some room") and nothing else. Receivers poll and find out.
 * - "My presence changed". Slow awareness calls
 *   `announceLocalAwarenessChange` when it names a new block on the local
 *   awareness state. Under short polling the advisory channel's presence
 *   lane already carries the field, so the polling manager only reacts
 *   under SSE, where it reissues a parked stream exchange so the value
 *   does not wait for the next event.
 */

export const ANY_ROOM = '*';

const listeners: Array< ( room: string ) => void > = [];
const awarenessListeners: Array< () => void > = [];

/**
 * Announces that this tab landed rows on the server.
 *
 * @param room The room written to, or ANY_ROOM when the writer does not
 *             know its room name.
 */
export function announceLocalWrite( room: string = ANY_ROOM ): void {
	for ( const callback of listeners ) {
		callback( room );
	}
}

/**
 * Subscribes to local write notices.
 *
 * @param callback Called with the room name (or ANY_ROOM).
 */
export function onLocalWrite( callback: ( room: string ) => void ): void {
	listeners.push( callback );
}

/**
 * Announces that this tab's local awareness state changed.
 */
export function announceLocalAwarenessChange(): void {
	for ( const callback of awarenessListeners ) {
		callback();
	}
}

/**
 * Subscribes to local awareness change notices.
 *
 * @param callback Called on every change.
 */
export function onLocalAwarenessChange( callback: () => void ): void {
	awarenessListeners.push( callback );
}

/**
 * Resets the module state. Test use only.
 */
export function resetAnnounceForTesting(): void {
	listeners.length = 0;
	awarenessListeners.length = 0;
}
