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
 * SSE receives over a stream while one can be opened, and short polling,
 * the base transport, is the fallback whenever it cannot (a host without
 * Redis answers the stream request with 503; a proxy may refuse it).
 * Here the stream route is blocked for both tabs, so both must receive
 * over short polling and still converge.
 */

interface SseDebugState {
	open: boolean;
	events: number;
}

async function sseState( page: Page ): Promise< SseDebugState > {
	return await page.evaluate( () => {
		const state = (
			window as Window & { __wpSyncSseState?: SseDebugState }
		 ).__wpSyncSseState;
		return state ?? { open: false, events: 0 };
	} );
}

// Matched on the decoded URL: without pretty permalinks the route is
// URL-encoded inside `?rest_route=`.
const isStreamRequest = ( url: URL ) =>
	decodeURIComponent( url.href ).includes( '/wp-sync/v1/sse' );

/**
 * Counts the tab's updates requests (the short-polling exchange) from now
 * until `stop()` is called.
 *
 * @param page The tab.
 */
function countUpdatesRequests( page: Page ) {
	let count = 0;
	const onRequest = ( request: { url: () => string } ) => {
		if (
			decodeURIComponent( request.url() ).includes(
				'/wp-sync/v1/updates'
			)
		) {
			count++;
		}
	};
	page.on( 'request', onRequest );
	return {
		stop() {
			page.off( 'request', onRequest );
			return count;
		},
	};
}

test.describe( 'Collaboration - server-sent events fallback to short polling', () => {
	test.afterEach( async ( { collaborationUtils } ) => {
		await collaborationUtils.teardown();
	} );

	test( 'with the stream unreachable, both tabs receive over short polling and converge', async ( {
		collaborationUtils,
		requestUtils,
		page,
		editor,
		context,
	} ) => {
		// Block the stream route in this context AND in every context the
		// fixture opens for the joiner (it creates a fresh one from the
		// same browser).
		await context.route( isStreamRequest, ( route ) => route.abort() );
		const browser = context.browser()!;
		const newContext = browser.newContext.bind( browser );
		browser.newContext = ( async ( ...args: unknown[] ) => {
			const created = await (
				newContext as (
					...a: unknown[]
				) => ReturnType< typeof newContext >
			 )( ...args );
			await created.route( isStreamRequest, ( route ) => route.abort() );
			return created;
		} ) as typeof browser.newContext;

		const post = await requestUtils.createPost( {
			title: 'SSE fallback',
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

		// Neither tab ever had a stream deliver anything.
		for ( const target of [ page, joined.page ] ) {
			expect( await sseState( target ) ).toMatchObject( {
				open: false,
				events: 0,
			} );
		}

		// Edits converge over short polling: the joiner receives them
		// through updates requests while its stream stays closed. Its
		// cadence is the base transport's (on demand while the tabs reach
		// each other over the advisory channel, a timer otherwise), so
		// the proof is the requests made while the edit lands, not a
		// count taken on a timer.
		const joinerRequests = countUpdatesRequests( joined.page );
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
		expect( joinerRequests.stop() ).toBeGreaterThan( 0 );
		for ( const target of [ page, joined.page ] ) {
			expect( await sseState( target ) ).toMatchObject( {
				open: false,
				events: 0,
			} );
		}
	} );
} );
