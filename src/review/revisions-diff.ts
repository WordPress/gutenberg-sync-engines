/**
 * The revisions block differ, unlocked ONCE from `@wordpress/editor`'s
 * private APIs and re-exported for the review components. Every review
 * component imports these names from here, never from the subtree by
 * relative path. The names are the vendor delta the bundled Gutenberg
 * carries on top of its pin (see AGENTS.md, "The gutenberg/ subtree"), and
 * the upstream pull request in docs/plan/upstream-revisions-differ-pr.md.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.editor.
import { privateApis } from '@wordpress/editor';

/**
 * Internal dependencies
 */
import { unlockEditor } from '../lock-unlock';

const api = unlockEditor( privateApis );

/** Two serialized block strings in, blocks marked with diff status out. */
export const diffRevisionContent = api.diffRevisionContent;
/** The inline rich-text diff formats the differ stamps into content. */
export const registerDiffFormatTypes = api.registerDiffFormatTypes;
export const unregisterDiffFormatTypes = api.unregisterDiffFormatTypes;
/** The visual layer: descriptions, the diff CSS, the removed-block filter. */
export const DiffDescriptions = api.DiffDescriptions;
export const REVISION_DIFF_STYLES = api.REVISION_DIFF_STYLES;
export const REVISION_REMOVED_FILTER_SVG = api.REVISION_REMOVED_FILTER_SVG;
/** The presentational line-by-line code diff. */
export const RevisionsCodeDiff = api.RevisionsCodeDiff;
