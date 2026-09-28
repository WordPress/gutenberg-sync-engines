// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { diffWords } from 'diff';

/**
 * A version's text as one serialized paragraph block.
 *
 * @param {string} text The paragraph text.
 * @return {string} The serialized paragraph.
 */
function paragraph( text ) {
	return `<!-- wp:paragraph -->\n<p>${ text }</p>\n<!-- /wp:paragraph -->`;
}

const HEADING =
	'<!-- wp:heading -->\n<h2 class="wp-block-heading">Release notes</h2>\n<!-- /wp:heading -->';

/**
 * The fabricated section conflict shown by the prototype review UI: a
 * split-vs-edit scenario, where the two sides no longer agree on the
 * block structure itself. Both versions started from a heading and one
 * two-sentence paragraph. Your version SPLIT the paragraph at the
 * sentence boundary, moved the date to May, and extended the new second
 * paragraph with a sign-up call; the current version changed the same
 * date to April in place. The contested sentence lives in a different
 * block on each side and the two dates cannot both win, so no per-block
 * resolution exists and the whole section is reviewed at once.
 *
 * The engines still detect and park real conflicts, and resolving the
 * dialog still settles the real parked items, but every section
 * conflict PRESENTS as this pre-set scenario while the UI design is
 * prototyped. Supplying the real serialized versions is the follow-up
 * engine work; each version here is already the serialized multi-block
 * content that work would hand over.
 *
 * This file is the one place to edit to change the demo scenario. If
 * you do, keep the paragraph's FIRST sentence carrying clearly more
 * words than the second: the revisions differ pairs the base paragraph
 * with whichever split half shares more than half of its words, and
 * that pairing is what makes the split read as "modified paragraph plus
 * added paragraph" instead of noise.
 */
export const MOCK_SECTION_CONFLICT = {
	base: [
		HEADING,
		paragraph(
			'The new dashboard brings every project into one shared view. Early access opens in March.'
		),
	].join( '\n\n' ),
	yours: [
		HEADING,
		paragraph(
			'The new dashboard brings every project into one shared view.'
		),
		paragraph( 'Early access opens in May. Sign up now.' ),
	].join( '\n\n' ),
	current: [
		HEADING,
		paragraph(
			'The new dashboard brings every project into one shared view. Early access opens in April.'
		),
	].join( '\n\n' ),
};

/**
 * A serialized version's readable text, for the card preview: block
 * delimiters and tags stripped, whitespace collapsed.
 *
 * @param {string} content Serialized block content.
 * @return {string} The plain text.
 */
function plainText( content ) {
	return content
		.replace( /<!--[\s\S]*?-->/g, ' ' )
		.replace( /<[^>]+>/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim();
}

/**
 * Word-diff parts from the mock section conflict's current version to
 * your version, for the block preview's add/remove highlighting. Same
 * deliberately whitespace-INSENSITIVE version-to-version diff as the
 * paragraph card preview (see mock-conflict.js); the dialog's panes
 * diff each version against the shared base instead.
 *
 * @return {Array} diff change objects.
 */
export function mockSectionConflictParts() {
	return diffWords(
		plainText( MOCK_SECTION_CONFLICT.current ),
		plainText( MOCK_SECTION_CONFLICT.yours )
	);
}
