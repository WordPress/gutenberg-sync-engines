// @ts-nocheck -- Plain JavaScript. The review components are not type-checked.
import { createContext, useContext } from '@wordpress/element';

/*
 * The review dialogs render blocks in small block editors of their own
 * (the read-only panes, the merged result). Those blocks are the record's
 * sides, so they carry the SAME durable ids as the conflicted blocks in
 * the document, and the `editor.BlockEdit` filters that replace a
 * conflicted block with its card would match them too: the dialog would
 * show cards instead of content. Every editor a dialog mounts sits inside
 * this surface, and the filters stand down within it.
 */
const ReviewSurfaceContext = createContext( false );

/**
 * Marks its children as review dialog content.
 *
 * @param {Object}  props
 * @param {Element} props.children The dialog's editors.
 */
export function ReviewSurface( { children } ) {
	return (
		<ReviewSurfaceContext.Provider value>
			{ children }
		</ReviewSurfaceContext.Provider>
	);
}

/**
 * Whether the calling component renders inside a review dialog.
 *
 * @return {boolean} Whether a review surface is above it.
 */
export function useIsInsideReviewSurface() {
	return useContext( ReviewSurfaceContext );
}
