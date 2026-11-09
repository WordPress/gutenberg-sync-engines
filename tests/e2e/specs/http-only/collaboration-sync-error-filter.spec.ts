/**
 * Internal dependencies
 */
import { test, expect } from '../../config/collaboration-fixtures';
import { SECOND_USER } from '../../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';
import type { UserCredentials } from '../../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

const BASE_URL = process.env.WP_BASE_URL || 'http://localhost:8889';

// Four filler users plus the first editor reach the five-peer default.
const FILLER_USERS: UserCredentials[] = Array.from(
	{ length: 4 },
	( _, index ) => ( {
		username: `filler_editor_${ index + 1 }`,
		email: `filler${ index + 1 }@example.com`,
		firstName: 'Filler',
		lastName: String( index + 1 ),
		password: 'password',
		roles: [ 'editor' ],
	} )
);

test.describe( 'Sync connection error filter', () => {
	test.beforeAll( async ( { requestUtils } ) => {
		await requestUtils.activatePlugin(
			'gutenberg-test-plugin-sync-connection-error-filter'
		);
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await requestUtils.deactivatePlugin(
			'gutenberg-test-plugin-sync-connection-error-filter'
		);
	} );

	test( 'plugin can replace the default modal for connection-limit-exceeded', async ( {
		collaborationUtils,
		requestUtils,
		admin,
	} ) => {
		// Six logged-in editor clients (admin, four fillers, and the
		// over-limit sixth user) make this the heaviest setup in the
		// suite; the happy path can exceed the 60 s default cap on CI.
		test.setTimeout( 180_000 );

		// Create filler users inside the test, after the fixture's
		// deleteAllUsers() has run.
		for ( const user of FILLER_USERS ) {
			await requestUtils.createUser( user );
		}

		const post = await requestUtils.createPost( {
			title: 'Sync Error Filter Test',
			status: 'draft',
			date_gmt: new Date().toISOString(),
		} );

		// Admin opens the post (1st client).
		await collaborationUtils.openPost( post.id );

		// Four filler users join to reach the default limit of 5.
		for ( const user of FILLER_USERS ) {
			await collaborationUtils.joinUser( post.id, user );
		}
		await collaborationUtils.waitForMutualDiscovery();

		// The second user (6th client) opens the post, exceeding the
		// default connection limit. This triggers CONNECTION_LIMIT_EXCEEDED
		// on their first poll response.
		/*
		 * Clean storage state, for the same reason as the collaboration
		 * fixture's joinUser: an inherited admin cookie makes wp-login.php
		 * render a wp_attempt_focus() script that clears the password field
		 * 200ms after load, racing the fill below and silently blocking the
		 * submit.
		 */
		const sixthContext = await admin.browser.newContext( {
			baseURL: BASE_URL,
			storageState: { cookies: [], origins: [] },
		} );
		const page6 = await sixthContext.newPage();

		try {
			await page6.goto( '/wp-login.php' );
			await page6.locator( '#user_login' ).fill( SECOND_USER.username );
			await page6.locator( '#user_pass' ).fill( SECOND_USER.password );
			await page6.getByRole( 'button', { name: 'Log In' } ).click();
			await page6.waitForURL( '**/wp-admin/**' );

			await page6.goto(
				`/wp-admin/post.php?post=${ post.id }&action=edit`
			);

			// The plugin's filter returns true for connection-limit-exceeded,
			// suppressing the default modal. The plugin renders its own modal.
			const customModal = page6.getByRole( 'dialog', {
				name: 'Collaboration limit reached',
			} );
			await expect( customModal ).toBeVisible( { timeout: 30000 } );

			// Verify the custom message.
			await expect(
				customModal.getByText(
					'Consider upgrading your hosting plan to increase the collaboration limits.'
				)
			).toBeVisible();

			// Verify the custom "Upgrade Plan" button.
			await expect(
				customModal.getByRole( 'link', { name: 'Upgrade Plan' } )
			).toBeVisible();

			// The default modal should NOT be visible.
			const defaultModal = page6.getByRole( 'dialog', {
				name: 'Too many editors connected',
			} );
			await expect( defaultModal ).toBeHidden();
		} finally {
			await sixthContext.close();
		}
	} );
} );
