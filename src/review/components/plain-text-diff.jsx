// @ts-nocheck -- Matches the prototype JavaScript beside it; typing the review components (TSX) is a later pass.
import { diffLines, diffWords } from 'diff';
import { useMemo } from '@wordpress/element';
import DiffText from './diff-text';

/**
 * A side's readable text with one line per block: block delimiters become
 * line breaks, tags are stripped, and the whitespace inside a line is
 * collapsed. A section of several blocks then reads as several lines
 * instead of one run of text.
 *
 * @param {?string} content Serialized block content.
 * @return {string} The text, one line per block.
 */
export function textByBlock( content ) {
	return String( content ?? '' )
		.replace( /<!--[\s\S]*?-->/g, '\n' )
		.replace( /<[^>]+>/g, ' ' )
		.split( '\n' )
		.map( ( line ) => line.replace( /\s+/g, ' ' ).trim() )
		.filter( Boolean )
		.join( '\n' );
}

/**
 * Ends the text with a line break when it has text and no final break.
 * The line comparison treats "a" and "a" plus a break as two different
 * lines, so a last line that did not change would read as changed.
 *
 * @param {?string} text The text.
 * @return {string} The text with a final line break.
 */
function withFinalLineBreak( text ) {
	const value = String( text ?? '' );
	if ( '' === value || value.endsWith( '\n' ) ) {
		return value;
	}

	return value + '\n';
}

/**
 * The comparison the review dialogs fall back to when the editor does not
 * export its revision comparison (a standalone Gutenberg without the
 * bundled copy's addition, see revisions-diff.ts): the change from one
 * text to another, with additions and removals marked.
 *
 * Everything renders as text, never as live DOM, so it is safe for markup
 * that has not been trusted.
 *
 * @param {Object}  props
 * @param {?string} props.from   The text to compare against.
 * @param {?string} props.to     The text to show.
 * @param {boolean} props.isCode Whether the texts are markup: compared
 *                               line by line and shown in a fixed-width
 *                               font. Prose is compared word by word.
 */
export default function PlainTextDiff( { from, to, isCode = false } ) {
	const parts = useMemo( () => {
		if ( isCode ) {
			return diffLines(
				withFinalLineBreak( from ),
				withFinalLineBreak( to )
			);
		}

		return diffWords( String( from ?? '' ), String( to ?? '' ) );
	}, [ from, to, isCode ] );

	let className = 'gse-review-plain-diff';
	if ( isCode ) {
		className += ' gse-review-plain-diff--code';
	}

	return (
		<pre className={ className }>
			<DiffText parts={ parts } />
		</pre>
	);
}
