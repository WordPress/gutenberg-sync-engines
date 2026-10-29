import { describe, expect, it } from '@jest/globals';
import {
	diffGridAgainstBase,
	gridFromTableAttributes,
	gridToTableAttributes,
	mergedGridFromModel,
	mergeTableGrids,
} from '../../../src/review/components/merge-table-grids';
import { TABLE_GRIDS } from './fixtures';

const { base, yours, current } = TABLE_GRIDS;

// A minimal grid for the targeted cases: one header label column ("Item")
// plus one data column, one row.
const tinyBase = {
	head: [ 'Item', 'A' ],
	rows: [ [ 'One', '1' ] ],
};

// A table that uses what a grid's labels and contents do not cover: a
// second header row, a footer, and cell attributes.
const STYLED_TABLE = {
	head: [
		{
			cells: [
				{ content: 'Plan', tag: 'th', scope: 'col' },
				{ content: 'Price', tag: 'th', scope: 'col', align: 'right' },
			],
		},
		{
			cells: [ { content: 'Per month', tag: 'th', colspan: '2' } ],
		},
	],
	body: [
		{
			cells: [
				{ content: 'Free', tag: 'th', scope: 'row' },
				{ content: '$0', tag: 'td', align: 'right' },
			],
		},
		{
			cells: [
				{ content: 'Pro', tag: 'th', scope: 'row' },
				{ content: '$12', tag: 'td', align: 'right' },
			],
		},
	],
	foot: [
		{
			cells: [
				{ content: 'Taxes not included', tag: 'td', colspan: '2' },
			],
		},
	],
};

describe( 'mergeTableGrids', () => {
	it( 'merges the pricing scenario end to end', () => {
		const model = mergeTableGrids( base, yours, current );

		// Structure: base columns and rows first, then each side's clean
		// addition (the Team column from yours, the API access row from
		// current).
		expect( model.columns.map( ( column ) => column.key ) ).toEqual( [
			'Plan',
			'Free',
			'Basic',
			'Pro',
			'Team',
		] );
		expect( model.columns[ 4 ].source ).toBe( 'yours' );
		expect( model.rows.map( ( row ) => row.key ) ).toEqual( [
			'Price',
			'Storage',
			'Support',
			'API access',
		] );
		expect( model.rows[ 3 ].source ).toBe( 'current' );

		// The one genuinely contested cell: Basic's price, changed by
		// both sides differently.
		expect( model.contested ).toEqual( [
			{
				rowKey: 'Price',
				columnKey: 'Basic',
				rowIndex: 0,
				columnIndex: 2,
				yourValue: '$6',
				currentValue: '$7',
			},
		] );
		expect( model.rows[ 0 ].cells[ 2 ] ).toEqual( {
			status: 'contested',
			value: '$7',
			yourValue: '$6',
			currentValue: '$7',
		} );

		// Cells reachable only through one side's addition take that
		// side's value.
		expect( model.rows[ 0 ].cells[ 4 ] ).toEqual( {
			status: 'yours',
			value: '$9',
		} );
		expect( model.rows[ 3 ].cells[ 1 ] ).toEqual( {
			status: 'current',
			value: 'No',
		} );

		// API access for Team exists in neither version: empty.
		expect( model.rows[ 3 ].cells[ 4 ] ).toEqual( {
			status: 'missing',
			value: '',
		} );

		// Untouched base cells read unchanged.
		expect( model.rows[ 1 ].cells[ 1 ] ).toEqual( {
			status: 'unchanged',
			value: '1 GB',
		} );
	} );

	it( 'takes a cell changed by one side only', () => {
		const changed = {
			head: [ 'Item', 'A' ],
			rows: [ [ 'One', '2' ] ],
		};

		const model = mergeTableGrids( tinyBase, changed, tinyBase );
		expect( model.rows[ 0 ].cells[ 1 ] ).toEqual( {
			status: 'yours',
			value: '2',
		} );
		expect( model.contested ).toEqual( [] );
	} );

	it( 'treats a convergent identical change as unchanged with the new value', () => {
		const changed = {
			head: [ 'Item', 'A' ],
			rows: [ [ 'One', '2' ] ],
		};

		const model = mergeTableGrids( tinyBase, changed, changed );
		expect( model.rows[ 0 ].cells[ 1 ] ).toEqual( {
			status: 'unchanged',
			value: '2',
		} );
		expect( model.contested ).toEqual( [] );
	} );

	it( 'defaults a contested cell to the current version and records it', () => {
		const yourChange = {
			head: [ 'Item', 'A' ],
			rows: [ [ 'One', '2' ] ],
		};
		const currentChange = {
			head: [ 'Item', 'A' ],
			rows: [ [ 'One', '3' ] ],
		};

		const model = mergeTableGrids( tinyBase, yourChange, currentChange );
		expect( model.rows[ 0 ].cells[ 1 ] ).toEqual( {
			status: 'contested',
			value: '3',
			yourValue: '2',
			currentValue: '3',
		} );
		expect( model.contested ).toHaveLength( 1 );
	} );

	it( 'carries an added row wholly from the side that added it', () => {
		const withRow = {
			head: [ 'Item', 'A' ],
			rows: [
				[ 'One', '1' ],
				[ 'Two', 'x' ],
			],
		};

		const model = mergeTableGrids( tinyBase, tinyBase, withRow );
		expect( model.rows[ 1 ].source ).toBe( 'current' );
		expect( model.rows[ 1 ].cells ).toEqual( [
			{ status: 'current', value: 'Two' },
			{ status: 'current', value: 'x' },
		] );
	} );

	it( 'carries an added column wholly from the side that added it', () => {
		const withColumn = {
			head: [ 'Item', 'A', 'B' ],
			rows: [ [ 'One', '1', 'b' ] ],
		};

		const model = mergeTableGrids( tinyBase, withColumn, tinyBase );
		expect( model.columns[ 2 ] ).toEqual( { key: 'B', source: 'yours' } );
		expect( model.rows[ 0 ].cells[ 2 ] ).toEqual( {
			status: 'yours',
			value: 'b',
		} );
	} );
} );

describe( 'mergeTableGrids without labels to line up by', () => {
	// A table as the editor inserts it: no header row.
	const headerless = ( rows ) => ( { head: [], rows } );

	it( 'merges a table with no header row by position and keeps every cell', () => {
		const baseGrid = headerless( [
			[ 'a', 'b', 'c' ],
			[ 'd', 'e', 'f' ],
		] );
		const changed = headerless( [
			[ 'a', 'b', 'c' ],
			[ 'd', 'E', 'f' ],
		] );

		const model = mergeTableGrids( baseGrid, changed, baseGrid );
		expect( model.columns ).toHaveLength( 3 );
		expect( model.rows ).toHaveLength( 2 );
		expect( model.head ).toEqual( [] );
		expect( model.rows[ 1 ].cells[ 1 ] ).toEqual( {
			status: 'yours',
			value: 'E',
		} );
		expect( model.contested ).toEqual( [] );
		expect( mergedGridFromModel( model ) ).toMatchObject( changed );
	} );

	it( 'merges both sides of a blank table, whose cells all look alike', () => {
		const blank = headerless( [
			[ '', '' ],
			[ '', '' ],
		] );
		const yourChange = headerless( [
			[ 'x', '' ],
			[ '', '' ],
		] );
		const currentChange = headerless( [
			[ '', '' ],
			[ '', 'y' ],
		] );

		const model = mergeTableGrids( blank, yourChange, currentChange );
		expect( mergedGridFromModel( model ) ).toMatchObject(
			headerless( [
				[ 'x', '' ],
				[ '', 'y' ],
			] )
		);
	} );

	it( 'marks a cell both sides changed as contested', () => {
		const baseGrid = headerless( [ [ 'a', 'b' ] ] );

		const model = mergeTableGrids(
			baseGrid,
			headerless( [ [ 'a', 'yours' ] ] ),
			headerless( [ [ 'a', 'theirs' ] ] )
		);
		expect( model.contested ).toHaveLength( 1 );
		expect( model.rows[ 0 ].cells[ 1 ] ).toMatchObject( {
			status: 'contested',
			value: 'theirs',
			yourValue: 'yours',
		} );
	} );

	it( 'carries a column one side added to a table with no header row', () => {
		const baseGrid = headerless( [ [ 'a', 'b' ] ] );

		const model = mergeTableGrids(
			baseGrid,
			headerless( [ [ 'a', 'b', 'c' ] ] ),
			baseGrid
		);
		expect( model.columns[ 2 ].source ).toBe( 'yours' );
		expect( mergedGridFromModel( model ).rows ).toEqual( [
			[ 'a', 'b', 'c' ],
		] );
	} );

	it( 'keeps a header row only your version added', () => {
		const baseGrid = headerless( [ [ 'a', 'b' ] ] );
		const withHeader = { head: [ 'X', 'Y' ], rows: [ [ 'a', 'b' ] ] };

		expect(
			mergedGridFromModel(
				mergeTableGrids( baseGrid, withHeader, baseGrid )
			)
		).toMatchObject( withHeader );
		// A header row the current version removed stays removed.
		expect(
			mergeTableGrids( withHeader, withHeader, baseGrid ).head
		).toEqual( [] );
	} );

	it( 'keeps both rows when a first cell repeats', () => {
		const baseGrid = {
			head: [ 'Day', 'Task' ],
			rows: [
				[ 'Mon', 'write' ],
				[ 'Mon', 'review' ],
			],
		};
		const changed = {
			head: [ 'Day', 'Task' ],
			rows: [
				[ 'Mon', 'write' ],
				[ 'Mon', 'ship' ],
			],
		};

		const model = mergeTableGrids( baseGrid, changed, baseGrid );
		expect( mergedGridFromModel( model ) ).toMatchObject( changed );
		// The columns still line up by their labels.
		expect( model.columns.map( ( column ) => column.key ) ).toEqual( [
			'Day',
			'Task',
		] );
	} );

	it( 'keeps both columns when a header label repeats', () => {
		const baseGrid = { head: [ '', '' ], rows: [ [ 'One', '1' ] ] };
		const changed = { head: [ '', '' ], rows: [ [ 'One', '2' ] ] };

		const model = mergeTableGrids( baseGrid, baseGrid, changed );
		expect( model.columns ).toHaveLength( 2 );
		expect( mergedGridFromModel( model ) ).toMatchObject( changed );
	} );

	it( 'treats a version with no table as unchanged', () => {
		const model = mergeTableGrids( tinyBase, headerless( [] ), tinyBase );

		expect( mergedGridFromModel( model ) ).toMatchObject( tinyBase );
	} );
} );

describe( 'diffGridAgainstBase', () => {
	it( 'marks only the changed cell of a table with no header row', () => {
		const diff = diffGridAgainstBase(
			{ head: [], rows: [ [ 'a', 'b' ] ] },
			{ head: [], rows: [ [ 'a', 'B' ] ] }
		);

		expect( diff.rows[ 0 ].cells ).toEqual( [
			{ status: 'unchanged', value: 'a' },
			{ status: 'changed', value: 'B' },
		] );
	} );

	it( 'marks added columns and changed cells for your version', () => {
		const diff = diffGridAgainstBase( base, yours );

		expect( diff.columns ).toEqual( [
			{ key: 'Plan', added: false },
			{ key: 'Free', added: false },
			{ key: 'Basic', added: false },
			{ key: 'Pro', added: false },
			{ key: 'Team', added: true },
		] );
		expect( diff.rows[ 0 ].cells[ 0 ].status ).toBe( 'unchanged' );
		expect( diff.rows[ 0 ].cells[ 2 ] ).toEqual( {
			status: 'changed',
			value: '$6',
		} );
		expect( diff.rows[ 0 ].cells[ 4 ] ).toEqual( {
			status: 'added',
			value: '$9',
		} );
	} );

	it( 'marks a whole added row for the current version', () => {
		const diff = diffGridAgainstBase( base, current );

		expect( diff.rows[ 3 ].added ).toBe( true );
		expect(
			diff.rows[ 3 ].cells.every( ( cell ) => 'added' === cell.status )
		).toBe( true );
	} );
} );

describe( 'mergedGridFromModel', () => {
	it( 'extracts the suggested merge as a plain grid', () => {
		const model = mergeTableGrids( base, yours, current );

		expect( mergedGridFromModel( model ) ).toMatchObject( {
			head: [ 'Plan', 'Free', 'Basic', 'Pro', 'Team' ],
			rows: [
				[ 'Price', '$0', '$7', '$12', '$9' ],
				[ 'Storage', '1 GB', '50 GB', '1 TB', '250 GB' ],
				[ 'Support', 'Email', 'Email', 'Priority', 'Priority' ],
				[ 'API access', 'No', 'Yes', 'Yes', '' ],
			],
		} );
	} );
} );

describe( 'gridToTableAttributes', () => {
	it( 'produces the core/table attribute shape: th head, td body', () => {
		expect(
			gridToTableAttributes( {
				head: [ 'Plan', 'Free' ],
				rows: [ [ 'Price', '$0' ] ],
			} )
		).toEqual( {
			head: [
				{
					cells: [
						{ content: 'Plan', tag: 'th' },
						{ content: 'Free', tag: 'th' },
					],
				},
			],
			body: [
				{
					cells: [
						{ content: 'Price', tag: 'td' },
						{ content: '$0', tag: 'td' },
					],
				},
			],
			foot: [],
		} );
	} );

	it( 'writes no header row for a grid without one', () => {
		expect(
			gridToTableAttributes( { head: [], rows: [ [ 'a', 'b' ] ] } )
		).toMatchObject( {
			head: [],
			body: [
				{
					cells: [
						{ content: 'a', tag: 'td' },
						{ content: 'b', tag: 'td' },
					],
				},
			],
		} );
	} );
} );

describe( 'gridFromTableAttributes', () => {
	it( 'reads the grid back out of the core/table attribute shape', () => {
		const grid = {
			head: [ 'Plan', 'Free' ],
			rows: [
				[ 'Price', '$0' ],
				[ 'Storage', '1 GB' ],
			],
		};
		expect(
			gridFromTableAttributes( gridToTableAttributes( grid ) )
		).toMatchObject( grid );
	} );

	it( 'reads a table without a header or a body as an empty grid', () => {
		expect( gridFromTableAttributes( {} ) ).toMatchObject( {
			head: [],
			rows: [],
		} );
		expect( gridFromTableAttributes( undefined ) ).toMatchObject( {
			head: [],
			rows: [],
		} );
	} );

	it( 'keeps the footer, further header rows, and cell attributes through a round trip', () => {
		expect(
			gridToTableAttributes( gridFromTableAttributes( STYLED_TABLE ) )
		).toEqual( STYLED_TABLE );
	} );

	it( 'reads a table with no header row as a grid with an empty head', () => {
		const { head, ...headerless } = STYLED_TABLE;
		const grid = gridFromTableAttributes( headerless );

		expect( grid.head ).toEqual( [] );
		expect( grid.rows ).toEqual( [
			[ 'Free', '$0' ],
			[ 'Pro', '$12' ],
		] );
		expect( gridToTableAttributes( grid ) ).toEqual( {
			...headerless,
			head: [],
		} );
	} );
} );

describe( 'the parts of a table the dialog does not show', () => {
	// The merged table, as attributes, from three versions as attributes.
	const mergedAttributes = ( baseTable, yourTable, currentTable ) =>
		gridToTableAttributes(
			mergedGridFromModel(
				mergeTableGrids(
					gridFromTableAttributes( baseTable ),
					gridFromTableAttributes( yourTable ),
					gridFromTableAttributes( currentTable )
				)
			)
		);

	// A copy of the styled table with one body cell replaced.
	const withBodyCell = ( rowIndex, columnIndex, cell ) => ( {
		...STYLED_TABLE,
		body: STYLED_TABLE.body.map( ( row, index ) => {
			if ( index !== rowIndex ) {
				return row;
			}

			const cells = [ ...row.cells ];
			cells[ columnIndex ] = { ...cells[ columnIndex ], ...cell };

			return { cells };
		} ),
	} );

	it( 'survive a merge that changes one cell', () => {
		const yourTable = withBodyCell( 0, 1, { content: '$1' } );

		expect(
			mergedAttributes( STYLED_TABLE, yourTable, STYLED_TABLE )
		).toEqual( yourTable );
	} );

	it( "merge each side's change: your text, their alignment, their footer", () => {
		const yourTable = withBodyCell( 1, 1, { content: '$15' } );
		const currentTable = {
			...withBodyCell( 1, 1, { align: 'center' } ),
			foot: [ { cells: [ { content: 'Prices in USD', tag: 'td' } ] } ],
		};

		const merged = mergedAttributes(
			STYLED_TABLE,
			yourTable,
			currentTable
		);
		expect( merged.body[ 1 ].cells[ 1 ] ).toEqual( {
			content: '$15',
			tag: 'td',
			align: 'center',
		} );
		expect( merged.foot ).toEqual( currentTable.foot );
		expect( merged.head ).toEqual( STYLED_TABLE.head );
	} );

	it( 'keep a footer only your version changed', () => {
		const yourTable = {
			...STYLED_TABLE,
			foot: [ { cells: [ { content: 'Yours', tag: 'td' } ] } ],
		};

		expect(
			mergedAttributes( STYLED_TABLE, yourTable, STYLED_TABLE ).foot
		).toEqual( yourTable.foot );
	} );
} );
