/**
 * External dependencies
 */
import type { Page } from '@playwright/test';
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';

/**
 * Slow awareness (docs/awareness-high-latency.md): with an "Awareness
 * interval" set, each editor names the block its selection is in once per
 * interval, and peers draw the block outline and an avatar badge on that
 * block instead of live cursors. This runs the sync-transport channel over
 * plain short polling (the advisory channel off), the connection shape the
 * mode exists for. The default engine (intent-log) has no block awareness
 * at all without this mode, so the spec certifies presence where the
 * framework draws nothing.
 */

const TWO_PARAGRAPHS =
	'<!-- wp:paragraph -->\n<p>First paragraph</p>\n<!-- /wp:paragraph -->\n\n' +
	'<!-- wp:paragraph -->\n<p>Second paragraph</p>\n<!-- /wp:paragraph -->';

const INTERVAL_OPTION = 'gutenberg_sync_engines_awareness_interval';
const ADVISORY_OPTION = 'gutenberg_sync_engines_advisory_channel';

async function setSettings(
	requestUtils: RequestUtils,
	data: Record< string, string | number >
) {
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data,
	} );
}

/**
 * Collects console errors about awareness fields: a peer's unknown field
 * used to break the receiving tab's polling ("No equality check
 * implemented"), so the spec asserts the guard holds on both pages.
 *
 * @param page The page to watch.
 * @return The collected messages.
 */
function watchAwarenessErrors( page: Page ): string[] {
	const errors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.text().includes( 'equality check' ) ) {
			errors.push( message.text() );
		}
	} );
	page.on( 'pageerror', ( error ) => {
		if ( error.message.includes( 'equality check' ) ) {
			errors.push( error.message );
		}
	} );
	return errors;
}

test.describe( 'Collaboration - slow awareness', () => {
	let previousAdvisory = 'webrtc-advisory';

	test.beforeAll( async ( { requestUtils } ) => {
		const settings = await requestUtils.rest( { path: '/wp/v2/settings' } );
		previousAdvisory = settings[ ADVISORY_OPTION ] ?? 'webrtc-advisory';
		await setSettings( requestUtils, {
			[ INTERVAL_OPTION ]: 2,
			[ ADVISORY_OPTION ]: '',
		} );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSettings( requestUtils, {
			[ INTERVAL_OPTION ]: 0,
			[ ADVISORY_OPTION ]: previousAdvisory,
		} );
	} );

	test( 'shows a peer’s block with an outline and a badge, and follows them as they move', async ( {
		collaborationUtils,
		requestUtils,
		editor,
		page,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Slow Awareness Test',
			status: 'draft',
			content: TWO_PARAGRAPHS,
			date_gmt: new Date().toISOString(),
		} );

		const errors = watchAwarenessErrors( page );
		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		errors.push( ...watchAwarenessErrors( page2 ) );

		const paragraphsOnA = editor.canvas.locator(
			'[data-type="core/paragraph"]'
		);
		const paragraphsOnB = editor2.canvas.locator(
			'[data-type="core/paragraph"]'
		);

		// User B works in the second paragraph; user A sees the outline
		// and the badge on that block and nowhere else.
		await paragraphsOnB.nth( 1 ).click();
		await expect( paragraphsOnA.nth( 1 ) ).toHaveClass( /gse-presence/, {
			timeout: 15000,
		} );
		await expect( paragraphsOnA.nth( 0 ) ).not.toHaveClass(
			/gse-presence/
		);
		await expect(
			editor.canvas.locator( '.gse-presence-badge .gse-avatar' )
		).toHaveCount( 1 );

		// B moves to the first paragraph (selected through the editor, since
		// the second paragraph's toolbar floats over the first): the
		// indicator moves with them.
		await editor2.selectBlocks( paragraphsOnB.nth( 0 ) );
		await expect( paragraphsOnA.nth( 0 ) ).toHaveClass( /gse-presence/, {
			timeout: 15000,
		} );
		await expect( paragraphsOnA.nth( 1 ) ).not.toHaveClass(
			/gse-presence/
		);
		await expect(
			editor.canvas.locator( '.gse-presence-badge .gse-avatar' )
		).toHaveCount( 1 );

		// No live cursor rides beside the outline in this mode.
		await expect(
			editor.canvas.locator( '.collaborators-overlay-user-cursor' )
		).toHaveCount( 0 );

		expect( errors ).toEqual( [] );
	} );
} );
