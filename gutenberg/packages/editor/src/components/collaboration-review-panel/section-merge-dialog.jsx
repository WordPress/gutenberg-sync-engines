import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Button, Modal } from '@wordpress/components';
import { parse, serialize } from '@wordpress/blocks';
import BlockDiffPane, { BlockDiffResources } from './block-diff-pane';
import MergedResultEditor from './merged-result-editor';
import { MOCK_SECTION_CONFLICT } from './mock-section-conflict';

/**
 * One version pane: a heading, this version's blocks rendered read-only
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
 * The section merge dialog's content: your version and the current
 * version of a whole multi-block section side by side, each rendered as
 * read-only blocks diffed against the SHARED BASE both started from
 * with the revisions diff system, so each pane highlights only its own
 * changes at both grains: block-level added/removed/modified markers
 * and inline ins/del inside rich text. This is the dialog for conflicts
 * that have no per-block answer, like a paragraph split on one side and
 * edited on the other: the sides disagree on the block structure
 * itself, so the section is compared and resolved whole.
 *
 * The merged result below the panes is a real multi-block editor seeded
 * from the current version. Unlike the single-paragraph dialog, its
 * structure is NOT locked: resolving a structural conflict means
 * deciding which blocks survive, so blocks can be edited, added,
 * removed, and split here. Either pane's "Restore this version"
 * reseeds it wholly. Accept hands the merged result back as serialized
 * block content; Cancel closes without changing anything.
 *
 * The merged editor deliberately stays free of the diff highlighting:
 * the inline diff marks are rich-text formats living in the content,
 * and they would serialize into the accepted result.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}   props
 * @param {string}   props.base     Serialized blocks both versions
 *                                  started from.
 * @param {string}   props.yours    The author's version, serialized.
 * @param {string}   props.current  The document's current version,
 *                                  serialized.
 * @param {Function} props.onAccept ( mergedContent ) => void, with the
 *                                  merged result as serialized blocks.
 * @param {Function} props.onCancel Close without resolving.
 */
export function SectionMergeDialogBody( {
	base,
	yours,
	current,
	onAccept,
	onCancel,
} ) {
	// The merged result starts as the current version's blocks. Either
	// pane's "Restore this version" reseeds it, and it stays
	// hand-editable in the merged block editor below the panes.
	const [ merged, setMerged ] = useState( () => parse( current ) );

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
					content={ yours }
					baseContent={ base }
					onRestore={ () => setMerged( parse( yours ) ) }
				/>
				<Pane
					label={ __( 'Current version' ) }
					content={ current }
					baseContent={ base }
					onRestore={ () => setMerged( parse( current ) ) }
				/>
			</div>
			<div className="editor-collaboration-merge-dialog__merged">
				<h3 className="editor-collaboration-merge-dialog__pane-label">
					{ __( 'Merged result' ) }
				</h3>
				<MergedResultEditor
					blocks={ merged }
					onChange={ setMerged }
					templateLock={ false }
				/>
				<p className="editor-collaboration-merge-dialog__help">
					{ __(
						'These blocks replace the conflicted section when you accept.'
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
					onClick={ () => onAccept( serialize( merged ) ) }
				>
					{ __( 'Accept' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * The collaboration section merge dialog, opened from the "Review
 * conflict" card of a conflicted block that is, or sits inside, a group.
 * PROTOTYPE: the compared versions are the fabricated mock section
 * conflict, not the section's real contents; real conflicts open it,
 * but its contents are pre-set while the UI design settles.
 *
 * @param {Object}   props
 * @param {Function} props.onAccept ( mergedContent ) => void, with the
 *                                  merged result as serialized blocks.
 * @param {Function} props.onClose  Close without resolving.
 */
export default function CollaborationSectionMergeDialog( {
	onAccept,
	onClose,
} ) {
	return (
		<Modal
			title={ __( 'Review conflicting edits' ) }
			onRequestClose={ onClose }
			className="editor-collaboration-merge-dialog editor-collaboration-merge-dialog--section"
			size="large"
		>
			<SectionMergeDialogBody
				base={ MOCK_SECTION_CONFLICT.base }
				yours={ MOCK_SECTION_CONFLICT.yours }
				current={ MOCK_SECTION_CONFLICT.current }
				onAccept={ onAccept }
				onCancel={ onClose }
			/>
		</Modal>
	);
}
