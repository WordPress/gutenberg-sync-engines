/**
 * WordPress dependencies
 */
import { test, expect } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { setCollaboration } from './gutenberg-collaboration/fixtures/collaboration-utils';

test( 'a missing selected provider restores post locking without starting another sync engine', async ( {
	page,
	admin,
	requestUtils,
} ) => {
	const settings = await requestUtils.rest( { path: '/wp/v2/settings' } );
	let blocked = 0;
	const syncRequests: string[] = [];
	await page.route( '**/build/sync-engines.js*', async ( route ) => {
		blocked++;
		await route.fulfill( { contentType: 'text/javascript', body: '' } );
	} );
	page.on( 'request', ( request ) => {
		if ( request.url().includes( '/wp-sync/v1/updates' ) ) {
			syncRequests.push( request.url() );
		}
	} );
	try {
		await setCollaboration( requestUtils, true );
		const post = await requestUtils.createPost( {
			title: 'Missing sync provider',
			status: 'draft',
			content:
				'<!-- wp:paragraph --><p>Saved content</p><!-- /wp:paragraph -->',
		} );
		await admin.visitAdminPage(
			'post.php',
			`post=${ post.id }&action=edit`
		);
		await expect(
			page
				.getByLabel( 'Editor content' )
				.getByText( /Standard post locking is in effect/ )
		).toBeVisible();
		expect( blocked ).toBe( 1 );
		expect(
			await page.evaluate( () => {
				const { unlock } =
					window.wp.privateApis.__dangerousOptInToUnstableAPIsOnlyForCoreModules(
						'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.',
						'@wordpress/core-data'
					);
				return unlock(
					window.wp.data.select( 'core' )
				).isCollaborationSupported();
			} )
		).toBe( false );
		expect( syncRequests ).toEqual( [] );
	} finally {
		await requestUtils.rest( {
			path: '/wp/v2/settings',
			method: 'POST',
			data: {
				'gutenberg-experiments': settings[ 'gutenberg-experiments' ],
			},
		} );
	}
} );
