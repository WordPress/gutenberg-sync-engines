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

describe( 'diffGridAgainstBase', () => {
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

		expect( mergedGridFromModel( model ) ).toEqual( {
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
		).toEqual( grid );
	} );

	it( 'reads a table without a header or a body as an empty grid', () => {
		expect( gridFromTableAttributes( {} ) ).toEqual( {
			head: [],
			rows: [],
		} );
		expect( gridFromTableAttributes( undefined ) ).toEqual( {
			head: [],
			rows: [],
		} );
	} );
} );
