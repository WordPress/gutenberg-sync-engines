// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { useDispatch, useSelect } from '@wordpress/data';
import { useEffect } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { Button } from '@wordpress/components';
import { store as blockEditorStore } from '@wordpress/block-editor';
import {
	PluginDocumentSettingPanel,
	store as editorStore,
} from '@wordpress/editor';
import { useOpenConflicts, useResolveConflict } from '../conflicts';
import { plainText } from './conflict-block';
import { canApproveUnfilteredHtml, useCurrentPost } from './review-data';

const EMPTY_CONFLICTS = [];

const PLUGIN_NAME = 'gutenberg-sync-engines-conflicts';
const PANEL_NAME = 'conflicts';

// The editor keys a plugin's panel by both names.
const PANEL_KEY = `${ PLUGIN_NAME }/${ PANEL_NAME }`;

/**
 * Whether a record has a block in the canvas to present on. A property
 * has none, a proposed new block has none yet, and a block the document
 * no longer holds has none any more.
 *
 * @param {Function} select   Registry select (inside a useSelect).
 * @param {Object}   conflict The conflict record.
 * @return {boolean} Whether a card can present the record.
 */
export function isAnchored( select, conflict ) {
	const { target } = conflict;
	if ( 'blocks' !== target.type || 0 === target.count ) {
		return false;
	}

	const { getBlockAttributes, getBlockOrder, getClientIdsWithDescendants } =
		select( blockEditorStore );

	if ( target.ids?.length ) {
		return getClientIdsWithDescendants().some(
			( clientId ) =>
				clientId === target.ids[ 0 ] ||
				getBlockAttributes( clientId )?.metadata?.syncId ===
					target.ids[ 0 ]
		);
	}

	if ( target.parentId ) {
		return getClientIdsWithDescendants().some(
			( clientId ) =>
				getBlockAttributes( clientId )?.metadata?.syncId ===
					target.parentId &&
				getBlockOrder( clientId ).length > target.index
		);
	}

	return getBlockOrder().length > target.index;
}

/**
 * The current post's open conflicts that no card presents.
 *
 * @return {Array} The records.
 */
export function useUnanchoredConflicts() {
	const { postType, postId } = useCurrentPost();
	const open = useOpenConflicts( postType, postId );

	return useSelect(
		( select ) => {
			if ( ! open.length ) {
				return EMPTY_CONFLICTS;
			}

			const unanchored = open.filter(
				( conflict ) => ! isAnchored( select, conflict )
			);

			if ( ! unanchored.length ) {
				return EMPTY_CONFLICTS;
			}

			return unanchored;
		},
		[ open ]
	);
}

/**
 * What a record is about, in the reader's words.
 *
 * @param {Object} conflict The conflict record.
 * @return {string} The heading.
 */
function headingOf( conflict ) {
	if ( 'property' === conflict.target.type ) {
		return sprintf(
			// translators: %s: the name of a post field, such as "title".
			__( 'A change to the %s was set aside.' ),
			conflict.target.name
		);
	}

	if ( 'sequestration' === conflict.kind ) {
		return __( 'A proposed block needs approval.' );
	}

	return __( 'A change to a block was set aside.' );
}

/**
 * The list of conflicts no card presents, each with what was proposed,
 * what the document has, and the two decisions. All content renders as
 * inert text, never live markup: a held block has not been trusted.
 *
 * Position-independent so it can be unit-tested without the editor.
 *
 * @param {Object}   props
 * @param {Array}    props.conflicts  The records.
 * @param {boolean}  props.canApprove Whether the user may approve content
 *                                    held for unfiltered-HTML review.
 * @param {Function} props.onDecide   ( conflictId, decision ) => void.
 */
export function UnanchoredConflictsBody( { conflicts, canApprove, onDecide } ) {
	return (
		<>
			<p className="gse-review-panel__description">
				{ __(
					'These changes could not be merged automatically and have no block to show them on.'
				) }
			</p>
			{ conflicts.map( ( conflict ) => {
				const isProperty = 'property' === conflict.target.type;
				const mayAccept =
					'sequestration' !== conflict.kind || canApprove;
				const proposed = isProperty
					? conflict.proposed
					: plainText( conflict.proposed ) || conflict.proposed;
				const current = isProperty
					? conflict.current
					: plainText( conflict.current );

				return (
					<div className="gse-review-panel__item" key={ conflict.id }>
						<p className="gse-review-panel__heading">
							{ headingOf( conflict ) }
						</p>
						<p className="gse-review-panel__label">
							{ __( 'Proposed' ) }
						</p>
						<pre className="gse-review-panel__value">
							{ proposed }
						</pre>
						{ '' !== current && (
							<>
								<p className="gse-review-panel__label">
									{ __( 'Current' ) }
								</p>
								<pre className="gse-review-panel__value">
									{ current }
								</pre>
							</>
						) }
						<div className="gse-review-panel__actions">
							{ mayAccept && (
								<Button
									__next40pxDefaultSize
									size="compact"
									variant="primary"
									onClick={ () =>
										onDecide( conflict.id, {
											action: 'accept',
											content: conflict.proposed,
										} )
									}
								>
									{ __( 'Use proposed' ) }
								</Button>
							) }
							<Button
								__next40pxDefaultSize
								size="compact"
								variant="secondary"
								onClick={ () =>
									onDecide( conflict.id, {
										action: 'dismiss',
									} )
								}
							>
								{ __( 'Keep current' ) }
							</Button>
						</div>
						{ ! mayAccept && (
							<p className="gse-review-panel__hint">
								{ __(
									'Only someone allowed to publish unfiltered HTML can approve this.'
								) }
							</p>
						) }
					</div>
				);
			} ) }
		</>
	);
}

/**
 * The document sidebar panel for conflicts no card presents: a changed
 * title or other post field, a proposed new block, a change to a block
 * the document no longer holds. The panel is absent while there are
 * none, which is nearly always.
 */
export default function UnanchoredConflictsPanel() {
	const { postType, postId } = useCurrentPost();
	const conflicts = useUnanchoredConflicts();
	const resolve = useResolveConflict( postType, postId );
	const hasConflicts = conflicts.length > 0;
	const isOpened = useSelect(
		( select ) => select( editorStore ).isEditorPanelOpened( PANEL_KEY ),
		[]
	);
	const { toggleEditorPanelOpened } = useDispatch( editorStore );

	// Panels start collapsed, and a collapsed heading is easy to miss.
	// Open it when the first conflict arrives. The reviewer can still
	// collapse it afterwards: this runs on arrival only.
	useEffect( () => {
		if ( hasConflicts && ! isOpened ) {
			toggleEditorPanelOpened( PANEL_KEY );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- On arrival only, see above.
	}, [ hasConflicts ] );

	if ( ! hasConflicts ) {
		return null;
	}

	return (
		<PluginDocumentSettingPanel
			name={ PANEL_NAME }
			title={ __( 'Changes to review' ) }
			className="gse-review-panel"
		>
			<UnanchoredConflictsBody
				conflicts={ conflicts }
				canApprove={ canApproveUnfilteredHtml() }
				onDecide={ resolve }
			/>
		</PluginDocumentSettingPanel>
	);
}
