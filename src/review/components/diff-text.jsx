// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
/**
 * Renders word-diff parts, marking additions and removals.
 *
 * @param {Object} props
 * @param {Array}  props.parts diffWords change objects.
 */
export default function DiffText( { parts } ) {
	return parts.map( ( part, index ) => {
		if ( part.added ) {
			return (
				<ins key={ index } className="gse-review-diff__added">
					{ part.value }
				</ins>
			);
		}

		if ( part.removed ) {
			return (
				<del key={ index } className="gse-review-diff__removed">
					{ part.value }
				</del>
			);
		}

		return <span key={ index }>{ part.value }</span>;
	} );
}
