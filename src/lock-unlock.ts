/**
 * Private-API consent for `@wordpress/sync` and `@wordpress/editor`.
 *
 * Mirrors Gutenberg's lock/unlock pattern: a plugin opts into a package's
 * unstable private APIs with the same consent string the package registers.
 * `@wordpress/sync` must call `registerPrivateApis` (or the shared
 * `@wordpress/private-apis` equivalent) with this exact string for the
 * unlock to succeed — see PORTING.md.
 *
 * Two named exports so a reader can tell which package each unlocks:
 * `unlock` opens `@wordpress/sync` (the framework registries and the
 * manager), `unlockEditor` opens `@wordpress/editor` (the revisions block
 * differ the conflict review dialogs render with; see
 * src/review/revisions-diff.ts).
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.privateApis.
import { __dangerousOptInToUnstableAPIsOnlyForCoreModules } from '@wordpress/private-apis';

const CONSENT =
	'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.';

export const { lock, unlock } =
	__dangerousOptInToUnstableAPIsOnlyForCoreModules(
		CONSENT,
		'@wordpress/sync'
	);

export const { unlock: unlockEditor } =
	__dangerousOptInToUnstableAPIsOnlyForCoreModules(
		CONSENT,
		'@wordpress/editor'
	);
