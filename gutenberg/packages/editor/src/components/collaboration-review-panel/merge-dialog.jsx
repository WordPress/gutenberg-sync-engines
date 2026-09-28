import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { createBlock } from '@wordpress/blocks';
import BlockDiffPane, { BlockDiffResources } from './block-diff-pane';
import MergedResultEditor from './merged-result-editor';
import { MOCK_CONFLICT } from './mock-conflict';

/**
 * A version's text as serialized paragraph markup, the input shape the
 * block differ compares. The prototype's conflict texts are plain
 * strings; the eventual engine-supplied versions arrive serialized
 * already, and this wrapper disappears with them.
 *
 * @param {string} text The version's text.
 * @return {string} The text as one serialized paragraph block.
 */
function paragraphContent( text ) {
	return `<!-- wp:paragraph -->\n<p>${ text }</p>\n<!-- /wp:paragraph -->`;
}

/**
 * The merged result as blocks, seeded from one version's text.
 *
 * @param {string} text The version's text.
 * @return {Array} A single paragraph block holding the text.
 */
function mergedBlocksFrom( text ) {
	return [ createBlock( 'core/paragraph', { content: text } ) ];
}

/**
 * The merged result's rich-text content as an HTML string, the shape the
 * resolution writes back into the conflicted block. The paragraph's
 * content attribute stringifies to its inner HTML whether it is still the
 * seeded string or a rich-text value produced by editing.
 *
 * @param {Array} blocks The merged editor's blocks.
 * @return {string} The merged content.
 */
function mergedHtmlFrom( blocks ) {
	return blocks
		.map( ( block ) => String( block.attributes?.content ?? '' ) )
		.join( '\n\n' );
}

/**
 * One version pane: a heading, this version rendered as read-only blocks
 * with the revisions diff highlighting against the base version, and a
 * button copying this version into the merged result.
 *
 * @param {Object}   props
 * @param {string}   props.label       Pane heading.
 * @param {string}   props.content     This version as serialized blocks.
 * @param {string}   props.baseContent The shared base as serialized
 *                                     blocks.
 * @param {Function} props.onRestore   Copy this version into the merged
 *                                     result.
 */
function Pane( { label, content, baseContent, onRestore } ) {
	return (
		<div className="editor-collaboration-merge-dialog__pane">
			<h3 className="editor-collaboration-merge-dialog__pane-label">
				{ label }
			</h3>
			<div className="editor-collaboration-merge-dialog__pane-content">
				<BlockDiffPane
					content={ content }
					baseContent={ baseContent }
				/>
			</div>
			<Button
				__next40pxDefaultSize
				size="compact"
				variant="secondary"
				onClick={ onRestore }
			>
				{ __( 'Restore this version' ) }
			</Button>
		</div>
	);
}

/**
 * The merge dialog's content: your version and the current version side by
 * side, each rendered as read-only blocks diffed against the SHARED BASE
 * both started from with the revisions diff system (so each pane
 * highlights only that side's own changes), and each restorable into the
 * merged result below them. The merged result is a paragraph edited in
 * its own small block editor (text and formatting only), so the paragraph
 * block type must be registered. Accept hands the merged result's HTML
 * back; Cancel closes without changing anything.
 *
 * The merged editor deliberately stays free of the diff highlighting: the
 * inline diff marks are rich-text formats living in the content, and they
 * would serialize into the accepted result.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {string}   props.baseText    The text both versions started from.
 * @param {string}   props.yourText    The author's version of the text.
 * @param {string}   props.currentText The document's current version.
 * @param {Function} props.onAccept    ( mergedText ) => void.
 * @param {Function} props.onCancel    Close without resolving.
 */
export function MergeDialogBody( {
	baseText,
	yourText,
	currentText,
	onAccept,
	onCancel,
} ) {
	// The merged result starts as the current version. Either pane's
	// "Restore this version" reseeds it, and it stays hand-editable in
	// the merged block editor below the panes.
	const [ merged, setMerged ] = useState( () =>
		mergedBlocksFrom( currentText )
	);

	const baseContent = paragraphContent( baseText );

	return (
		<div className="editor-collaboration-merge-dialog__body">
			<BlockDiffResources />
			<p className="editor-collaboration-merge-dialog__description">
				{ __(
					'These edits could not be merged automatically. Compare the versions and choose what to keep.'
				) }
			</p>
			<div className="editor-collaboration-merge-dialog__panes">
				<Pane
					label={ __( 'Your version' ) }
					content={ paragraphContent( yourText ) }
					baseContent={ baseContent }
					onRestore={ () =>
						setMerged( mergedBlocksFrom( yourText ) )
					}
				/>
				<Pane
					label={ __( 'Current version' ) }
					content={ paragraphContent( currentText ) }
					baseContent={ baseContent }
					onRestore={ () =>
						setMerged( mergedBlocksFrom( currentText ) )
					}
				/>
			</div>
			<div className="editor-collaboration-merge-dialog__merged">
				<h3 className="editor-collaboration-merge-dialog__pane-label">
					{ __( 'Merged result' ) }
				</h3>
				<MergedResultEditor blocks={ merged } onChange={ setMerged } />
				<p className="editor-collaboration-merge-dialog__help">
					{ __(
						'This text replaces the conflicted content when you accept.'
					) }
				</p>
			</div>
			<div className="editor-collaboration-merge-dialog__actions">
				<Button
					__next40pxDefaultSize
					variant="tertiary"
					onClick={ onCancel }
				>
					{ __( 'Cancel' ) }
				</Button>
				<Button
					__next40pxDefaultSize
					variant="primary"
					onClick={ () => onAccept( mergedHtmlFrom( merged ) ) }
				>
					{ __( 'Accept' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The collaboration merge dialog, opened from a conflicted block's
 * "Review conflict" card. PROTOTYPE: the compared versions are the
 * fabricated mock conflict, not the block's real texts; real conflicts
 * open it, but its contents are pre-set while the UI design settles.
 *
 * @param {Object}   props
 * @param {Function} props.onAccept ( mergedText ) => void.
 * @param {Function} props.onClose  Close without resolving.
 */
export default function CollaborationMergeDialog( { onAccept, onClose } ) {
	return (
		<Modal
			title={ __( 'Review conflicting edits' ) }
			onRequestClose={ onClose }
			className="editor-collaboration-merge-dialog"
			size="large"
		>
			<MergeDialogBody
				baseText={ MOCK_CONFLICT.baseText }
				yourText={ MOCK_CONFLICT.yourText }
				currentText={ MOCK_CONFLICT.currentText }
				onAccept={ onAccept }
				onCancel={ onClose }
			/>
		</Modal>
	);
}
