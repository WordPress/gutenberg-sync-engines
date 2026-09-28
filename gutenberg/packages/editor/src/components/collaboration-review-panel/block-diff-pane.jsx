import { useEffect, useMemo, useState } from '@wordpress/element';
import { Disabled } from '@wordpress/components';
import { BlockEditorProvider, BlockList } from '@wordpress/block-editor';
import { diffRevisionContent } from '../post-revisions-preview/block-diff';
import {
	registerDiffFormatTypes,
	unregisterDiffFormatTypes,
} from '../post-revisions-preview/diff-format-types';
import {
	DiffDescriptions,
	REVISION_DIFF_STYLES,
	REVISION_REMOVED_FILTER_SVG,
} from '../post-revisions-preview/block-diff-view';

const PANE_EDITOR_SETTINGS = {
	// Read-only rendering: no appenders or inserters.
	templateLock: 'all',
};

// How many mounted panes need the revision diff format types. The types are
// registered globally in the rich-text registry, so the first pane registers
// them and the last one leaving unregisters them, mirroring the revisions
// canvas's own register-on-mount lifecycle without double registration when
// a dialog shows two panes.
let diffFormatTypeUsers = 0;

/**
 * Registers the revision diff format types for this pane's lifetime.
 *
 * Registration must happen BEFORE any diffed rich text renders: rendering
 * converts the diff formats to their tags (<ins>, <del>, <mark>) via the
 * registry. Returns whether the types are registered yet, so the caller can
 * hold off computing and rendering the diff until they are.
 *
 * @return {boolean} True once the format types are registered.
 */
function useDiffFormatTypes() {
	const [ isReady, setIsReady ] = useState( false );

	useEffect( () => {
		if ( diffFormatTypeUsers === 0 ) {
			registerDiffFormatTypes();
		}
		diffFormatTypeUsers++;
		setIsReady( true );

		return () => {
			diffFormatTypeUsers--;
			if ( diffFormatTypeUsers === 0 ) {
				unregisterDiffFormatTypes();
			}
		};
	}, [] );

	return isReady;
}

/**
 * The document-level resources the panes' diff highlighting depends on:
 * the diff CSS, the SVG filter the removed styles reference by id, and the
 * visually hidden descriptions the diff marks point at via
 * `aria-describedby`. The revisions canvas injects the same resources into
 * its iframe; a dialog renders this component once instead, since the
 * admin stylesheet does not carry them.
 *
 * @return {JSX.Element} The style tag, filter, and descriptions.
 */
export function BlockDiffResources() {
	return (
		<>
			<style>{ REVISION_DIFF_STYLES }</style>
			<div
				aria-hidden="true"
				dangerouslySetInnerHTML={ {
					__html: REVISION_REMOVED_FILTER_SVG,
				} }
			/>
			<DiffDescriptions />
		</>
	);
}

/**
 * A read-only pane rendering one version of some block content, diffed
 * against a base version with the revisions diff system: real rendered
 * blocks, block-level added/removed/modified markers, and inline ins/del
 * highlighting inside rich text. The blocks live in their own store and
 * are not editable, so nothing here can reach the document.
 *
 * The host must render {@link BlockDiffResources} once in the same
 * document for the highlighting to be visible.
 *
 * @param {Object} props
 * @param {string} props.content     Serialized blocks of this version.
 * @param {string} props.baseContent Serialized blocks of the base version
 *                                   the diff is computed against.
 */
export default function BlockDiffPane( { content, baseContent } ) {
	const isReady = useDiffFormatTypes();

	const blocks = useMemo( () => {
		// Wait for the format types: diffRevisionContent stamps the diff
		// formats into the rich text, and rendering resolves them through
		// the registry.
		if ( ! isReady ) {
			return [];
		}

		return diffRevisionContent( content, baseContent );
	}, [ isReady, content, baseContent ] );

	return (
		<div className="editor-collaboration-block-diff">
			<BlockEditorProvider
				value={ blocks }
				settings={ PANE_EDITOR_SETTINGS }
			>
				<Disabled>
					<BlockList renderAppender={ false } />
				</Disabled>
			</BlockEditorProvider>
		</div>
	);
}
