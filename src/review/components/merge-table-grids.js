// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
/**
 * The pure three-way merge behind the table conflict dialog. No React and
 * no stores, so it is unit-testable on its own.
 *
 * A grid is `{ head: string[], rows: string[][] }`: `head` holds the
 * header row's labels, and each row's cell 0 is its label. Alignment is
 * BY LABEL: columns are keyed by their header text, rows by their first
 * cell. This is a deliberate prototype simplification: renamed,
 * reordered, and deleted rows and columns are not modeled, and duplicate
 * labels are unsupported (the merge assumes unique keys).
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
 * A (rowKey, columnKey) => value lookup over one grid; undefined when the
 * grid has no such row or column.
 *
 * @param {Object} grid A grid.
 * @return {Function} The lookup.
 */
function gridLookup( grid ) {
	const columnIndexes = new Map(
		grid.head.map( ( key, index ) => [ key, index ] )
	);
	const rowsByKey = new Map(
		grid.rows.map( ( cells ) => [ cells[ 0 ], cells ] )
	);

	return ( rowKey, columnKey ) => {
		if ( ! columnIndexes.has( columnKey ) ) {
			return undefined;
		}

		return rowsByKey.get( rowKey )?.[ columnIndexes.get( columnKey ) ];
	};
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
 * @param {Object} base    The shared base grid.
 * @param {Object} yours   Your version's grid.
 * @param {Object} current The current version's grid.
 * @return {Object} `{ columns, rows, contested }`: `columns` are
 *                  `{ key, source }` entries, `rows` add a `cells` array
 *                  of `{ status, value }` (contested cells also carry
 *                  `yourValue`/`currentValue`), and `contested` lists
 *                  each contested cell with its model indices.
 */
export function mergeTableGrids( base, yours, current ) {
	const columns = mergeKeys( base.head, yours.head, current.head );
	const rowEntries = mergeKeys(
		rowLabels( base ),
		rowLabels( yours ),
		rowLabels( current )
	);
	const inBase = gridLookup( base );
	const inYours = gridLookup( yours );
	const inCurrent = gridLookup( current );

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
						const lookup = 'yours' === side ? inYours : inCurrent;

						return {
							status: side,
							value: lookup( rowKey, columnKey ) ?? '',
						};
					}

					const baseValue = inBase( rowKey, columnKey ) ?? '';
					const yourValue = inYours( rowKey, columnKey ) ?? baseValue;
					const currentValue =
						inCurrent( rowKey, columnKey ) ?? baseValue;
					const yoursChanged = yourValue !== baseValue;
					const currentChanged = currentValue !== baseValue;

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
							yourValue,
							currentValue,
						};
					}

					if ( yoursChanged && ! currentChanged ) {
						return { status: 'yours', value: yourValue };
					}

					if ( currentChanged && ! yoursChanged ) {
						return { status: 'current', value: currentValue };
					}

					// Untouched, or a convergent identical change.
					return { status: 'unchanged', value: currentValue };
				}
			);

			return { key: rowKey, source: rowSource, cells };
		}
	);

	return { columns, rows, contested };
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
	const baseColumns = new Set( base.head );
	const baseRows = new Set( rowLabels( base ) );
	const inBase = gridLookup( base );

	const columns = version.head.map( ( key ) => ( {
		key,
		added: ! baseColumns.has( key ),
	} ) );

	const rows = version.rows.map( ( cells ) => {
		const rowKey = cells[ 0 ];
		const added = ! baseRows.has( rowKey );

		return {
			key: rowKey,
			added,
			cells: cells.map( ( value, index ) => {
				if ( added || columns[ index ]?.added ) {
					return { status: 'added', value };
				}

				if (
					value !== ( inBase( rowKey, version.head[ index ] ) ?? '' )
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
 * The suggested merge as a plain grid, extracted from a merged model:
 * the shape restores and reseeds work with.
 *
 * @param {Object} model A model from mergeTableGrids.
 * @return {Object} The `{ head, rows }` grid of the suggested values.
 */
export function mergedGridFromModel( model ) {
	return {
		head: model.columns.map( ( column ) => column.key ),
		rows: model.rows.map( ( row ) =>
			row.cells.map( ( cell ) => cell.value )
		),
	};
}

/**
 * A grid in core/table's attribute shape, for seeding the merged block:
 * `head` is one row of `th` cells, `body` rows use `td` cells.
 *
 * @param {Object} grid A grid.
 * @return {Object} The `{ head, body }` attributes.
 */
export function gridToTableAttributes( grid ) {
	return {
		head: [
			{
				cells: grid.head.map( ( content ) => ( {
					content,
					tag: 'th',
				} ) ),
			},
		],
		body: grid.rows.map( ( cells ) => ( {
			cells: cells.map( ( content ) => ( { content, tag: 'td' } ) ),
		} ) ),
	};
}

/**
 * A core/table block's attributes as a plain grid, the inverse of
 * gridToTableAttributes: the first header row's cells as the head, every
 * body row's cells as the rows. Cell contents may be strings or rich-text
 * values; both stringify to their markup.
 *
 * @param {Object} attributes The table block's attributes.
 * @return {Object} The `{ head, rows }` grid.
 */
export function gridFromTableAttributes( attributes ) {
	const cellsOf = ( row ) =>
		( row?.cells ?? [] ).map( ( cell ) => String( cell?.content ?? '' ) );

	return {
		head: cellsOf( attributes?.head?.[ 0 ] ),
		rows: ( attributes?.body ?? [] ).map( cellsOf ),
	};
}
