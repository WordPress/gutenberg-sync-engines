import { useEffect, useMemo } from '@wordpress/element';
import { useDispatch } from '@wordpress/data';
import { Popover, SlotFillProvider } from '@wordpress/components';
import {
	BlockEditorProvider,
	BlockList,
	BlockToolbar,
	WritingFlow,
	store as blockEditorStore,
} from '@wordpress/block-editor';

/**
 * Keeps the merged block selected, so the formatting toolbar is available
 * without first clicking into the text, including after a restore reseeds
 * the content with a fresh block. Must render INSIDE the provider: the
 * selection lives in the merged editor's own store.
 *
 * @param {Object} props
 * @param {string} props.clientId The merged block's client id.
 */
function SelectMergedBlock( { clientId } ) {
	const { selectBlock } = useDispatch( blockEditorStore );

	useEffect( () => {
		if ( clientId ) {
			selectBlock( clientId );
		}
	}, [ clientId, selectBlock ] );

	return null;
}

/**
 * The merged result's editing surface: a self-contained block editor
 * holding the merged content, with the block toolbar fixed above it.
 * It has its OWN store, so nothing typed here reaches the document (or
 * the sync engines) until the dialog's Accept writes the result.
 *
 * The nested SlotFillProvider keeps this editor's toolbar fills and
 * popovers (the link editor, toolbar dropdowns) inside the dialog: they
 * render into the local Popover.Slot instead of the editor shell's slots
 * behind the modal.
 *
 * @param {Object}         props
 * @param {Array}          props.blocks       The merged content as blocks.
 * @param {Function}       props.onChange     ( blocks ) => void.
 * @param {string|boolean} props.templateLock The lock for the merged
 *                                            content. The default 'all'
 *                                            allows text and formatting
 *                                            only; the section dialog
 *                                            passes false so blocks can
 *                                            be added and removed while
 *                                            resolving a structural
 *                                            conflict.
 */
export default function MergedResultEditor( {
	blocks,
	onChange,
	templateLock = 'all',
} ) {
	const settings = useMemo(
		() => ( { templateLock, hasFixedToolbar: true } ),
		[ templateLock ]
	);

	return (
		<div className="editor-collaboration-merge-dialog__merged-editor">
			<SlotFillProvider>
				<BlockEditorProvider
					value={ blocks }
					onInput={ onChange }
					onChange={ onChange }
					settings={ settings }
				>
					<SelectMergedBlock clientId={ blocks[ 0 ]?.clientId } />
					<div className="editor-collaboration-merge-dialog__merged-toolbar">
						<BlockToolbar hideDragHandle />
					</div>
					<div className="editor-collaboration-merge-dialog__merged-canvas">
						<WritingFlow>
							<BlockList />
						</WritingFlow>
					</div>
					<Popover.Slot />
				</BlockEditorProvider>
			</SlotFillProvider>
		</div>
	);
}
