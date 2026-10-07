/**
 * External dependencies
 */
import type { Page } from '@playwright/test';

/**
 * WordPress dependencies
 */
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';

/**
 * Issue #100: under the intent-log engine, text a person types right after
 * opening a post, before the window's first sync response arrives, must
 * not be lost.
 *
 * The race is made deterministic the way the yjs-server late-join spec
 * (issue #57) does it: the reloading window's sync requests are held for a
 * few seconds, so the editor is mounted and the person can type before the
 * room's document arrives.
 *
 * Before the fix the engine kept the typed tree only for an EMPTY post. On
 * any other post the document that arrived replaced the canvas, and the
 * keystroke disappeared from the typist's screen without reaching anyone.
 */

const HOLD_MS = 4000;
const PEER_TEXT = ' plus user one';

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if ( 'intent-log' !== settings.wp_sync_engine ) {
			return;
		}
	}
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: { wp_sync_engine: engine },
	} );
}

async function waitForSyncQuiet( page: Page ): Promise< void > {
	const QUIET_MS = 1500;
	const MAX_MS = 10000;
	let lastRequestAt = Date.now();
	const onRequest = ( request: { url: () => string } ) => {
		if ( request.url().includes( 'wp-sync' ) ) {
			lastRequestAt = Date.now();
		}
	};
	page.on( 'request', onRequest );
	const deadline = Date.now() + MAX_MS;
	try {
		while ( Date.now() < deadline ) {
			if ( Date.now() - lastRequestAt >= QUIET_MS ) {
				return;
			}
			await page.waitForTimeout( 100 );
		}
	} finally {
		page.off( 'request', onRequest );
	}
}

/**
 * Holds every sync request of a window until the returned setter's time.
 *
 * @param page The window whose sync requests are held.
 */
async function holdSyncRequests(
	page: Page
): Promise< ( until: number ) => void > {
	let releaseAt = 0;
	await page.route(
		( url ) => url.href.includes( 'wp-sync' ),
		async ( route ) => {
			const wait = releaseAt - Date.now();
			if ( wait > 0 ) {
				await new Promise( ( resolve ) => setTimeout( resolve, wait ) );
			}
			await route.continue();
		}
	);
	return ( until: number ) => {
		releaseAt = until;
	};
}

test.describe( 'Collaboration - intent-log late join (issue #100) @engine-intent-log', () => {
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'intent-log' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	const CASES: Array< {
		title: string;
		typeDuringHold: boolean;
		savedBeforeJoin: boolean;
	} > = [
		{
			title: 'a window whose first sync response is delayed does not revert a peer’s unsaved text',
			typeDuringHold: false,
			savedBeforeJoin: false,
		},
		{
			title: 'text typed before the delayed first sync response is kept and reaches the peer',
			typeDuringHold: true,
			savedBeforeJoin: false,
		},
		{
			title: 'the same after user 1 SAVED: the typed text is kept and the saved text is not doubled',
			typeDuringHold: true,
			savedBeforeJoin: true,
		},
	];

	for ( const { title, typeDuringHold, savedBeforeJoin } of CASES ) {
		test( title, async ( { collaborationUtils, requestUtils, editor, page } ) => {
			const post = await requestUtils.createPost( {
				title: 'Late join',
				status: 'draft',
				content:
					'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;

			for ( const currentEditor of [ editor, editor2 ] ) {
				await expect( async () => {
					const blocks = await currentEditor.getBlocks();
					expect( blocks ).toMatchObject( [
						{
							name: 'core/paragraph',
							attributes: { content: 'Existing content' },
						},
					] );
				} ).toPass( { timeout: 10000 } );
			}

			// User 1 types text that is NOT saved (yet).
			await editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await page.keyboard.press( 'End' );
			await page.keyboard.type( PEER_TEXT, { delay: 30 } );

			// The room holds it: user 2 sees it before reloading.
			await expect( async () => {
				const blocks = await editor2.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					`Existing content${ PEER_TEXT }`
				);
			} ).toPass( { timeout: 10000 } );

			if ( savedBeforeJoin ) {
				// The room outlives the save, so its first row is now older
				// than the saved post the joiner will parse.
				const saved = page.waitForResponse(
					( response ) =>
						decodeURIComponent( response.url() ).includes(
							'/wp/v2/posts/'
						) && 'POST' === response.request().method()
				);
				await editor.saveDraft();
				await saved;
				await waitForSyncQuiet( page );
			}

			const releaseAt = Date.now() + HOLD_MS;
			( await holdSyncRequests( page2 ) )( releaseAt );
			await page2.reload();
			await collaborationUtils.waitForCollaborationReady( page2 );

			const shownBeforeSync = String(
				( await editor2.getBlocks() )[ 0 ].attributes.content
			);
			if ( typeDuringHold ) {
				// The editor shows the SAVED content, so the person types
				// after its last word.
				await editor2.canvas
					.locator( '[data-type="core/paragraph"]' )
					.first()
					.click();
				await page2.keyboard.press( 'End' );
				await page2.keyboard.type( ' B' );
				expect( Date.now() ).toBeLessThan( releaseAt );
				expect(
					String(
						( await editor2.getBlocks() )[ 0 ].attributes.content
					)
				).toBe( `${ shownBeforeSync } B` );
			}

			// Let the hold expire, the document land, and both windows
			// settle.
			await page2.waitForTimeout( HOLD_MS + 2000 );
			await waitForSyncQuiet( page2 );
			await waitForSyncQuiet( page );

			// Both windows agree, the peer's text survives exactly once,
			// and the typed text is kept. The two insertions were
			// concurrent, so their order is the engine's call.
			const acceptable = typeDuringHold
				? [
						`Existing content${ PEER_TEXT } B`,
						`Existing content B${ PEER_TEXT }`,
				  ]
				: [ `Existing content${ PEER_TEXT }` ];
			await expect( async () => {
				const text1 = String(
					( await editor.getBlocks() )[ 0 ].attributes.content
				);
				const text2 = String(
					( await editor2.getBlocks() )[ 0 ].attributes.content
				);
				expect( text2 ).toBe( text1 );
				expect( acceptable ).toContain( text1 );
			} ).toPass( { timeout: 10000 } );
		} );
	}

	test( 'the first paragraph typed into an EMPTY post before the delayed first sync response survives', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Late join, empty post',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );
		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		const releaseAt = Date.now() + HOLD_MS;
		( await holdSyncRequests( page2 ) )( releaseAt );
		await page2.reload();
		await collaborationUtils.waitForCollaborationReady( page2 );

		await editor2.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page2.keyboard.type( 'Hi' );
		expect( Date.now() ).toBeLessThan( releaseAt );

		await page2.waitForTimeout( HOLD_MS + 2000 );
		await waitForSyncQuiet( page2 );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks ).toMatchObject( [
					{
						name: 'core/paragraph',
						attributes: { content: 'Hi' },
					},
				] );
			} ).toPass( { timeout: 10000 } );
		}
	} );
} );
