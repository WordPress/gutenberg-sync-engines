/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';

test.describe( 'Semantic capture browser prototype @engine-yjs-server', () => {
	test.skip(
		process.env.GSE_SEMANTIC_PROTOTYPE !== '1',
		'Requires the separately built prototype framework.'
	);
	let previousEngine: string;
	let fixture: string;
	let previousStatus: string;
	test.beforeAll( async ( { requestUtils } ) => {
		const settings = await requestUtils.rest( { path: '/wp/v2/settings' } );
		previousEngine = settings.wp_sync_engine;
		const plugins = await requestUtils.rest( { path: '/wp/v2/plugins' } );
		const plugin = plugins.find( ( item: { name: string } ) =>
			item.name.includes( 'Semantic Capture Prototype' )
		);
		fixture = plugin.plugin;
		previousStatus = plugin.status;
		await requestUtils.rest( {
			method: 'PUT',
			path: `/wp/v2/plugins/${ fixture }`,
			data: { status: 'active' },
		} );
		await requestUtils.rest( {
			method: 'POST',
			path: '/wp/v2/settings',
			data: { wp_sync_engine: 'yjs-server' },
		} );
	} );
	test.afterAll( async ( { requestUtils } ) => {
		await requestUtils.rest( {
			method: 'PUT',
			path: `/wp/v2/plugins/${ fixture }`,
			data: { status: previousStatus },
		} );
		await requestUtils.rest( {
			method: 'POST',
			path: '/wp/v2/settings',
			data: { wp_sync_engine: previousEngine },
		} );
	} );

	test( 'captures real typing, splits and moves while two editors stay in sync', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	}, testInfo ) => {
		test.setTimeout( 120000 );
		const post = await requestUtils.createPost( {
			title: 'Semantic capture prototype',
			status: 'draft',
			content:
				'<!-- wp:paragraph --><p>Hello world</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Second paragraph</p><!-- /wp:paragraph -->',
		} );
		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page = editor.page;
		const history = ( target = page ) =>
			target.evaluate( () => ( window as any ).gseActionHistory );
		try {
			await expect( page.locator( '#gse-action-history' ) ).toBeVisible();
			await expect( async () => {
				expect(
					( await editor2.getBlocks() )[ 0 ].attributes.content
				).toBe( 'Hello world' );
			} ).toPass();
			await editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await page.keyboard.press( 'End' );
			await page.keyboard.type( '!' );
			await expect( async () => {
				expect(
					( await editor2.getBlocks() )[ 0 ].attributes.content
				).toBe( 'Hello world!' );
				expect( ( await history() ).stats.targeted ).toBeGreaterThan(
					0
				);
			} ).toPass( { timeout: 15000 } );
			// Receiving another person's update must not manufacture a local edit.
			expect( ( await history( page2 ) ).entries ).toHaveLength( 0 );
			await page.keyboard.press( 'Home' );
			for ( let i = 0; i < 5; i++ ) {
				await page.keyboard.press( 'ArrowRight' );
			}
			await page.keyboard.press( 'Enter' );
			await expect( async () => {
				const blocks = await editor2.getBlocks();
				expect(
					blocks.map( ( block ) => block.attributes.content )
				).toEqual( [ 'Hello', ' world!', 'Second paragraph' ] );
				expect(
					( await history() ).entries.some(
						( entry: any ) => entry.event?.kind === 'split'
					)
				).toBe( true );
			} ).toPass( { timeout: 15000 } );
			// The block toolbar invokes the real move command.
			await editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.last()
				.click();
			await editor.showBlockToolbar();
			await page
				.getByRole( 'button', { name: 'Move up', exact: true } )
				.click();
			await expect( async () => {
				const blocks = await editor2.getBlocks();
				expect(
					blocks.map( ( block ) => block.attributes.content )
				).toEqual( [ 'Hello', 'Second paragraph', ' world!' ] );
				expect(
					( await history() ).entries.some(
						( entry: any ) => entry.event?.kind === 'move'
					)
				).toBe( true );
			} ).toPass( { timeout: 15000 } );
			expect( ( await history( page2 ) ).entries ).toHaveLength( 0 );
			await editor2.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first()
				.click();
			await page2.keyboard.press( 'End' );
			await page2.keyboard.type( '?' );
			await expect( async () => {
				expect(
					( await editor.getBlocks() )[ 0 ].attributes.content
				).toBe( 'Hello?' );
				expect(
					( await history( page2 ) ).stats.targeted
				).toBeGreaterThan( 0 );
			} ).toPass( { timeout: 15000 } );
		} finally {
			await testInfo.attach( 'action-history', {
				body: JSON.stringify( await history(), null, 2 ),
				contentType: 'application/json',
			} );
		}
	} );
} );
