import { describe, expect, it, jest } from '@jest/globals';
import CollaborationUtils from '../../e2e/config/authenticated-collaboration-utils';

jest.mock( '@wordpress/e2e-test-utils-playwright', () => ( {
	Editor: jest.fn().mockImplementation( ( { page } ) => ( { page } ) ),
} ) );
// The pinned subtree resolves this package to its own built copy.
jest.mock(
	'../../../gutenberg/packages/e2e-test-utils-playwright/build',
	() => ( {
		Editor: jest.fn().mockImplementation( ( { page } ) => ( { page } ) ),
	} )
);

const user = { username: 'fixture-user', password: 'fixture-password' };

function setup( { status = 302, authenticated = true } = {} ) {
	const page = {
		goto: jest.fn().mockResolvedValue( undefined ),
		waitForFunction: jest.fn().mockResolvedValue( undefined ),
		evaluate: jest.fn().mockResolvedValue( undefined ),
		// Reproduce the trace's failed form submission: filling appears to
		// succeed, but focus moved and the login page never navigates.
		locator: () => ( { fill: jest.fn().mockResolvedValue( undefined ) } ),
		getByRole: () => ( {
			click: jest.fn().mockResolvedValue( undefined ),
		} ),
		waitForURL: jest
			.fn()
			.mockRejectedValue( new Error( 'Login form did not submit' ) ),
	};
	const response = {
		status: () => status,
		dispose: jest.fn().mockResolvedValue( undefined ),
	};
	const context = {
		newPage: jest.fn().mockResolvedValue( page ),
		request: { post: jest.fn().mockResolvedValue( response ) },
		cookies: jest
			.fn()
			.mockResolvedValue(
				authenticated
					? [ { name: 'wordpress_logged_in_test', value: 'session' } ]
					: []
			),
		close: jest.fn().mockResolvedValue( undefined ),
		setDefaultTimeout: jest.fn(),
		setDefaultNavigationTimeout: jest.fn(),
	};
	const browser = { newContext: jest.fn().mockResolvedValue( context ) };
	const primaryPage = {};
	const primaryEditor = {};
	const requestUtils = {
		deleteAllUsers: jest.fn().mockResolvedValue( undefined ),
	};
	const utils = new CollaborationUtils( {
		admin: { browser },
		editor: primaryEditor,
		page: primaryPage,
		requestUtils,
	} );
	return {
		utils,
		browser,
		context,
		page,
		response,
		primaryPage,
		primaryEditor,
		requestUtils,
	};
}

describe( 'collaborator login', () => {
	it( 'joins without the focus-sensitive login form and retains inherited session cleanup', async () => {
		const {
			utils,
			browser,
			context,
			page,
			response,
			primaryPage,
			primaryEditor,
			requestUtils,
		} = setup();
		const joined = await utils.joinUser( 42, user );
		expect( browser.newContext ).toHaveBeenCalledWith(
			expect.objectContaining( {
				storageState: { cookies: [], origins: [] },
			} )
		);
		expect( context.request.post ).toHaveBeenCalledWith(
			'/wp-login.php',
			expect.objectContaining( {
				form: { log: user.username, pwd: user.password },
				maxRedirects: 0,
				timeout: 10000,
			} )
		);
		expect( response.dispose ).toHaveBeenCalledTimes( 1 );
		expect( page.waitForURL ).not.toHaveBeenCalled();
		expect( page.goto ).toHaveBeenCalledTimes( 1 );
		expect( page.goto ).toHaveBeenCalledWith(
			'/wp-admin/post.php?post=42&action=edit',
			expect.objectContaining( { waitUntil: 'domcontentloaded' } )
		);
		expect( context.setDefaultNavigationTimeout ).toHaveBeenCalledWith(
			30000
		);
		expect( utils.allPages ).toEqual( [ primaryPage, joined.page ] );
		expect( utils.allEditors ).toEqual( [ primaryEditor, joined.editor ] );
		expect( utils.page2 ).toBe( page );
		expect( utils.getPage( 0 ) ).toBe( page );
		expect( utils.getEditor( 0 ) ).toBe( joined.editor );
		await utils.teardown();
		expect( context.close ).toHaveBeenCalledTimes( 1 );
		expect( requestUtils.deleteAllUsers ).toHaveBeenCalledTimes( 1 );
	} );

	it.each( [
		[ 200, false ],
		[ 403, false ],
		[ 302, false ],
	] )(
		'rejects an unsuccessful login (HTTP %s, cookie %s) without retrying',
		async ( status, authenticated ) => {
			const { utils, context, response, primaryPage } = setup( {
				status,
				authenticated,
			} );
			await expect( utils.joinUser( 42, user ) ).rejects.toThrow(
				/Collaboration login rejected/
			);
			expect( context.request.post ).toHaveBeenCalledTimes( 1 );
			expect( response.dispose ).toHaveBeenCalledTimes( 1 );
			expect( context.close ).toHaveBeenCalledTimes( 1 );
			expect( utils.allPages ).toEqual( [ primaryPage ] );
		}
	);

	it( 'reports a request failure without exposing credentials or waiting for the whole test', async () => {
		const { utils, context, primaryPage } = setup();
		context.request.post.mockRejectedValue(
			new Error( `Request timeout: pwd=${ user.password }` )
		);
		await expect( utils.joinUser( 42, user ) ).rejects.toThrow(
			'Collaboration login request failed (10s limit).'
		);
		expect( context.request.post ).toHaveBeenCalledWith(
			expect.any( String ),
			expect.objectContaining( { timeout: 10000 } )
		);
		expect( context.request.post ).toHaveBeenCalledTimes( 1 );
		expect( context.close ).toHaveBeenCalledTimes( 1 );
		expect( utils.allPages ).toEqual( [ primaryPage ] );
	} );

	it( 'closes the context and preserves the error if editor setup fails', async () => {
		const { utils, context, page, primaryPage } = setup();
		const failure = new Error( 'Editor did not become ready' );
		page.waitForFunction.mockRejectedValue( failure );
		await expect( utils.joinUser( 42, user ) ).rejects.toBe( failure );
		expect( context.close ).toHaveBeenCalledTimes( 1 );
		expect( context.request.post ).toHaveBeenCalledTimes( 1 );
		expect( utils.allPages ).toEqual( [ primaryPage ] );
	} );
} );
