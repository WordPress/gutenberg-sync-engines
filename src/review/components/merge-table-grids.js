// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
/**
 * The pure three-way merge behind the table conflict dialog. No React and
 * no stores, so it is unit-testable on its own.
 *
 * A grid is `{ head: string[], rows: string[][] }`: `head` holds the
 * header row's labels (empty when the table has no header row) and
 * `rows` the body's cell contents. A grid read from a table block also
 * carries the parts the dialog does not show, so that they survive the
 * merge: `cellAttributes` (each cell's other attributes, in the same
 * `{ head, rows }` shape), `extraHead` (header rows after the first),
 * and `foot`.
 *
 * Alignment is BY LABEL while the labels can carry it: columns are keyed
 * by their header text, rows by their first cell. When they cannot (a
 * version has no header row, a label repeats, a row is wider than the
 * header) the grids line up BY POSITION instead, so every cell still has
 * a place in the merge. Either way this is a deliberate prototype
 * simplification: renamed, reordered, and deleted rows and columns are
 * not modeled.
 */

/**
 * A grid's row labels, in row order.
 *
 * @param {Object} grid A grid.
 * @return {string[]} The label (cell 0) of each row.
 */
function rowLabels( grid ) {
	return grid.rows.map( ( cells ) => cells[ 0 ] );
}

/**
 * The union of three key lists as ordered entries: base keys first, in
 * base order, then keys only your version adds, then keys only the
 * current version adds.
 *
 * @param {string[]} baseKeys    The base version's keys.
 * @param {string[]} yourKeys    Your version's keys.
 * @param {string[]} currentKeys The current version's keys.
 * @return {Array} `{ key, source }` entries; source is 'base', 'yours',
 *                 or 'current' by where the key first appears.
 */
function mergeKeys( baseKeys, yourKeys, currentKeys ) {
	const entries = baseKeys.map( ( key ) => ( { key, source: 'base' } ) );
	const seen = new Set( baseKeys );

	for ( const [ source, keys ] of [
		[ 'yours', yourKeys ],
		[ 'current', currentKeys ],
	] ) {
		for ( const key of keys ) {
			if ( ! seen.has( key ) ) {
				seen.add( key );
				entries.push( { key, source } );
			}
		}
	}

	return entries;
}

/**
 * Whether a list of keys holds the same key twice.
 *
 * @param {string[]} keys The keys.
 * @return {boolean} Whether a key repeats.
 */
function hasDuplicates( keys ) {
	return new Set( keys ).size !== keys.length;
}

/**
 * Whether a grid holds no table at all: no header row and no body row.
 *
 * @param {Object} grid A grid.
 * @return {boolean} Whether the grid is empty.
 */
function isEmptyGrid( grid ) {
	return 0 === grid.head.length && 0 === grid.rows.length;
}

/**
 * The number of columns a grid spans: its widest row, the header included.
 *
 * @param {Object} grid A grid.
 * @return {number} The column count.
 */
function columnCount( grid ) {
	return Math.max(
		grid.head.length,
		...grid.rows.map( ( cells ) => cells.length )
	);
}

/**
 * One grid with its row and column keys, and lookups by those keys;
 * every lookup is undefined when the grid has no such row or column.
 *
 * @param {Object}   grid       A grid.
 * @param {string[]} columnKeys The key of each column, in column order.
 * @param {string[]} rowKeys    The key of each row, in row order.
 * @return {Object} `{ columnKeys, rowKeys, value, attributes, label,
 *                  labelAttributes }`.
 */
function keyedGrid( grid, columnKeys, rowKeys ) {
	const columnIndexes = new Map(
		columnKeys.map( ( key, index ) => [ key, index ] )
	);
	const rowIndexes = new Map(
		rowKeys.map( ( key, index ) => [ key, index ] )
	);
	const cellOf = ( rows, rowKey, columnKey ) =>
		rows?.[ rowIndexes.get( rowKey ) ]?.[ columnIndexes.get( columnKey ) ];

	return {
		columnKeys,
		rowKeys,
		value: ( rowKey, columnKey ) => cellOf( grid.rows, rowKey, columnKey ),
		attributes: ( rowKey, columnKey ) =>
			cellOf( grid.cellAttributes?.rows, rowKey, columnKey ),
		label: ( columnKey ) => grid.head[ columnIndexes.get( columnKey ) ],
		labelAttributes: ( columnKey ) =>
			grid.cellAttributes?.head?.[ columnIndexes.get( columnKey ) ],
	};
}

/**
 * Lines a set of grids up with each other: decides, for all of them
 * together, whether columns and rows are keyed by label or by position,
 * and returns each grid keyed that way.
 *
 * Labels are the better key: a row or a column added in the middle does
 * not shift the ones after it. They only work while they are unique and
 * present on every side:
 * - A table with no header row has no column labels, and its first
 *   column is ordinary content, so both its columns and its rows line up
 *   by position.
 * - A repeated header label, or a body row wider than the header, would
 *   fold columns into one another: columns line up by position.
 * - A repeated first cell (empty cells included) would fold rows into
 *   one another: rows line up by position.
 *
 * A grid with no table in it has no say.
 *
 * @param {Object[]} grids The grids to line up.
 * @return {Object[]} A keyed grid (see keyedGrid) for each.
 */
function alignGrids( grids ) {
	const tables = grids.filter( ( grid ) => ! isEmptyGrid( grid ) );
	const isHeaderless = tables.some( ( grid ) => 0 === grid.head.length );
	const columnsByPosition =
		isHeaderless ||
		tables.some(
			( grid ) =>
				hasDuplicates( grid.head ) ||
				columnCount( grid ) > grid.head.length
		);
	const rowsByPosition =
		isHeaderless ||
		tables.some( ( grid ) => hasDuplicates( rowLabels( grid ) ) );

	return grids.map( ( grid ) => {
		let columnKeys = grid.head;
		if ( columnsByPosition ) {
			columnKeys = Array.from(
				{ length: columnCount( grid ) },
				( _, index ) => `col-${ index }`
			);
		}

		let rowKeys = rowLabels( grid );
		if ( rowsByPosition ) {
			rowKeys = grid.rows.map( ( _, index ) => `row-${ index }` );
		}

		return keyedGrid( grid, columnKeys, rowKeys );
	} );
}

/**
 * A three-way choice for a value the dialog does not show: your
 * version's when only your version changed it, else the current
 * version's. The same rule the cells follow, a clash going to the
 * current version.
 *
 * @param {*} base    The value in the shared base.
 * @param {*} yours   The value in your version.
 * @param {*} current The value in the current version.
 * @return {*} The value to keep.
 */
function pickSide( base, yours, current ) {
	const baseJson = JSON.stringify( base );

	if (
		JSON.stringify( yours ) !== baseJson &&
		JSON.stringify( current ) === baseJson
	) {
		return yours;
	}

	return current;
}

/**
 * Merges two versions of a table grid against the shared base they both
 * started from, into the model the table dialog renders and seeds from.
 *
 * Per (rowKey, columnKey) cell, against the base:
 * - Only reachable through a row or column one side added: that side's
 *   status and value.
 * - Row and column added by DIFFERENT sides (the cell exists in neither
 *   version): 'missing', with an empty value.
 * - Present in base and untouched, or changed by both sides to the SAME
 *   value (a convergent edit needs no decision): 'unchanged'.
 * - Changed by exactly one side: that side's status and value.
 * - Changed by both sides differently: 'contested'; the suggested value
 *   defaults to the current version's, consistent with the paragraph
 *   dialog seeding from current.
 *
 * What the dialog does not show merges whole, by the pickSide rule: each
 * cell's other attributes, whether the table has a header row, the header
 * rows after the first, and the footer. A version with no table in it
 * counts as unchanged.
 *
 * @param {Object} base    The shared base grid.
 * @param {Object} yours   Your version's grid.
 * @param {Object} current The current version's grid.
 * @return {Object} `{ columns, rows, contested, head, headAttributes,
 *                  extraHead, foot }`: `columns` are `{ key, source }`
 *                  entries, `rows` add a `cells` array of
 *                  `{ status, value, attributes }` (contested cells also
 *                  carry `yourValue`/`currentValue`), `contested` lists
 *                  each contested cell with its model indices, and `head`
 *                  holds the merged header label of each column (empty
 *                  when the merged table has no header row).
 */
export function mergeTableGrids( base, yours, current ) {
	let yourGrid = yours;
	if ( isEmptyGrid( yourGrid ) ) {
		yourGrid = base;
	}

	let currentGrid = current;
	if ( isEmptyGrid( currentGrid ) ) {
		currentGrid = base;
	}

	const [ inBase, inYours, inCurrent ] = alignGrids( [
		base,
		yourGrid,
		currentGrid,
	] );
	const columns = mergeKeys(
		inBase.columnKeys,
		inYours.columnKeys,
		inCurrent.columnKeys
	);
	const rowEntries = mergeKeys(
		inBase.rowKeys,
		inYours.rowKeys,
		inCurrent.rowKeys
	);

	const contested = [];

	const rows = rowEntries.map(
		( { key: rowKey, source: rowSource }, rowIndex ) => {
			const cells = columns.map(
				( { key: columnKey, source: columnSource }, columnIndex ) => {
					if ( 'base' !== rowSource || 'base' !== columnSource ) {
						const sides = new Set( [ rowSource, columnSource ] );
						sides.delete( 'base' );

						// Row and column added by different sides: the cell
						// exists in neither version, so it lands in the
						// merged grid empty and editable.
						if ( sides.size > 1 ) {
							return { status: 'missing', value: '' };
						}

						const [ side ] = sides;
						let from = inCurrent;
						if ( 'yours' === side ) {
							from = inYours;
						}

						return {
							status: side,
							value: from.value( rowKey, columnKey ) ?? '',
							attributes: from.attributes( rowKey, columnKey ),
						};
					}

					const baseValue = inBase.value( rowKey, columnKey ) ?? '';
					const yourValue =
						inYours.value( rowKey, columnKey ) ?? baseValue;
					const currentValue =
						inCurrent.value( rowKey, columnKey ) ?? baseValue;
					const yoursChanged = yourValue !== baseValue;
					const currentChanged = currentValue !== baseValue;
					const baseAttributes = inBase.attributes(
						rowKey,
						columnKey
					);
					const attributes = pickSide(
						baseAttributes,
						inYours.attributes( rowKey, columnKey ) ??
							baseAttributes,
						inCurrent.attributes( rowKey, columnKey ) ??
							baseAttributes
					);

					if (
						yoursChanged &&
						currentChanged &&
						yourValue !== currentValue
					) {
						contested.push( {
							rowKey,
							columnKey,
							rowIndex,
							columnIndex,
							yourValue,
							currentValue,
						} );

						return {
							status: 'contested',
							value: currentValue,
							attributes,
							yourValue,
							currentValue,
						};
					}

					if ( yoursChanged && ! currentChanged ) {
						return {
							status: 'yours',
							value: yourValue,
							attributes,
						};
					}

					if ( currentChanged && ! yoursChanged ) {
						return {
							status: 'current',
							value: currentValue,
							attributes,
						};
					}

					// Untouched, or a convergent identical change.
					return {
						status: 'unchanged',
						value: currentValue,
						attributes,
					};
				}
			);

			return { key: rowKey, source: rowSource, cells };
		}
	);

	// The header row: there when the current version has one, or when only
	// your version added one. Its labels merge like any other cell. Keyed
	// by label, a column's label is its key on every side that has it.
	let head = [];
	let headAttributes = [];
	const hasHead = pickSide(
		base.head.length > 0,
		yourGrid.head.length > 0,
		currentGrid.head.length > 0
	);
	if ( hasHead ) {
		head = columns.map( ( { key } ) => {
			const baseLabel = inBase.label( key );

			return (
				pickSide(
					baseLabel,
					inYours.label( key ) ?? baseLabel,
					inCurrent.label( key ) ?? baseLabel
				) ?? ''
			);
		} );
		headAttributes = columns.map( ( { key } ) => {
			const baseAttributes = inBase.labelAttributes( key );

			return pickSide(
				baseAttributes,
				inYours.labelAttributes( key ) ?? baseAttributes,
				inCurrent.labelAttributes( key ) ?? baseAttributes
			);
		} );
	}

	return {
		columns,
		rows,
		contested,
		head,
		headAttributes,
		extraHead: pickSide(
			base.extraHead,
			yourGrid.extraHead,
			currentGrid.extraHead
		),
		foot: pickSide( base.foot, yourGrid.foot, currentGrid.foot ),
	};
}

/**
 * Diffs one version's grid against the base it started from, for the
 * dialog panes: the version's own rows and columns, each cell marked
 * 'unchanged', 'added' (reachable only through an added row or column),
 * or 'changed'.
 *
 * @param {Object} base    The shared base grid.
 * @param {Object} version The version's grid.
 * @return {Object} `{ columns, rows }`: `columns` are `{ key, added }`
 *                  entries, `rows` are `{ key, added, cells }` with
 *                  `cells` an array of `{ status, value }`.
 */
export function diffGridAgainstBase( base, version ) {
	const [ inBase, inVersion ] = alignGrids( [ base, version ] );
	const baseColumns = new Set( inBase.columnKeys );
	const baseRows = new Set( inBase.rowKeys );

	const columns = inVersion.columnKeys.map( ( key ) => ( {
		key,
		added: ! baseColumns.has( key ),
	} ) );

	const rows = version.rows.map( ( cells, rowIndex ) => {
		const rowKey = inVersion.rowKeys[ rowIndex ];
		const added = ! baseRows.has( rowKey );

		return {
			key: rowKey,
			added,
			cells: cells.map( ( value, index ) => {
				if ( added || columns[ index ]?.added ) {
					return { status: 'added', value };
				}

				if (
					value !==
					( inBase.value( rowKey, inVersion.columnKeys[ index ] ) ??
						'' )
				) {
					return { status: 'changed', value };
				}

				return { status: 'unchanged', value };
			} ),
		};
	} );

	return { columns, rows };
}

/**
 * The suggested merge as a grid, extracted from a merged model: the shape
 * restores and reseeds work with.
 *
 * @param {Object} model A model from mergeTableGrids.
 * @return {Object} The grid of the suggested values, with the parts the
 *                  merge carried through.
 */
export function mergedGridFromModel( model ) {
	return {
		head: model.head,
		rows: model.rows.map( ( row ) =>
			row.cells.map( ( cell ) => cell.value )
		),
		cellAttributes: {
			head: model.headAttributes,
			rows: model.rows.map( ( row ) =>
				row.cells.map( ( cell ) => cell.attributes )
			),
		},
		extraHead: model.extraHead,
		foot: model.foot,
	};
}

/**
 * A grid in core/table's attribute shape, for seeding the merged block:
 * `head` is one row of `th` cells (no row at all for a grid without a
 * header), `body` rows use `td` cells, and each cell keeps the other
 * attributes the grid carries for it. The grid's further header rows and
 * its footer go back as they came.
 *
 * @param {Object} grid A grid.
 * @return {Object} The `{ head, body, foot }` attributes.
 */
export function gridToTableAttributes( grid ) {
	const cellsOf = ( contents, attributes, tag ) =>
		contents.map( ( content, index ) => ( {
			tag,
			...attributes?.[ index ],
			content,
		} ) );

	let head = [];
	if ( grid.head.length > 0 ) {
		head = [
			{ cells: cellsOf( grid.head, grid.cellAttributes?.head, 'th' ) },
			...( grid.extraHead ?? [] ),
		];
	}

	return {
		head,
		body: grid.rows.map( ( contents, rowIndex ) => ( {
			cells: cellsOf(
				contents,
				grid.cellAttributes?.rows?.[ rowIndex ],
				'td'
			),
		} ) ),
		foot: grid.foot ?? [],
	};
}

/**
 * A core/table block's attributes as a grid, the inverse of
 * gridToTableAttributes: the first header row's cells as the head, every
 * body row's cells as the rows. Cell contents may be strings or rich-text
 * values; both stringify to their markup. Everything else is kept beside
 * them untouched: each cell's other attributes (`tag`, `scope`, `align`,
 * `colspan`, `rowspan`), the header rows after the first, and the footer.
 *
 * @param {Object} attributes The table block's attributes.
 * @return {Object} The `{ head, rows, cellAttributes, extraHead, foot }`
 *                  grid.
 */
export function gridFromTableAttributes( attributes ) {
	const headRows = attributes?.head ?? [];
	const bodyRows = attributes?.body ?? [];
	const contentsOf = ( row ) =>
		( row?.cells ?? [] ).map( ( cell ) => String( cell?.content ?? '' ) );
	const attributesOf = ( row ) =>
		( row?.cells ?? [] ).map( ( cell ) => {
			const { content, ...others } = cell ?? {};

			return others;
		} );

	return {
		head: contentsOf( headRows[ 0 ] ),
		rows: bodyRows.map( contentsOf ),
		cellAttributes: {
			head: attributesOf( headRows[ 0 ] ),
			rows: bodyRows.map( attributesOf ),
		},
		extraHead: headRows.slice( 1 ),
		foot: attributes?.foot ?? [],
	};
}
