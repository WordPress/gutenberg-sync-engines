/**
 * The post each host benchmark run starts from, and the text it must end
 * with. Two variables live here:
 *
 *   post size  how much is already in the post when people start typing
 *              (empty: only one paragraph per person; medium: about 20
 *              blocks; large: about 200 blocks), so the cost of engines
 *              whose work grows with the document shows up.
 *   pattern    what each person does with their typing script
 *              (own-paragraph: append every word to their own paragraph;
 *              new-blocks: start a new paragraph for every burst of
 *              words, right after the last one they wrote).
 *
 * Both are plain functions of their inputs so the baseline phase, the
 * sync phase, and the content check all agree on the same document.
 * A "same paragraph" pattern is deliberately absent: concurrent typing
 * into one paragraph is where engines set some keystrokes aside for
 * review on purpose, so "every editor holds the same fixed text" cannot
 * be the success check for it.
 */

import { editingScript } from './measurement.mjs';
import { seededRandom } from './record.mjs';

export const POST_SIZES = [ 'empty', 'medium', 'large' ];
export const PATTERNS = [ 'own-paragraph', 'new-blocks' ];

// Filler units per size. One unit is a heading, two paragraphs, a list of
// three items, and a group holding two paragraphs: 10 blocks, inner
// blocks included.
const UNITS = { empty: 0, medium: 2, large: 20 };

const WORDS = (
	'alpha bravo cedar delta ember fjord glacier harbor island juniper ' +
	'kettle lantern meadow nectar orchard pebble quarry river summit ' +
	'timber upland valley willow yonder zephyr amber basin canyon dune ' +
	'estuary forest grove hollow inlet jetty knoll ledge marsh'
).split( ' ' );

/**
 * Deterministic filler sentence. Never contains an anchor or a typed
 * token (those carry digits; filler never does).
 *
 * @param {number} seed  Position-derived seed.
 * @param {number} words Word count.
 * @return {string} Text.
 */
function filler( seed, words ) {
	const random = seededRandom( seed + 1 );
	const out = [];
	for ( let i = 0; i < words; i++ ) {
		out.push( WORDS[ Math.floor( random() * WORDS.length ) ] );
	}
	const text = out.join( ' ' );
	return text.charAt( 0 ).toUpperCase() + text.slice( 1 ) + '.';
}

const paragraph = ( text ) =>
	`<!-- wp:paragraph --><p>${ text }</p><!-- /wp:paragraph -->`;

/**
 * One filler unit: its markup and its text items in document order.
 *
 * @param {number} unit Unit index.
 * @return {{ markup: string, texts: Array<string>, blocks: number }} Unit.
 */
function fillerUnit( unit ) {
	const seed = unit * 10;
	const heading = filler( seed, 4 ).replace( /\.$/, '' );
	const p1 = filler( seed + 1, 40 );
	const p2 = filler( seed + 2, 40 );
	const items = [ 3, 4, 5 ].map( ( n ) =>
		filler( seed + n, 5 ).replace( /\.$/, '' )
	);
	const g1 = filler( seed + 6, 30 );
	const g2 = filler( seed + 7, 30 );
	const markup = [
		`<!-- wp:heading --><h2 class="wp-block-heading">${ heading }</h2><!-- /wp:heading -->`,
		paragraph( p1 ),
		paragraph( p2 ),
		'<!-- wp:list --><ul class="wp-block-list">' +
			items
				.map(
					( item ) =>
						`<!-- wp:list-item --><li>${ item }</li><!-- /wp:list-item -->`
				)
				.join( '' ) +
			'</ul><!-- /wp:list -->',
		'<!-- wp:group {"layout":{"type":"constrained"}} --><div class="wp-block-group">' +
			paragraph( g1 ) +
			paragraph( g2 ) +
			'</div><!-- /wp:group -->',
	].join( '\n' );
	return {
		markup,
		texts: [ heading, p1, p2, ...items, g1, g2 ],
		blocks: 10,
	};
}

/**
 * The anchor paragraph a person types into (or after).
 *
 * @param {number} index Window index.
 * @return {string} Anchor text.
 */
export const anchorText = ( index ) => `hostw${ index }anchor`;

/**
 * The starting post: filler units with each person's anchor paragraph
 * spread evenly through them (all anchors first when the post is empty).
 *
 * @param {number} windows People.
 * @param {string} size    One of POST_SIZES.
 * @return {{ items: Array<Object>, content: string, blocks: number, bytes: number }}
 *     Ordered items ({ filler: unit } or { anchor: index }) and the markup.
 */
export function postFixture( windows, size ) {
	if ( ! POST_SIZES.includes( size ) ) {
		throw new Error(
			`post-size must be one of ${ POST_SIZES.join(
				', '
			) } (got ${ size })`
		);
	}
	const units = UNITS[ size ];
	const items = [];
	let nextUnit = 0;
	for ( let index = 0; index < windows; index++ ) {
		// Units before anchor `index`: an even share, so anchors sit at
		// the start, middle, and end of a long post — not all on screen.
		const before = Math.round( ( units * index ) / windows );
		for ( ; nextUnit < before; nextUnit++ ) {
			items.push( { filler: nextUnit } );
		}
		items.push( { anchor: index } );
	}
	for ( ; nextUnit < units; nextUnit++ ) {
		items.push( { filler: nextUnit } );
	}
	const content = items
		.map( ( item ) =>
			undefined !== item.anchor
				? paragraph( anchorText( item.anchor ) )
				: fillerUnit( item.filler ).markup
		)
		.join( '\n' );
	return {
		items,
		content,
		blocks: windows + units * 10,
		bytes: Buffer.byteLength( content, 'utf8' ),
	};
}

/**
 * Splits a typing script into bursts (the words typed without a pause).
 *
 * @param {Array<Object>} script editingScript output.
 * @return {Array<Array<Object>>} Bursts of tokens.
 */
export function bursts( script ) {
	const out = [];
	for ( const token of script ) {
		if ( ! out[ token.burst ] ) {
			out[ token.burst ] = [];
		}
		out[ token.burst ].push( token );
	}
	return out.filter( Boolean );
}

/**
 * The text every editor and the saved post must hold once `authors`
 * people (windows 0..authors-1) have finished their scripts: every
 * paragraph, heading, and list item, in document order.
 *
 * @param {Object} options
 * @param {number} options.windows     People.
 * @param {string} options.size        Post size.
 * @param {string} options.pattern     One of PATTERNS.
 * @param {number} options.editSeconds Script duration per person.
 * @param {number} options.authors     People who have typed.
 * @return {Array<string>} Expected texts.
 */
export function expectedTexts( {
	windows,
	size,
	pattern,
	editSeconds,
	authors,
} ) {
	if ( ! PATTERNS.includes( pattern ) ) {
		throw new Error(
			`pattern must be one of ${ PATTERNS.join(
				', '
			) } (got ${ pattern })`
		);
	}
	const texts = [];
	for ( const item of postFixture( windows, size ).items ) {
		if ( undefined !== item.filler ) {
			texts.push( ...fillerUnit( item.filler ).texts );
			continue;
		}
		const index = item.anchor;
		const script =
			index < authors ? editingScript( index, editSeconds * 1000 ) : [];
		const join = ( tokens ) =>
			tokens
				.map( ( token ) => token.text )
				.join( '' )
				.trim();
		if ( 'own-paragraph' === pattern ) {
			texts.push( `${ anchorText( index ) } ${ join( script ) }`.trim() );
		} else {
			texts.push( anchorText( index ) );
			for ( const burst of bursts( script ) ) {
				texts.push( join( burst ) );
			}
		}
	}
	return texts;
}
