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
 * Two-client collaboration through the yjs-server sync engine: the same
 * CRDT wire documents as the relay, but the SERVER (via the vendored y-php)
 * holds the canonical document, provides genesis from post content, merges
 * every update, and compacts by itself.
 *
 * These specs flip the site's `wp_sync_engine` option to `yjs-server` and
 * exercise the full stack: editor changes → yjs-server session codec →
 * polling transport → WP_Yjs_Server_Engine (y-php merge) → back. The suite
 * restores the default engine when done.
 */

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		// Nulling an already-absent option 500s (see the intent-log spec's
		// identical helper): restore only while our flip is in effect.
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if ( 'yjs-server' !== settings.wp_sync_engine ) {
			return;
		}
	}
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: { wp_sync_engine: engine },
	} );
}

/**
 * Waits until the page's sync traffic has been quiet for a moment: no
 * request to the sync endpoint for QUIET_MS, checked for up to MAX_MS. A
 * lone tab polls only on demand, so this is the wait for "its queued work
 * has gone out" (a fixed number of future polls may never come).
 *
 * @param page The page to watch.
 */
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

test.describe( 'Collaboration - yjs-server engine @engine-yjs-server', () => {
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'yjs-server' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	test( 'syncs text edits between two users from a server-side genesis', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Yjs Server Sync Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;

		// Both clients bootstrapped from the SERVER's genesis snapshot (the
		// document was never seeded client-side).
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

		// User 1 appends a paragraph.
		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Written by user one' },
		} );

		// User 2 sees both paragraphs.
		await expect( async () => {
			const blocks = await editor2.getBlocks();
			expect( blocks ).toMatchObject( [
				{
					name: 'core/paragraph',
					attributes: { content: 'Existing content' },
				},
				{
					name: 'core/paragraph',
					attributes: { content: 'Written by user one' },
				},
			] );
		} ).toPass( { timeout: 10000 } );

		// User 2 edits the first paragraph; user 1 sees the edit.
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await collaborationUtils.page2.keyboard.press( 'End' );
		await collaborationUtils.page2.keyboard.type( ' plus user two' );

		await expect( async () => {
			const blocks = await editor.getBlocks();
			expect( blocks[ 0 ].attributes.content ).toBe(
				'Existing content plus user two'
			);
		} ).toPass( { timeout: 10000 } );
	} );

	test( 'both users typing on an EMPTY post converge without deleting each other', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The empty-genesis shape: the server's snapshot carries no blocks,
		// each client authors its first paragraph locally (buffered until
		// the snapshot lands), and the CRDT merge must keep both.
		const post = await requestUtils.createPost( {
			title: 'Yjs Server Empty Post Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'First author paragraph' );
		await editor2.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page2.keyboard.type( 'Second author paragraph' );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				const contents = blocks.map(
					( block ) => block.attributes.content
				);
				expect( contents ).toEqual(
					expect.arrayContaining( [
						'First author paragraph',
						'Second author paragraph',
					] )
				);
			} ).toPass( { timeout: 15000 } );
		}

		// And they STAY converged (no delete/reinsert war).
		await page1.waitForTimeout( 3000 );
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect(
				currentEditor.canvas.locator( '[data-type="core/paragraph"]' )
			).toHaveCount( 2 );
		}
	} );

	test( 'concurrent edits to different blocks both survive', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Yjs Server Concurrency Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.nth( 1 )
			.click();
		await page2.keyboard.press( 'End' );

		await page1.keyboard.type( ' from one' );
		await page2.keyboard.type( ' from two' );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First from one'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second from two'
				);
			} ).toPass( { timeout: 10000 } );
		}
	} );

	test( 'a save captures both users’ settled edits and persists clean content', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Yjs Server Save Flow Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Shared start</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' plus user two' );

		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Added by admin' },
		} );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks ).toMatchObject( [
					{
						attributes: {
							content: 'Shared start plus user two',
						},
					},
					{ attributes: { content: 'Added by admin' } },
				] );
			} ).toPass( { timeout: 15000 } );
		}

		await editor.saveDraft();

		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain( 'Shared start plus user two' );
		expect( saved.content.raw ).toContain( 'Added by admin' );

		// The non-saving peer's editor is unaffected by the save.
		const peerBlocks = await editor2.getBlocks();
		expect( peerBlocks ).toMatchObject( [
			{ attributes: { content: 'Shared start plus user two' } },
			{ attributes: { content: 'Added by admin' } },
		] );
	} );

	test( 'a solo session’s edits survive save and reload (new post flow)', async ( {
		collaborationUtils,
		admin,
		editor,
		page,
	} ) => {
		/*
		 * The post-new.php shape: the room's genesis snapshot is built from
		 * an EMPTY auto-draft, so everything typed in this session reaches
		 * the room only as sync updates. The session is SOLO, which is the
		 * regression surface: a lone tab schedules no polls, so its updates
		 * must still go out on demand (one request after the first queued
		 * update), and a reload bootstraps the editor from the server's document —
		 * if the solo updates never landed, the stale empty snapshot wipes
		 * the freshly loaded title and content.
		 */
		await admin.createNewPost();
		await collaborationUtils.waitForCollaborationReady( page );

		await editor.canvas
			.getByRole( 'textbox', { name: 'Add title' } )
			.fill( 'Solo reload title' );
		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page.keyboard.type( 'Solo reload body' );

		// A lone tab holds its work and flushes it through the room right
		// before the save, so wait for the save's own response (saveDraft
		// resolves on a notice) and then for the sync traffic to go quiet.
		const saved = page.waitForResponse(
			( response ) =>
				decodeURIComponent( response.url() ).includes(
					'/wp/v2/posts/'
				) && 'POST' === response.request().method()
		);
		await editor.saveDraft();
		await saved;
		await waitForSyncQuiet( page );

		await page.reload();
		await collaborationUtils.waitForCollaborationReady( page );

		// Let the fresh session bootstrap from the server's snapshot and
		// settle: before the fix this is when the editor got wiped.
		await waitForSyncQuiet( page );

		await expect(
			editor.canvas.getByRole( 'textbox', { name: 'Add title' } )
		).toHaveText( 'Solo reload title' );

		const blocks = await editor.getBlocks();
		expect( blocks ).toMatchObject( [
			{
				name: 'core/paragraph',
				attributes: { content: 'Solo reload body' },
			},
		] );
	} );

	test( 'merely opening a post does not mark it dirty', async ( {
		collaborationUtils,
		requestUtils,
		page,
	} ) => {
		// Regression test for the bootstrap dirty state: the server's genesis
		// snapshot arrives as a remote change, and the dispatch that swapped
		// in the document's blocks used to register a dirtying `content` edit
		// even though nothing changed, activating the Save button and the
		// autosave timer on a post nobody touched. The fixture carries the
		// FULL seeded field surface (excerpt, tags, a real status/date) —
		// genesis now seeds every synced property, and a seeded value that
		// failed to byte-match the joiner's REST record would re-arm exactly
		// this bug as a spurious field edit.
		const tag = await requestUtils.rest( {
			method: 'POST',
			path: '/wp/v2/tags',
			data: { name: `yjs-dirty-open-${ Date.now() }` },
		} );
		const post = await requestUtils.createPost( {
			title: 'Yjs Server Dirty On Open Test',
			status: 'draft',
			excerpt: 'A seeded excerpt',
			tags: [ tag.id ],
			content:
				'<!-- wp:paragraph -->\n<p>Untouched content</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openPost( post.id );

		const getEditKeys = () =>
			page.evaluate( ( postId ) => {
				const edits = window.wp.data
					.select( 'core' )
					.getEntityRecordEdits( 'postType', 'post', postId );
				return Object.keys( edits ?? {} );
			}, post.id );

		// Wait for the server's genesis snapshot to bootstrap the session:
		// its dispatch registers the (transient, non-dirtying) `blocks` edit
		// that swaps in the document's block identities.
		await expect
			.poll( getEditKeys, { timeout: 20000 } )
			.toContain( 'blocks' );

		// The bootstrap dispatch is exactly the moment the regression fired.
		// Keep watching across further poll cycles to catch a delayed flip.
		const becameDirty = await page.evaluate(
			() =>
				new Promise( ( resolve ) => {
					const started = Date.now();
					const interval = setInterval( () => {
						const isDirty = window.wp.data
							.select( 'core/editor' )
							.isEditedPostDirty();
						if ( isDirty ) {
							clearInterval( interval );
							resolve( true );
						} else if ( Date.now() - started > 8000 ) {
							clearInterval( interval );
							resolve( false );
						}
					}, 200 );
				} )
		);
		expect( becameDirty ).toBe( false );

		// The dirtying half of the old dispatch must be gone for good.
		expect( await getEditKeys() ).not.toContain( 'content' );
	} );

	test( 'title edits sync between users in both directions', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Original Title',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;

		await editor.canvas
			.getByRole( 'textbox', { name: 'Add title' } )
			.fill( 'Title from user one' );
		await expect(
			editor2.canvas.getByRole( 'textbox', { name: 'Add title' } )
		).toHaveText( 'Title from user one', { timeout: 10000 } );

		await editor2.canvas
			.getByRole( 'textbox', { name: 'Add title' } )
			.fill( 'Title from user two' );
		await expect(
			editor.canvas.getByRole( 'textbox', { name: 'Add title' } )
		).toHaveText( 'Title from user two', { timeout: 10000 } );

		await editor.saveDraft();
		const saved = await requestUtils.rest< { title: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.title.raw ).toBe( 'Title from user two' );
	} );
} );
