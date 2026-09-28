import { useMemo } from '@wordpress/element';
import { diffGridAgainstBase } from './merge-table-grids';

const CELL_CLASS = 'editor-collaboration-table-diff__cell';

/**
 * A cell's class names: the base cell class plus its highlight modifier.
 *
 * @param {string|undefined} modifier 'added', 'changed', 'contested', or
 *                                    undefined for no highlight.
 * @return {string} The class names.
 */
function cellClassName( modifier ) {
	if ( ! modifier ) {
		return CELL_CLASS;
	}

	return `${ CELL_CLASS } ${ CELL_CLASS }--${ modifier }`;
}

/**
 * A pane diff (one version against the base) as displayable head and body
 * cells: added rows and columns and changed cells highlighted.
 *
 * @param {Object} diff A diff from diffGridAgainstBase.
 * @return {Object} `{ head, rows }` of `{ value, modifier }` cells.
 */
function displayFromDiff( diff ) {
	return {
		head: diff.columns.map( ( column ) => {
			let modifier;
			if ( column.added ) {
				modifier = 'added';
			}

			return { value: column.key, modifier };
		} ),
		rows: diff.rows.map( ( row ) =>
			row.cells.map( ( cell ) => {
				let modifier;
				if ( 'unchanged' !== cell.status ) {
					modifier = cell.status;
				}

				return { value: cell.value, modifier };
			} )
		),
	};
}

/**
 * A merged model as displayable head and body cells: the union view, with
 * both sides' changes highlighted as added or changed and contested cells
 * marked contested. Missing intersection cells render empty with no
 * highlight.
 *
 * @param {Object} model A model from mergeTableGrids.
 * @return {Object} `{ head, rows }` of `{ value, modifier }` cells.
 */
function displayFromModel( model ) {
	return {
		head: model.columns.map( ( column ) => {
			let modifier;
			if ( 'base' !== column.source ) {
				modifier = 'added';
			}

			return { value: column.key, modifier };
		} ),
		rows: model.rows.map( ( row ) =>
			row.cells.map( ( cell, columnIndex ) => {
				let modifier;
				if ( 'contested' === cell.status ) {
					modifier = 'contested';
				} else if (
					'yours' === cell.status ||
					'current' === cell.status
				) {
					// A one-sided cell reached through added structure
					// reads as added; a one-sided edit of a base cell
					// reads as changed. Both share the same palette.
					const structural =
						'base' !== row.source ||
						'base' !== model.columns[ columnIndex ].source;
					if ( structural ) {
						modifier = 'added';
					} else {
						modifier = 'changed';
					}
				}

				return { value: cell.value, modifier };
			} )
		),
	};
}

/**
 * One table grid rendered as a plain table with per-cell diff
 * highlighting. Two modes: `grid` plus `baseGrid` render one version
 * diffed against the base (the dialog panes), `model` renders a merged
 * model's union view (the in-card preview). The wrapper scrolls
 * horizontally when a wide table overflows.
 *
 * The revisions diff system is deliberately NOT used here: table cells
 * live in query-sourced attributes, so the block differ has no cell grain
 * to offer; the whole table would just mark as modified.
 *
 * @param {Object}  props
 * @param {Object}  [props.grid]     A version's grid.
 * @param {Object}  [props.baseGrid] The base grid the version is diffed
 *                                   against.
 * @param {Object}  [props.model]    A merged model to render as the union
 *                                   view instead.
 * @param {boolean} [props.compact]  Tighter rendering for the in-card
 *                                   preview.
 * @param {string}  [props.label]    Accessible name for the table.
 */
export default function TableDiffGrid( {
	grid,
	baseGrid,
	model,
	compact,
	label,
} ) {
	const display = useMemo( () => {
		if ( model ) {
			return displayFromModel( model );
		}

		return displayFromDiff( diffGridAgainstBase( baseGrid, grid ) );
	}, [ grid, baseGrid, model ] );

	let tableClassName = 'editor-collaboration-table-diff';
	if ( compact ) {
		tableClassName += ' editor-collaboration-table-diff--compact';
	}

	return (
		<div className="editor-collaboration-table-diff__wrapper">
			<table className={ tableClassName } aria-label={ label }>
				<thead>
					<tr>
						{ display.head.map( ( cell, columnIndex ) => (
							<th
								key={ columnIndex }
								className={ cellClassName( cell.modifier ) }
							>
								{ cell.value }
							</th>
						) ) }
					</tr>
				</thead>
				<tbody>
					{ display.rows.map( ( cells, rowIndex ) => (
						<tr key={ rowIndex }>
							{ cells.map( ( cell, columnIndex ) => (
								<td
									key={ columnIndex }
									className={ cellClassName( cell.modifier ) }
								>
									{ cell.value }
								</td>
							) ) }
						</tr>
					) ) }
				</tbody>
			</table>
		</div>
	);
}
