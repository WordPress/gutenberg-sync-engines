// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
/**
 * The fabricated table conflict shown by the prototype review UI.
 *
 * The engines still detect and park real conflicts on table blocks, and
 * resolving the dialog still settles the real parked items, but every
 * table conflict PRESENTS as this pre-set pricing scenario while the UI
 * design is prototyped. Supplying the real grids is the follow-up engine
 * work.
 *
 * A grid is `{ head, rows }`: `head` holds the header row's labels, and
 * each row's cell 0 is its label. Plain strings only. This file is the
 * one place to edit to change the demo scenario. The scenario is chosen
 * to produce one contested cell (Basic's price, changed by both sides
 * differently), one clean structural addition per side (the Team column,
 * the API access row), and one cell existing in neither version (API
 * access for Team).
 */
export const MOCK_TABLE_CONFLICT = {
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
