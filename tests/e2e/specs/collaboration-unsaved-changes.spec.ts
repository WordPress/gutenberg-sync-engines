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
 * The unsaved-changes policy (docs/plan/room-lifetime.md), once per engine:
 * the room lifetime rules live in the transport and the presence lane,
 * above the engine choice.
 *
 * "discard" (the default): when the LAST tab open on a post leaves —
 * closed, reloaded, navigated away — its unsaved edits go with it, exactly
 * as the browser's "You have unsaved changes" warning says. The tab's leave
 * beacon removes its presence and, finding nobody else in the room, the
 * server resets the room to the saved post.
 *
 * "keep": the room lives on as a shared working copy, and a reload lands
 * on the unsaved edits.
 */
const ENGINES = [ 'intent-log', 'yjs-server', 'de-rtc' ] as const;

const SAVED_PARAGRAPH =
	'<!-- wp:paragraph -->\n<p>Saved paragraph</p>\n<!-- /wp:paragraph -->';

async function setSettings(
	requestUtils: RequestUtils,
	data: Record< string, string | null >
) {
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data,
	} );
}

async function typeUnsaved(
	page: Page,
	canvas: Page | ReturnType< Page[ 'frameLocator' ] >,
	text: string
) {
	const paragraph = canvas.getByRole( 'document', {
		name: 'Block: Paragraph',
	} );
	await paragraph.click();
	await page.keyboard.press( 'End' );
	await page.keyboard.type( text );
}

/**
 * Reloads with the unsaved-changes dialog accepted (Playwright dismisses
 * dialogs by default, and dismissing cancels the navigation). A lone tab
 * holds its edits in the browser; hiding the tab starts a flush that the
 * pagehide cancels, so nothing lands in the room on the way out.
 * @param page
 */
async function reloadAccepting( page: Page ) {
	page.on( 'dialog', ( dialog ) => dialog.accept() );
	await page.reload();
}

for ( const engine of ENGINES ) {
	test.describe( `Unsaved changes policy (${ engine }) @engine-${ engine }`, () => {
		test.beforeEach( async ( { requestUtils } ) => {
			await setSettings( requestUtils, { wp_sync_engine: engine } );
		} );

		test.afterEach( async ( { requestUtils } ) => {
			await setSettings( requestUtils, {
				gutenberg_sync_engines_unsaved_changes: 'discard',
			} );
		} );

		test( 'discard: reloading the only open tab lands on the saved post', async ( {
			collaborationUtils,
			editor,
			page,
			requestUtils,
		} ) => {
			const post = await requestUtils.createPost( {
				title: 'Unsaved changes: discard',
				status: 'draft',
				content: SAVED_PARAGRAPH,
				date_gmt: new Date().toISOString(),
			} );
			await collaborationUtils.openPost( post.id );
			await typeUnsaved( page, editor.canvas, ' plus words never saved' );
			await expect(
				editor.canvas.getByRole( 'document', {
					name: 'Block: Paragraph',
				} )
			).toHaveText( 'Saved paragraph plus words never saved' );
			await page.waitForTimeout( 1500 );

			await reloadAccepting( page );
			await collaborationUtils.waitForCollaborationReady( page );
			await expect
				.poll( async () => editor.getBlocks(), { timeout: 15000 } )
				.toMatchObject( [
					{
						name: 'core/paragraph',
						attributes: { content: 'Saved paragraph' },
					},
				] );
		} );

		test( 'discard: a save keeps what was saved; only the edits after it go', async ( {
			collaborationUtils,
			editor,
			page,
			requestUtils,
		} ) => {
			const post = await requestUtils.createPost( {
				title: 'Unsaved changes: discard after save',
				status: 'draft',
				content: SAVED_PARAGRAPH,
				date_gmt: new Date().toISOString(),
			} );
			await collaborationUtils.openPost( post.id );
			await typeUnsaved( page, editor.canvas, ' then saved' );
			const saved = page.waitForResponse(
				( response ) =>
					decodeURIComponent( response.url() ).includes(
						`/wp/v2/posts/${ post.id }`
					) && 'POST' === response.request().method()
			);
			await editor.saveDraft();
			await saved;

			await typeUnsaved( page, editor.canvas, ' then not saved' );
			await expect(
				editor.canvas.getByRole( 'document', {
					name: 'Block: Paragraph',
				} )
			).toHaveText( 'Saved paragraph then saved then not saved' );
			await page.waitForTimeout( 1500 );

			await reloadAccepting( page );
			await collaborationUtils.waitForCollaborationReady( page );
			await expect
				.poll( async () => editor.getBlocks(), { timeout: 15000 } )
				.toMatchObject( [
					{
						name: 'core/paragraph',
						attributes: { content: 'Saved paragraph then saved' },
					},
				] );
		} );

		test( 'keep: reloading the only open tab lands on the shared working copy', async ( {
			collaborationUtils,
			editor,
			page,
			requestUtils,
		} ) => {
			await setSettings( requestUtils, {
				gutenberg_sync_engines_unsaved_changes: 'keep',
			} );
			const post = await requestUtils.createPost( {
				title: 'Unsaved changes: keep',
				status: 'draft',
				content: SAVED_PARAGRAPH,
				date_gmt: new Date().toISOString(),
			} );
			await collaborationUtils.openPost( post.id );
			await typeUnsaved( page, editor.canvas, ' kept in the room' );

			// The room only holds what reached it: hide the tab so the lone
			// editor's held work is flushed (a real tab switch), then come
			// back before reloading.
			await page.evaluate( () => {
				Object.defineProperty( document, 'visibilityState', {
					configurable: true,
					get: () => 'hidden',
				} );
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
			await page.waitForTimeout( 2500 );
			await page.evaluate( () => {
				Object.defineProperty( document, 'visibilityState', {
					configurable: true,
					get: () => 'visible',
				} );
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
			await page.waitForTimeout( 1000 );

			await reloadAccepting( page );
			await collaborationUtils.waitForCollaborationReady( page );
			await expect
				.poll( async () => editor.getBlocks(), { timeout: 15000 } )
				.toMatchObject( [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Saved paragraph kept in the room',
						},
					},
				] );
		} );
	} );
}
