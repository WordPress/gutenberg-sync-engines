/**
 * External dependencies
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * WordPress dependencies
 */
import { Editor } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import CollaborationUtils, {
	type UserCredentials,
} from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

type Session = {
	user: UserCredentials;
	context: BrowserContext;
	page: Page;
	editor: Editor;
};

/**
 * Login is test setup, not a login-form test. Authenticate through the same
 * WordPress endpoint using this context's request client and cookie jar.
 * wp_attempt_focus() can otherwise move focus during fill(), leaving the
 * password field empty and preventing submission altogether.
 *
 * @param context The joining user's empty browser context.
 * @param user    The test user's credentials.
 */
async function logIn( context: BrowserContext, user: UserCredentials ) {
	let response;
	try {
		response = await context.request.post( '/wp-login.php', {
			form: { log: user.username, pwd: user.password },
			maxRedirects: 0,
			timeout: 10000,
		} );
	} catch {
		// A request error can include the form body. Keep credentials out
		// of failure messages while identifying the failed setup step.
		throw new Error( 'Collaboration login request failed (10s limit).' );
	}
	try {
		const authenticated = ( await context.cookies() ).some(
			( cookie ) =>
				cookie.name.startsWith( 'wordpress_logged_in_' ) && cookie.value
		);
		if ( response.status() !== 302 || ! authenticated ) {
			throw new Error(
				`Collaboration login rejected (HTTP ${ response.status() }; no authenticated redirect).`
			);
		}
	} finally {
		await response.dispose();
	}
}

export default class AuthenticatedCollaborationUtils extends CollaborationUtils {
	private readonly joiningBrowser: Browser;

	constructor(
		options: ConstructorParameters< typeof CollaborationUtils >[ 0 ]
	) {
		super( options );
		this.joiningBrowser = options.admin.browser;
	}

	/**
	 * Open an authenticated collaborator without a focus-sensitive form or
	 * an unbounded navigation wait. Failed setup closes its context at once.
	 *
	 * @param postId The post to open.
	 * @param user   Credentials for the user joining.
	 * @return The joined user's page and editor.
	 */
	async joinUser( postId: number, user: UserCredentials ) {
		const context = await this.joiningBrowser.newContext( {
			baseURL: process.env.WP_BASE_URL || 'http://localhost:8889',
			storageState: { cookies: [], origins: [] },
		} );
		try {
			context.setDefaultTimeout( 10000 );
			context.setDefaultNavigationTimeout( 30000 );
			await logIn( context, user );
			const page = await context.newPage();
			await page.goto(
				`/wp-admin/post.php?post=${ postId }&action=edit`,
				{
					waitUntil: 'domcontentloaded',
				}
			);
			await this.waitForCollaborationReady( page );
			await page.evaluate( () => {
				const preferences =
					window.wp.data.dispatch( 'core/preferences' );
				preferences.set( 'core/edit-post', 'welcomeGuide', false );
				preferences.set( 'core/edit-post', 'fullscreenMode', false );
			} );
			const editor = new Editor( { page } );
			// The pinned fixture has no registration hook. Keep its session
			// list so inherited discovery, getters, and teardown include this
			// user. The regression test exercises that inherited contract.
			( this as unknown as { sessions: Session[] } ).sessions.push( {
				user,
				context,
				page,
				editor,
			} );
			return { page, editor };
		} catch ( error ) {
			await context.close().catch( () => {} );
			throw error;
		}
	}
}
