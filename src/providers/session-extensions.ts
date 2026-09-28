/**
 * Internal dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { EngineSessionCodec, EngineUpdate } from '@wordpress/sync';

/**
 * What a session wants the transport to do after the server restarted the
 * room underneath it (the room's generation changed):
 *
 * - `rebootstrap`: the session dropped its room-bound state and is ready to
 *   receive the new room from cursor 0. The transport resets its cursor,
 *   replaces the queue with the session's initial updates, and fetches
 *   again at once.
 * - `disconnect`: the session cannot safely rejoin (its local state would
 *   collide with the new room). The transport unregisters the room with a
 *   disconnected status; the editor keeps its local edits as ordinary
 *   unsaved changes.
 */
export type RoomRestartDecision = 'rebootstrap' | 'disconnect';

/**
 * Plugin-side additions to the framework's `EngineSessionCodec`. The
 * framework interface is vendored and human-owned, so every plugin-specific
 * capability lives here as an OPTIONAL member the transports feature-detect.
 */
export interface TransportSessionExtensions {
	/**
	 * Flush queued updates even with no collaborator present. Without it the
	 * transport holds a solo editor's updates back until a second person
	 * appears (or the session is asked to flush).
	 */
	syncWhileSolo?: boolean;

	/**
	 * Transport teardown hook: called with the unsent updates the transport
	 * is about to discard at room unregistration.
	 */
	onUpdatesDiscarded?: ( updates: EngineUpdate[] ) => void;

	/**
	 * The server restarted this room: its generation token changed, so every
	 * row and cursor this session knew is gone and a fresh genesis (built
	 * from the saved post) took its place. Receives the rows the response
	 * carried for the NEW room (usually starting with its genesis snapshot)
	 * so the session can decide without another round trip. Sessions that
	 * omit this are re-bootstrapped blindly.
	 */
	onRoomRestart?: ( updates: EngineUpdate[] ) => RoomRestartDecision;
}

export type TransportSessionCodec = EngineSessionCodec &
	TransportSessionExtensions;
