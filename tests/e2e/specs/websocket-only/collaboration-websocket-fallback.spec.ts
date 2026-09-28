/**
 * External dependencies
 */
import type { Page } from '@playwright/test';

/**
 * Internal dependencies
 */
import { test, expect } from '../../config/collaboration-fixtures';
import { SECOND_USER } from '../../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

/**
 * WebSocket is a PREFERRED transport: it carries everything while its
 * socket is open, and short polling, the base transport, is the fallback
 * whenever it is not (docs/plan/advisory-channel.md). Here the socket can
 * never open — the one-time token route is blocked for both tabs — so both
 * tabs must fall back to short polling and still converge.
 */

interface WsDebugState {
	open: boolean;
	parked: string[];
}

async function wsState( page: Page ): Promise< WsDebugState > {
	return await page.evaluate( () => {
		const state = ( window as Window & { __wpSyncWsState?: WsDebugState } )
			.__wpSyncWsState;
		return state ?? { open: false, parked: [] };
	} );
}

async function countSyncRequests( page: Page, windowMs: number ) {
	let count = 0;
	const onRequest = ( request: { url: () => string } ) => {
		// Matched without slashes: without pretty permalinks the route is
		// URL-encoded inside `?rest_route=`.
		if ( request.url().includes( 'wp-sync' ) ) {
			count++;
		}
	};
	page.on( 'request', onRequest );
	await page.waitForTimeout( windowMs );
	page.off( 'request', onRequest );
	return count;
}

test.describe( 'Collaboration - websocket fallback to short polling', () => {
	test.afterEach( async ( { collaborationUtils } ) => {
		await collaborationUtils.teardown();
	} );

	test( 'with the socket unreachable, both tabs fall back to short polling and converge', async ( {
		collaborationUtils,
		requestUtils,
		page,
		editor,
		context,
	} ) => {
		// Block the one-time token route in this context AND in every
		// context the fixture opens for the joiner (it creates a fresh one
		// from the same browser), so neither socket can ever open.
		await context.route( '**/*ws-token*', ( route ) => route.abort() );
		const browser = context.browser()!;
		const newContext = browser.newContext.bind( browser );
		browser.newContext = ( async ( ...args: unknown[] ) => {
			const created = await (
				newContext as (
					...a: unknown[]
				) => ReturnType< typeof newContext >
			 )( ...args );
			await created.route( '**/*ws-token*', ( route ) => route.abort() );
			return created;
		} ) as typeof browser.newContext;

		const post = await requestUtils.createPost( {
			title: 'WebSocket fallback',
			content:
				'<!-- wp:paragraph --><p>Fallback</p><!-- /wp:paragraph -->',
			status: 'draft',
		} );

		await collaborationUtils.openPost( post.id );
		const joined = await collaborationUtils.joinUser(
			post.id,
			SECOND_USER
		);
		browser.newContext = newContext;

		// Both tabs report a closed socket with the post room parked.
		for ( const target of [ page, joined.page ] ) {
			await expect
				.poll( () => wsState( target ), { timeout: 20000 } )
				.toMatchObject( { open: false } );
			expect( ( await wsState( target ) ).parked.length ).toBeGreaterThan(
				0
			);
		}

		// Short polling is live: requests flow on the timer cadence.
		expect( await countSyncRequests( page, 4000 ) ).toBeGreaterThan( 0 );

		// And edits still converge through it.
		await editor.canvas
			.getByRole( 'document', { name: /Block: Paragraph/ } )
			.first()
			.click();
		await page.keyboard.press( 'End' );
		await page.keyboard.type( ' over polling' );
		await expect(
			joined.editor.canvas
				.getByRole( 'document', { name: /Block: Paragraph/ } )
				.first()
		).toContainText( 'Fallback over polling', { timeout: 20000 } );
	} );
} );
