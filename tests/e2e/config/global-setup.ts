/**
 * Global setup for the plugin's collaboration e2e.
 *
 * A trimmed version of the Gutenberg subtree's own e2e global setup: it
 * authenticates once and resets the site to a clean, predictable state. It
 * deliberately omits the monorepo-suite-specific steps (e.g. deactivating
 * Gutenberg's CSS-animation test plugin) that assume test plugins this
 * environment does not map. The RTC WebSocket provider setup is gated on
 * GUTENBERG_RTC_TEST_WS_PROVIDER (set by playwright.rtc-websocket.config.ts);
 * the default suite runs over the HTTP-polling transport and just deactivates
 * a stale provider activation.
 *
 * External dependencies
 */
import { request } from '@playwright/test';
import type { FullConfig } from '@playwright/test';

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Resolved via the plugin's own devDependency.
import { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { setupRtcWebSocketProvider } from './rtc-websocket-setup';

async function globalSetup( config: FullConfig ) {
	const { storageState, baseURL } = config.projects[ 0 ].use;
	const storageStatePath =
		typeof storageState === 'string' ? storageState : undefined;

	const requestContext = await request.newContext( { baseURL } );

	const requestUtils = new RequestUtils( requestContext, {
		storageStatePath,
	} );

	// Authenticate and persist the storage state to disk.
	await requestUtils.setupRest();

	/*
	 * The Gutenberg framework loads from the plugin's BUNDLED copy (there is
	 * no standalone gutenberg plugin mounted anymore) — only this plugin
	 * needs to be active. wp-env does not reliably activate mapped plugins
	 * on the *tests* site, so ensure it here; collaboration is inert
	 * without it.
	 *
	 * Worktree checkouts mount this plugin TWICE (the directory name via
	 * `plugins: ["."]` plus the .wp-env.json mapping), and both copies share
	 * one plugin name — the utils' name-keyed activatePlugin() can pick the
	 * inactive copy and fatal with a redeclare. Activate by file path, and
	 * only when no copy is active yet (see the AGENTS.md gotcha).
	 */
	const plugins = ( await requestUtils.rest( {
		path: '/wp/v2/plugins',
	} ) ) as Array< { plugin: string; status: string; name: string } >;

	// The standalone-Gutenberg stub (mounted at wp-content/plugins/gutenberg
	// for the precedence spec) must not linger active from an aborted run —
	// while it is active, the bundled framework defers to it and every
	// collaboration spec would time out.
	const staleStub = plugins.find(
		( { plugin, status } ) =>
			plugin.startsWith( 'gutenberg/' ) && 'active' === status
	);
	if ( staleStub ) {
		await requestUtils.rest( {
			method: 'PUT',
			path: `/wp/v2/plugins/${ staleStub.plugin }`,
			data: { status: 'inactive' },
		} );
	}
	const copies = plugins.filter(
		( { name } ) => 'Gutenberg Sync Engines' === name
	);
	if ( ! copies.some( ( { status } ) => 'active' === status ) ) {
		const preferred =
			copies.find( ( { plugin } ) =>
				plugin.startsWith( 'gutenberg-sync-engines/' )
			) ?? copies[ 0 ];
		if ( ! preferred ) {
			throw new Error(
				'The gutenberg-sync-engines plugin is not installed on the tests site.'
			);
		}
		await requestUtils.rest( {
			method: 'PUT',
			path: `/wp/v2/plugins/${ preferred.plugin }`,
			data: { status: 'active' },
		} );
	}

	/*
	 * The suite's timing assumes the cadences the client used before the
	 * settings' defaults changed: 1-second polling (now 5) and de-rtc
	 * commits on every settle (now every 10 seconds). Pin both: the
	 * specs certify convergence mechanics, not the shipped defaults.
	 */
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: {
			gutenberg_sync_engines_polling_interval: 1,
			gutenberg_sync_engines_de_rtc_commit_interval: 0,
		},
	} );

	// Reset the environment to a clean slate before the tests run.
	await Promise.all( [
		requestUtils.activateTheme( 'twentytwentyone' ),
		requestUtils.deleteAllPosts(),
		requestUtils.deleteAllPages(),
		requestUtils.deleteAllBlocks(),
		requestUtils.resetPreferences(),
		setupRtcWebSocketProvider( requestUtils ),
	] );

	await requestContext.dispose();
}

export default globalSetup;
