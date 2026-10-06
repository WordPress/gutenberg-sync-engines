/**
 * Conflict records for the review components' tests: the scenarios the UI
 * was designed against, in the shape an engine publishes them (every side
 * serialized block content).
 */

/**
 * A version's text as one serialized paragraph block.
 *
 * @param {string} text The paragraph text.
 * @return {string} The serialized paragraph.
 */
export const paragraph = ( text ) =>
	`<!-- wp:paragraph -->\n<p>${ text }</p>\n<!-- /wp:paragraph -->`;

const HEADING =
	'<!-- wp:heading -->\n<h2 class="wp-block-heading">Release notes</h2>\n<!-- /wp:heading -->';

const record = ( sides, overrides = {} ) => ( {
	id: 'c1',
	kind: 'merge',
	authorId: 7,
	target: { type: 'blocks', ids: [ 'b1' ], index: 0, count: 1 },
	...sides,
	...overrides,
} );

/** One paragraph both sides rewrote. */
export const PARAGRAPH_CONFLICT = record( {
	base: paragraph( 'paragraph' ),
	proposed: paragraph( 'paragraph - adding something new' ),
	current: paragraph( 'This is my paragraph.' ),
} );

/**
 * A split-vs-edit section: both versions started from a heading and one
 * two-sentence paragraph. The proposed version SPLIT the paragraph at the
 * sentence boundary, moved the date to May, and extended the new second
 * paragraph. The current version changed the same date to April in place.
 *
 * Keep the paragraph's FIRST sentence carrying clearly more words than
 * the second: the revisions differ pairs the base paragraph with
 * whichever split half shares more than half of its words, and that
 * pairing is what makes the split read as "modified paragraph plus added
 * paragraph" instead of noise.
 */
export const SECTION_CONFLICT = record(
	{
		base: [
			HEADING,
			paragraph(
				'The new dashboard brings every project into one shared view. Early access opens in March.'
			),
		].join( '\n\n' ),
		proposed: [
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
	},
	{ target: { type: 'blocks', ids: [ 'h', 'p' ], index: 0, count: 2 } }
);

/**
 * A pricing table as grids (`head` holds the header row's labels, each
 * row's cell 0 is its label): one contested cell (Basic's price, changed
 * by both sides differently), one clean structural addition per side (the
 * Team column, the API access row), and one cell existing in neither
 * version (API access for Team).
 */
export const TABLE_GRIDS = {
	base: {
		head: [ 'Plan', 'Free', 'Basic', 'Pro' ],
		rows: [
			[ 'Price', '$0', '$5', '$12' ],
			[ 'Storage', '1 GB', '50 GB', '1 TB' ],
			[ 'Support', 'Email', 'Email', 'Priority' ],
		],
	},
	yours: {
		head: [ 'Plan', 'Free', 'Basic', 'Pro', 'Team' ],
		rows: [
			[ 'Price', '$0', '$6', '$12', '$9' ],
			[ 'Storage', '1 GB', '50 GB', '1 TB', '250 GB' ],
			[ 'Support', 'Email', 'Email', 'Priority', 'Priority' ],
		],
	},
	current: {
		head: [ 'Plan', 'Free', 'Basic', 'Pro' ],
		rows: [
			[ 'Price', '$0', '$7', '$12' ],
			[ 'Storage', '1 GB', '50 GB', '1 TB' ],
			[ 'Support', 'Email', 'Email', 'Priority' ],
			[ 'API access', 'No', 'Yes', 'Yes' ],
		],
	},
};

/**
 * A grid as a serialized table block.
 *
 * @param {Object} grid A `{ head, rows }` grid.
 * @return {string} The serialized table.
 */
export const table = ( grid ) => {
	const row = ( cells, tag ) =>
		`<tr>${ cells
			.map( ( cell ) => `<${ tag }>${ cell }</${ tag }>` )
			.join( '' ) }</tr>`;

	return (
		'<!-- wp:table {"metadata":{"syncId":"t1"}} -->\n' +
		`<figure class="wp-block-table"><table class="has-fixed-layout"><thead>${ row(
			grid.head,
			'th'
		) }</thead><tbody>${ grid.rows
			.map( ( cells ) => row( cells, 'td' ) )
			.join( '' ) }</tbody></table></figure>\n` +
		'<!-- /wp:table -->'
	);
};

/** The pricing table as a record. */
export const TABLE_CONFLICT = record(
	{
		base: table( TABLE_GRIDS.base ),
		proposed: table( TABLE_GRIDS.yours ),
		current: table( TABLE_GRIDS.current ),
	},
	{ target: { type: 'blocks', ids: [ 't1' ], index: 0, count: 1 } }
);

/** A brand-new block held for approval: nothing to compare against. */
export const KSES_NEW = {
	kind: 'new',
	original: '',
	proposed: `<!-- wp:html -->
<script>alert(0);</script>
<!-- /wp:html -->`,
};

/** A held change to an existing block. */
export const KSES_UPDATE = {
	kind: 'update',
	original: `<!-- wp:html -->
<script data-wp-block-html="js">
alert(0);
</script>
<!-- /wp:html -->`,
	proposed: `<!-- wp:html -->
<script data-wp-block-html="js">
alert('changed');
</script>
<!-- /wp:html -->`,
};
