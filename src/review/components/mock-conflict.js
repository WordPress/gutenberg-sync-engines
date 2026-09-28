// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { diffWords } from 'diff';

/**
 * The fabricated conflict contents shown by the prototype review UI.
 *
 * The engines still detect and park real conflicts, and resolving the
 * dialog still settles the real parked items, but every conflict PRESENTS
 * as this pre-set scenario while the UI design is prototyped. Supplying
 * the real texts is the follow-up engine work.
 */
export const MOCK_CONFLICT = {
	baseText: 'paragraph',
	yourText: 'paragraph - adding something new',
	currentText: 'This is my paragraph.',
};

/**
 * Word-diff parts from the mock conflict's current version to your
 * version, for the block preview's add/remove highlighting. Deliberately
 * whitespace-INSENSITIVE: with the shared spaces treated as significant,
 * this version-to-version diff degrades into an unreadable word-by-word
 * interleave. The dialog's panes diff each version against the shared
 * base instead, where the whitespace-sensitive form stays clean.
 *
 * @return {Array} diff change objects.
 */
export function mockConflictParts() {
	return diffWords( MOCK_CONFLICT.currentText, MOCK_CONFLICT.yourText );
}
