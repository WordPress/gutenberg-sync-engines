/**
 * External dependencies
 */
import * as path from 'path';

/**
 * WordPress dependencies
 */
import {
	PageUtils,
	type RequestUtils,
} from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';
import { SECOND_USER } from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

/**
 * Multi-client content preservation, run against ALL THREE engines.
 *
 * Each scenario opens a two-client session and drives realistic edit
 * traffic through the full stack (capture bridge → session codec →
 * transport → server engine → back), asserting that every edit is
 * preserved on both clients AND in the content persisted by a save:
 *
 * 1. a mix of block types (list, image, table, quote);
 * 2. nested blocks (paragraphs inside group / columns);
 * 3. pasting over the entire existing document;
 * 4. non-content entity fields (status, tags, excerpt) riding saves
 *    while content syncs live.
 *
 * The whole suite runs once per engine: the describes flip the site's
 * `wp_sync_engine` option and restore the default when done. Every test
 * creates a fresh post, so each room's engine lineage matches the flip.
 */

const ENGINES = [ 'intent-log', 'yjs-server', 'de-rtc' ] as const;

const TEST_IMAGE_PATH = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'gutenberg',
	'test',
	'e2e',
	'assets',
	'10x10_e2e_test_image_z9T8jK.png'
);

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		// Nulling an already-absent option 500s (rest_invalid_stored_value:
		// the settings controller validates the stored value first, and an
		// absent row reads as `false`). Restore only while one of THIS
		// suite's flips is still in effect.
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if ( ! ENGINES.includes( settings.wp_sync_engine ) ) {
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
 * Click into a content area, select its text, and type replacement text.
 *
 * @param page    The page owning the keyboard.
 * @param locator The contenteditable region to rewrite.
 * @param text    Replacement text.
 */
async function clearAndType(
	page: import('@playwright/test').Page,
	locator: import('@playwright/test').Locator,
	text: string
) {
	await locator.click();
	await page.keyboard.press( 'ControlOrMeta+a' );
	await page.keyboard.type( text );
}

for ( const engine of ENGINES ) {
	test.describe( `Collaboration multi-client content - ${ engine } engine @engine-${ engine }`, () => {
		// Per TEST, after fixture setup: the collaboration fixture's
		// writing-form toggle must never be able to wipe the engine
		// selection between the flip and the pages loading.
		test.beforeEach( async ( { requestUtils } ) => {
			await setSyncEngine( requestUtils, engine );
		} );

		test.afterAll( async ( { requestUtils } ) => {
			await setSyncEngine( requestUtils, null );
		} );

		test( 'a mix of block types syncs live and takes edits from the peer', async ( {
			collaborationUtils,
			requestUtils,
			editor,
		} ) => {
			test.setTimeout( 120_000 );

			const media = await requestUtils.uploadMedia( TEST_IMAGE_PATH );
			const post = await requestUtils.createPost( {
				title: `Block Variety (${ engine })`,
				status: 'draft',
				content: '',
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;

			// User A builds the document live: list, image, table, quote.
			await editor.insertBlock( {
				name: 'core/list',
				innerBlocks: [
					{
						name: 'core/list-item',
						attributes: { content: 'Item one' },
					},
					{
						name: 'core/list-item',
						attributes: { content: 'Item two' },
					},
				],
			} );
			await editor.insertBlock( {
				name: 'core/image',
				attributes: {
					id: media.id,
					url: media.source_url,
					alt: 'Test image',
					caption: 'Caption from A',
				},
			} );
			await editor.insertBlock( {
				name: 'core/table',
				attributes: {
					caption: 'Table from A',
					body: [
						{
							cells: [
								{ content: 'Cell 1', tag: 'td' },
								{ content: 'Cell 2', tag: 'td' },
							],
						},
					],
				},
			} );
			await editor.insertBlock( {
				name: 'core/quote',
				attributes: { citation: 'Citation from A' },
				innerBlocks: [
					{
						name: 'core/paragraph',
						attributes: { content: 'Quoted text' },
					},
				],
			} );

			// The peer receives the full structure; wait for byte-level
			// convergence (not just block names) before editing on top.
			await expect
				.poll(
					async () =>
						( await editor2.getBlocks() ).map(
							( block ) => block.name
						),
					{ timeout: 15_000 }
				)
				.toEqual( [
					'core/list',
					'core/image',
					'core/table',
					'core/quote',
				] );
			await collaborationUtils.waitForConvergence();

			// User B edits every block type.
			await clearAndType(
				page2,
				editor2.canvas
					.locator(
						'[data-type="core/list"] [data-type="core/list-item"]'
					)
					.first(),
				'Item one edited by B'
			);
			await clearAndType(
				page2,
				editor2.canvas.locator( '[data-type="core/image"] figcaption' ),
				'Caption edited by B'
			);
			await clearAndType(
				page2,
				editor2.canvas.locator( '[data-type="core/table"] figcaption' ),
				'Table caption edited by B'
			);
			await editor2.canvas
				.locator( '[data-type="core/table"] td' )
				.first()
				.click();
			await page2.keyboard.press( 'End' );
			await page2.keyboard.type( ' plus B' );
			await clearAndType(
				page2,
				editor2.canvas.locator(
					'[data-type="core/quote"] [data-type="core/paragraph"]'
				),
				'Quote edited by B'
			);

			// User A sees every edit, with untouched siblings intact.
			await expect
				.poll( () => editor.getBlocks(), { timeout: 15_000 } )
				.toMatchObject( [
					{
						name: 'core/list',
						innerBlocks: [
							{
								attributes: {
									content: 'Item one edited by B',
								},
							},
							{ attributes: { content: 'Item two' } },
						],
					},
					{
						name: 'core/image',
						attributes: {
							caption: 'Caption edited by B',
							alt: 'Test image',
						},
					},
					{
						name: 'core/table',
						attributes: {
							caption: 'Table caption edited by B',
							body: [
								{
									cells: [
										{ content: 'Cell 1 plus B' },
										{ content: 'Cell 2' },
									],
								},
							],
						},
					},
					{
						name: 'core/quote',
						attributes: { citation: 'Citation from A' },
						innerBlocks: [
							{
								attributes: {
									content: 'Quote edited by B',
								},
							},
						],
					},
				] );

			// Both clients converge on identical state; a save persists it.
			await collaborationUtils.waitForConvergence();
			await editor.saveDraft();
			const saved = await requestUtils.rest< {
				content: { raw: string };
			} >( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			for ( const marker of [
				'wp:list',
				'wp:image',
				'wp:table',
				'wp:quote',
				'Item one edited by B',
				'Caption edited by B',
				'Table caption edited by B',
				'Cell 1 plus B',
				'Quote edited by B',
			] ) {
				expect( saved.content.raw ).toContain( marker );
			}
		} );

		test( 'nested blocks: concurrent edits inside group and columns all survive', async ( {
			collaborationUtils,
			requestUtils,
			editor,
		} ) => {
			test.setTimeout( 120_000 );

			const post = await requestUtils.createPost( {
				title: `Nested Blocks (${ engine })`,
				status: 'draft',
				content: '',
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;
			const page1 = editor.page;

			// User A builds nested structures live.
			await editor.insertBlock( {
				name: 'core/group',
				innerBlocks: [
					{
						name: 'core/paragraph',
						attributes: { content: 'Group paragraph' },
					},
				],
			} );
			await editor.insertBlock( {
				name: 'core/columns',
				innerBlocks: [
					{
						name: 'core/column',
						innerBlocks: [
							{
								name: 'core/paragraph',
								attributes: { content: 'Column one text' },
							},
						],
					},
					{
						name: 'core/column',
						innerBlocks: [
							{
								name: 'core/paragraph',
								attributes: { content: 'Column two text' },
							},
						],
					},
				],
			} );

			await expect
				.poll(
					async () =>
						( await editor2.getBlocks() ).map(
							( block ) => block.name
						),
					{ timeout: 15_000 }
				)
				.toEqual( [ 'core/group', 'core/columns' ] );
			await collaborationUtils.waitForConvergence();

			// Truly concurrent nested edits in DIFFERENT branches of the
			// tree: B rewrites the group's paragraph while A appends inside
			// the second column.
			await editor2.canvas
				.locator(
					'[data-type="core/group"] [data-type="core/paragraph"]'
				)
				.click();
			await page2.keyboard.press( 'ControlOrMeta+a' );
			await editor.canvas
				.locator(
					'[data-type="core/columns"] [data-type="core/column"]:nth-child(2) [data-type="core/paragraph"]'
				)
				.click();
			await page1.keyboard.press( 'End' );
			await Promise.all( [
				page2.keyboard.type( 'Group paragraph rewritten by B' ),
				page1.keyboard.type( ' plus A' ),
			] );

			if ( 'de-rtc' === engine ) {
				/*
				 * Under de-rtc, a STRUCTURAL edit truly concurrent with a
				 * text edit in the SAME top-level block (B's insertion into
				 * column one while A types in column two) is a by-design
				 * escalation, not a merge — whole-content proposals park
				 * the conflict for human review (the engine's own
				 * review-lane spec exercises that path). Let the concurrent
				 * TEXT edits settle first so this scenario certifies
				 * nested-structure sync within the engine's merge contract.
				 */
				await expect
					.poll( () => editor.getBlocks(), { timeout: 15_000 } )
					.toMatchObject( [
						{
							innerBlocks: [
								{
									attributes: {
										content:
											'Group paragraph rewritten by B',
									},
								},
							],
						},
						{},
					] );
				await collaborationUtils.waitForConvergence();
			}

			// B also inserts a NEW paragraph inside column one (nested
			// insertion, not just nested text edits).
			await page2.evaluate( () => {
				const { select, dispatch } = ( window as any ).wp.data;
				const blocks = select( 'core/block-editor' ).getBlocks();
				const columns = blocks.find(
					( block: { name: string } ) => 'core/columns' === block.name
				);
				const column = columns?.innerBlocks?.[ 0 ];
				if ( ! column ) {
					throw new Error( 'Column one not found on user B' );
				}
				const paragraph = ( window as any ).wp.blocks.createBlock(
					'core/paragraph',
					{ content: 'Inserted into column one by B' }
				);
				dispatch( 'core/block-editor' ).insertBlock(
					paragraph,
					1,
					column.clientId
				);
			} );

			// Every nested edit lands on user A, structure intact.
			await expect
				.poll( () => editor.getBlocks(), { timeout: 15_000 } )
				.toMatchObject( [
					{
						name: 'core/group',
						innerBlocks: [
							{
								name: 'core/paragraph',
								attributes: {
									content: 'Group paragraph rewritten by B',
								},
							},
						],
					},
					{
						name: 'core/columns',
						innerBlocks: [
							{
								name: 'core/column',
								innerBlocks: [
									{
										attributes: {
											content: 'Column one text',
										},
									},
									{
										attributes: {
											content:
												'Inserted into column one by B',
										},
									},
								],
							},
							{
								name: 'core/column',
								innerBlocks: [
									{
										attributes: {
											content: 'Column two text plus A',
										},
									},
								],
							},
						],
					},
				] );

			// Both clients converge on identical trees; a save persists them.
			await collaborationUtils.waitForConvergence();
			await editor.saveDraft();
			const saved = await requestUtils.rest< {
				content: { raw: string };
			} >( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			for ( const marker of [
				'wp:group',
				'wp:columns',
				'Group paragraph rewritten by B',
				'Inserted into column one by B',
				'Column two text plus A',
			] ) {
				expect( saved.content.raw ).toContain( marker );
			}
		} );

		test( 'pasting over the entire document replaces content for both users', async ( {
			collaborationUtils,
			requestUtils,
			editor,
			pageUtils,
		} ) => {
			test.setTimeout( 120_000 );

			const post = await requestUtils.createPost( {
				title: `Paste Over (${ engine })`,
				status: 'draft',
				content:
					'<!-- wp:paragraph -->\n<p>Original first paragraph</p>\n<!-- /wp:paragraph -->\n\n' +
					'<!-- wp:paragraph -->\n<p>Original second paragraph</p>\n<!-- /wp:paragraph -->',
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;

			// User A selects the whole document (select-all twice: text,
			// then all blocks) and pastes multi-block content over it.
			await editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await pageUtils.pressKeys( 'primary+a' );
			await pageUtils.pressKeys( 'primary+a' );
			await pageUtils.setClipboardData( {
				html:
					'<h2>Pasted heading</h2>' +
					'<ul><li>Pasted item one</li><li>Pasted item two</li></ul>' +
					'<p>Pasted closing paragraph</p>',
			} );
			await pageUtils.pressKeys( 'primary+v' );

			// The paste replaced the document locally…
			await expect
				.poll(
					async () =>
						( await editor.getBlocks() ).map(
							( block ) => block.name
						),
					{ timeout: 15_000 }
				)
				.toEqual( [ 'core/heading', 'core/list', 'core/paragraph' ] );

			// …and the peer converges on the pasted document with the
			// original content fully gone.
			await expect
				.poll(
					async () =>
						( await editor2.getBlocks() ).map(
							( block ) => block.name
						),
					{ timeout: 15_000 }
				)
				.toEqual( [ 'core/heading', 'core/list', 'core/paragraph' ] );
			const convergedState =
				await collaborationUtils.waitForConvergence();
			expect( JSON.stringify( convergedState ) ).not.toContain(
				'Original first paragraph'
			);
			expect( JSON.stringify( convergedState ) ).toContain(
				'Pasted item two'
			);

			// Pasted blocks stay collaborative: B extends the pasted
			// paragraph and A sees it.
			await editor2.canvas
				.locator( '[data-type="core/paragraph"]' )
				.last()
				.click();
			await page2.keyboard.press( 'End' );
			await page2.keyboard.type( ' extended by B' );
			await expect( async () => {
				const blocks = await editor.getBlocks();
				expect( blocks[ blocks.length - 1 ].attributes.content ).toBe(
					'Pasted closing paragraph extended by B'
				);
			} ).toPass( { timeout: 15_000 } );

			await editor.saveDraft();
			const saved = await requestUtils.rest< {
				content: { raw: string };
			} >( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			expect( saved.content.raw ).toContain( 'Pasted heading' );
			expect( saved.content.raw ).toContain( 'Pasted item one' );
			expect( saved.content.raw ).toContain(
				'Pasted closing paragraph extended by B'
			);
			expect( saved.content.raw ).not.toContain(
				'Original first paragraph'
			);
			expect( saved.content.raw ).not.toContain(
				'Original second paragraph'
			);
		} );

		test( 'a late joiner pasting over the document removes blocks saved mid-session', async ( {
			collaborationUtils,
			requestUtils,
			editor,
		} ) => {
			test.setTimeout( 120_000 );

			// Seeding diversity: the room's bootstrap document and the
			// content a late joiner loads are DIFFERENT proofs of what that
			// joiner has displayed. The mid-session block below exists only
			// as post-genesis history plus a persisted syncId in the saved
			// content — a wholesale first edit by the late joiner must
			// delete it too, not resurrect it.
			const post = await requestUtils.createPost( {
				title: `Late Joiner Paste (${ engine })`,
				status: 'draft',
				content:
					'<!-- wp:paragraph -->\n<p>Original seeded paragraph</p>\n<!-- /wp:paragraph -->',
				date_gmt: new Date().toISOString(),
			} );

			// User A opens ALONE; the room bootstraps from the single
			// original paragraph.
			await collaborationUtils.openPost( post.id );

			// A adds a block mid-session and saves, persisting both blocks'
			// syncIds into the post content. Wait for the serialized content
			// to SETTLE first: the engine's minted identity reaches the
			// canvas via an entity push, and a save racing that propagation
			// can persist the newborn block id-less — a shape record-based
			// display seeding cannot cover for the joiner (kept out of this
			// spec's scope; see the id-stability spec for the contract).
			await editor.insertBlock( {
				name: 'core/paragraph',
				attributes: { content: 'Added mid-session by A' },
			} );
			const page1 = editor.page;
			await expect( async () => {
				const before = await page1.evaluate( () =>
					( window as any ).wp.data
						.select( 'core/editor' )
						.getEditedPostContent()
				);
				await page1.waitForTimeout( 1500 );
				const after = await page1.evaluate( () =>
					( window as any ).wp.data
						.select( 'core/editor' )
						.getEditedPostContent()
				);
				expect( after ).toBe( before );
			} ).toPass( { timeout: 30_000 } );
			await editor.saveDraft();

			// B joins AFTER the save: its editor renders the two saved
			// blocks while the room replays them as history.
			await collaborationUtils.joinUser( post.id, SECOND_USER );
			await collaborationUtils.waitForMutualDiscovery();
			const { editor2, page2 } = collaborationUtils;
			const pageUtils2 = new PageUtils( {
				page: page2,
				browserName: 'chromium',
			} );

			// B's FIRST action: select the whole document and paste over it.
			await editor2.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await pageUtils2.pressKeys( 'primary+a' );
			await pageUtils2.pressKeys( 'primary+a' );
			await pageUtils2.setClipboardData( {
				html: '<p>Late joiner replacement paragraph</p>',
			} );
			await pageUtils2.pressKeys( 'primary+v' );

			// Both editors converge on the replacement ALONE; neither
			// original may resurrect.
			for ( const currentEditor of [ editor, editor2 ] ) {
				await expect( async () => {
					const blocks = await currentEditor.getBlocks();
					expect(
						blocks.map( ( block ) => block.attributes.content )
					).toEqual( [ 'Late joiner replacement paragraph' ] );
				} ).toPass( { timeout: 15_000 } );
			}
			// Sustained: still converged after a settle window (no
			// delete/reinsert war, no late resurrection).
			await page2.waitForTimeout( 3000 );
			await collaborationUtils.waitForConvergence();
			for ( const currentEditor of [ editor, editor2 ] ) {
				await expect(
					currentEditor.canvas.locator(
						'[data-type="core/paragraph"]'
					)
				).toHaveCount( 1 );
			}

			await editor2.saveDraft();
			const saved = await requestUtils.rest< {
				content: { raw: string };
			} >( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			expect( saved.content.raw ).toContain(
				'Late joiner replacement paragraph'
			);
			expect( saved.content.raw ).not.toContain(
				'Original seeded paragraph'
			);
			expect( saved.content.raw ).not.toContain(
				'Added mid-session by A'
			);
		} );

		test( 'non-content fields (status, tags, excerpt) survive both users’ saves', async ( {
			collaborationUtils,
			requestUtils,
			editor,
		} ) => {
			test.setTimeout( 120_000 );

			// Fresh tags per run so reruns never collide on term names.
			const stamp = Date.now();
			const tagIds: number[] = [];
			for ( const name of [ 'alpha', 'beta' ] ) {
				const tag = await requestUtils.rest( {
					method: 'POST',
					path: '/wp/v2/tags',
					data: { name: `rtc-${ engine }-${ name }-${ stamp }` },
				} );
				tagIds.push( tag.id );
			}

			const post = await requestUtils.createPost( {
				title: `Non-content Fields (${ engine })`,
				status: 'draft',
				content:
					'<!-- wp:paragraph -->\n<p>Body text</p>\n<!-- /wp:paragraph -->',
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;
			const page1 = editor.page;

			// User A updates non-content fields in the editor. Scalar
			// properties (status, excerpt) and taxonomy terms (tags)
			// live-sync under both engines; either way, the engine must
			// neither corrupt these fields nor let a collaborator's later
			// save clobber them.
			await page1.evaluate( ( ids ) => {
				( window as any ).wp.data.dispatch( 'core/editor' ).editPost( {
					status: 'pending',
					tags: ids,
					excerpt: 'Excerpt from user one',
				} );
			}, tagIds );
			await page1.evaluate( async () => {
				await ( window as any ).wp.data
					.dispatch( 'core/editor' )
					.savePost();
			} );

			const afterFirstSave = await requestUtils.rest( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			expect( afterFirstSave.status ).toBe( 'pending' );
			expect( afterFirstSave.tags ).toEqual(
				expect.arrayContaining( tagIds )
			);
			expect( afterFirstSave.excerpt.raw ).toBe(
				'Excerpt from user one'
			);

			// Content keeps syncing live around the field updates: B edits
			// the paragraph and A receives it.
			await editor2.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await page2.keyboard.press( 'End' );
			await page2.keyboard.type( ' plus user two' );
			await expect( async () => {
				const blocks = await editor.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'Body text plus user two'
				);
			} ).toPass( { timeout: 15_000 } );

			// B saves AFTER A's field updates. B never touched status, tags,
			// or excerpt, so B's save must persist the synced content while
			// leaving A's fields exactly as saved.
			await page2.evaluate( async () => {
				await ( window as any ).wp.data
					.dispatch( 'core/editor' )
					.savePost();
			} );

			const afterSecondSave = await requestUtils.rest( {
				path: `/wp/v2/posts/${ post.id }`,
				params: { context: 'edit' },
			} );
			expect( afterSecondSave.content.raw ).toContain(
				'Body text plus user two'
			);
			expect( afterSecondSave.status ).toBe( 'pending' );
			expect( afterSecondSave.tags ).toEqual(
				expect.arrayContaining( tagIds )
			);
			expect( afterSecondSave.excerpt.raw ).toBe(
				'Excerpt from user one'
			);
		} );
	} );
}
