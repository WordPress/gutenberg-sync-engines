/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';

// Intent-log's contract and the other engines' observed baselines. The
// latter document limitations; they are not the desired split behavior.
const expected: Record< string, Record< string, string[] > > = {
	'intent-log': {
		append: [ 'Hello', 'World!' ],
		format: [ 'Hel<strong>lo</strong>', '<strong>Wo</strong>rld' ],
	},
	'yjs-server': {
		append: [ 'Hello!', 'World' ],
		format: [ 'Hel<strong>lor</strong>', 'World' ],
	},
	'de-rtc': { append: [ 'Hello!', 'World' ], format: [ 'Hello', 'World' ] },
};

for ( const engine of [ 'intent-log', 'yjs-server', 'de-rtc' ] ) {
	test.describe( `Text across a split - ${ engine }`, () => {
		test.beforeEach( async ( { requestUtils } ) => {
			await requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/settings',
				data: { wp_sync_engine: engine },
			} );
		} );
		test.afterAll( async ( { requestUtils } ) => {
			await requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/settings',
				data: { wp_sync_engine: 'intent-log' },
			} );
		} );
		for ( const edit of [ 'append', 'format' ] ) {
			test( `records delayed ${ edit } behavior across the split`, async ( {
				collaborationUtils,
				requestUtils,
				editor,
			}, testInfo ) => {
				const post = await requestUtils.createPost( {
					title: 'Text split comparison',
					status: 'draft',
					content:
						'<!-- wp:paragraph --><p>HelloWorld</p><!-- /wp:paragraph -->',
					date_gmt: new Date().toISOString(),
				} );
				await collaborationUtils.openCollaborativeSession( post.id );
				const { page2, editor2 } = collaborationUtils;
				const contents = async ( target: typeof editor ) =>
					( await target.getBlocks() ).map(
						( block ) => block.attributes.content
					);
				await expect
					.poll( () => contents( editor2 ) )
					.toEqual( [ 'HelloWorld' ] );
				let release!: () => void;
				const held = new Promise< void >( ( resolve ) => {
					release = resolve;
				} );
				await page2.route( /wp-sync|autosaves/, async ( route ) => {
					await held;
					await route.continue();
				} );
				try {
					await editor.canvas
						.locator( '[data-type="core/paragraph"]' )
						.first()
						.click();
					await editor.page.keyboard.press( 'End' );
					for ( let i = 0; i < 5; i++ ) {
						await editor.page.keyboard.press( 'ArrowLeft' );
					}
					const splitAccepted = editor.page.waitForResponse(
						( response ) =>
							/wp-sync|autosaves/.test( response.url() ) &&
							response.status() === 200 &&
							( engine !== 'de-rtc' ||
								response.url().includes( 'autosaves' ) ) &&
							( engine !== 'intent-log' ||
								(
									response.request().postData() ?? ''
								).includes( 'split_block' ) )
					);
					await editor.page.keyboard.press( 'Enter' );
					await expect
						.poll( () => contents( editor ) )
						.toEqual( [ 'Hello', 'World' ] );
					await splitAccepted;
					await editor2.canvas
						.locator( '[data-type="core/paragraph"]' )
						.first()
						.click();
					if ( edit === 'append' ) {
						await page2.keyboard.press( 'End' );
						await page2.keyboard.type( '!' );
						await expect
							.poll( () => contents( editor2 ) )
							.toEqual( [ 'HelloWorld!' ] );
					} else {
						await page2.keyboard.press( 'Home' );
						for ( let i = 0; i < 3; i++ ) {
							await page2.keyboard.press( 'ArrowRight' );
						}
						for ( let i = 0; i < 4; i++ ) {
							await page2.keyboard.press( 'Shift+ArrowRight' );
						}
						await page2.keyboard.press( 'ControlOrMeta+b' );
						await expect
							.poll( () => contents( editor2 ) )
							.toEqual( [ 'Hel<strong>loWo</strong>rld' ] );
					}
				} finally {
					release();
				}
				await expect( async () => {
					expect( await contents( editor ) ).toEqual(
						await contents( editor2 )
					);
					if ( edit === 'append' ) {
						expect(
							( await contents( editor ) ).join( '' )
						).toContain( '!' );
					}
				} ).toPass( { timeout: 20000 } );
				const actual = await contents( editor );
				expect( actual ).toEqual( expected[ engine ][ edit ] );
				if ( engine === 'de-rtc' && edit === 'format' ) {
					// The set-aside edit shows as a review card on the
					// block (the plugin's conflict review, src/review/).
					await expect(
						editor2.canvas
							.getByRole( 'button', {
								name: 'Review conflict',
								exact: true,
							} )
							.first()
					).toBeVisible( { timeout: 15000 } );
				}
				await testInfo.attach( 'split-result', {
					body: JSON.stringify( { engine, actual }, null, 2 ),
					contentType: 'application/json',
				} );
				if ( engine === 'intent-log' ) {
					await editor.saveDraft();
					await editor.page.reload();
					await expect
						.poll( () => contents( editor ) )
						.toEqual( actual );
				}
			} );
		}
	} );
}
