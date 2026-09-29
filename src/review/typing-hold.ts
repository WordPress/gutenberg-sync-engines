/**
 * Holds a review card back while the person is still typing in the block
 * the card would replace.
 *
 * A card replaces the block's edit UI, so a card that appears mid-sentence
 * takes the typing area away: the rest of the sentence has nowhere to go,
 * and the reviewer is shown the first keystroke as the whole proposal.
 * While the card waits, the block stays editable and the engine keeps
 * setting the later keystrokes aside into the same record, so the card
 * that appears at the pause carries the whole sentence.
 *
 * Only the window that is typing waits. A window with no caret in the
 * block shows the card at once.
 */

/**
 * WordPress dependencies
 */
import { select, subscribe } from '@wordpress/data';
import { useEffect, useRef, useState } from '@wordpress/element';

/** How long the typing must be quiet before a held card appears. */
export const TYPING_QUIET_MS = 1200;

/**
 * The longest a card is held for someone who never pauses, counted from
 * the moment the conflict opened.
 */
export const TYPING_HOLD_MAX_MS = 20000;

interface BlockEditorReader {
	isTyping: () => boolean;
	getSelectedBlockClientId: () => string | null;
	getBlock: ( clientId: string ) => unknown;
	getBlockParents: ( clientId: string ) => string[];
}

let lastTypedAt = 0;
let typedIn: string[] = [];
let previousId: string | null = null;
let previousBlock: unknown;
let stopTracking: ( () => void ) | null = null;

/**
 * A registered store's selectors, narrowed to the slice this module reads
 * (`select` types a store named by string as an open record).
 *
 * @param name Store name.
 * @return The selectors, or undefined before the store is registered.
 */
function selectStore< Selectors >( name: string ): Selectors | undefined {
	return select( name ) as Selectors | undefined;
}

/**
 * Notes a keystroke: the selected block changed while the editor reports
 * typing. The block and its ancestors count as typed in, so a card on a
 * container waits for typing in any of its children.
 */
function observe(): void {
	const reader = selectStore< BlockEditorReader >( 'core/block-editor' );
	const id = reader?.getSelectedBlockClientId() ?? null;
	if ( ! reader || ! id ) {
		previousId = null;
		previousBlock = undefined;
		return;
	}

	const block = reader.getBlock( id );
	const changed = id === previousId && block !== previousBlock;
	previousId = id;
	previousBlock = block;

	if ( changed && reader.isTyping() ) {
		lastTypedAt = Date.now();
		typedIn = [ id, ...reader.getBlockParents( id ) ];
	}
}

/**
 * Starts watching the editor for typing. Idempotent.
 */
export function startTypingTracker(): void {
	if ( stopTracking ) {
		return;
	}
	stopTracking = subscribe( observe );
}

/**
 * Stops watching and forgets what was seen (tests).
 */
export function resetTypingTracker(): void {
	stopTracking?.();
	stopTracking = null;
	lastTypedAt = 0;
	typedIn = [];
	previousId = null;
	previousBlock = undefined;
}

/**
 * Milliseconds until the typing in a block counts as paused: 0 when
 * nobody typed in it within the quiet window.
 *
 * @param clientId The block's client id.
 * @param now      The current time.
 * @return The time left, in milliseconds.
 */
export function typingQuietIn( clientId: string, now: number ): number {
	if ( ! typedIn.includes( clientId ) ) {
		return 0;
	}
	return Math.max( 0, lastTypedAt + TYPING_QUIET_MS - now );
}

/**
 * Whether a block's review card should wait: true while the block has an
 * open record and the person is still typing in it, up to the cap.
 *
 * Once the card has appeared it stays until the record closes: the block
 * has no typing area under a card, so there is nothing left to wait for.
 *
 * @param clientId  The block's client id.
 * @param hasRecord Whether an open record targets the block.
 * @return Whether to keep the block's own edit UI for now.
 */
export function useTypingHold( clientId: string, hasRecord: boolean ): boolean {
	const openedAt = useRef< number | null >( null );
	const released = useRef( false );
	const [ , recheck ] = useState( 0 );

	if ( ! hasRecord ) {
		openedAt.current = null;
		released.current = false;
	} else if ( null === openedAt.current ) {
		openedAt.current = Date.now();
	}

	let wait = 0;
	if ( hasRecord && ! released.current && null !== openedAt.current ) {
		const now = Date.now();
		const capLeft = openedAt.current + TYPING_HOLD_MAX_MS - now;
		wait = Math.max(
			0,
			Math.min( typingQuietIn( clientId, now ), capLeft )
		);
		if ( 0 === wait ) {
			released.current = true;
		}
	}

	useEffect( () => {
		if ( wait <= 0 ) {
			return undefined;
		}
		const timer = setTimeout( () => recheck( ( n ) => n + 1 ), wait );
		return () => clearTimeout( timer );
	} );

	return wait > 0;
}
