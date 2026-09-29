/**
 * External dependencies
 */
import type { Page } from '@playwright/test';

/**
 * Internal dependencies
 */
import { test, expect } from '../../config/collaboration-fixtures';

/**
 * Runs with the `sse-daemon` transport selected on the tests site and the
 * sync daemon running (see playwright.rtc-sse-daemon.config.ts). Each tab
 * holds one long-lived stream response that the sync daemon writes to, on
 * its own port, instead of a held PHP worker. From the page's point of
 * view the stream behaves as the web-tier `sse` transport's does, so these
 * specs cover what differs: the stream comes from the daemon, and a hidden
 * tab keeps it.
 */

interface SseDebugState {
	open: boolean;
	events: number;
	rooms: Record< string, number >;
}

async function sseState( page: Page ): Promise< SseDebugState > {
	return await page.evaluate( () => {
		const state = (
			window as Window & { __wpSyncSseState?: SseDebugState }
		 ).__wpSyncSseState;
		return state ?? { open: false, events: 0, rooms: {} };
	} );
}

async function waitForStream( page: Page ): Promise< void > {
	await expect
		.poll( () => sseState( page ), { timeout: 20000 } )
		.toMatchObject( { open: true } );
}

/**
 * Stands in for the browser's report of the page's visibility, then fires
 * the event the page listens for, which is what a tab moving to the
 * background does. A Playwright page cannot be genuinely backgrounded, so
 * the page's own input is supplied directly.
 */
async function setVisibility(
	page: Page,
	value: 'visible' | 'hidden'
): Promise< void > {
	await page.evaluate( ( state ) => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => state,
		} );
		Object.defineProperty( document, 'hidden', {
			configurable: true,
			get: () => 'visible' !== state,
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
	}, value );
}

function paragraph( content: string ): string {
	return `<!-- wp:paragraph -->\n<p>${ content }</p>\n<!-- /wp:paragraph -->`;
}

test.describe( 'Collaboration - server-sent events served by the daemon', () => {
	test( "delivers a peer's edit over the open stream", async ( {
		collaborationUtils,
		requestUtils,
		editor,
		page,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'sse-daemon delivery',
			content: paragraph( 'Streamed' ),
			status: 'draft',
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		await waitForStream( page );
		await waitForStream( page2 );

		// Both tabs are subscribed to the post's room on a stream the
		// daemon is serving.
		for ( const target of [ page, page2 ] ) {
			expect(
				Object.keys( ( await sseState( target ) ).rooms )
			).toContain( `postType/post:${ post.id }` );
		}

		const eventsBefore = ( await sseState( page2 ) ).events;

		await editor.canvas
			.getByRole( 'document', { name: /Block: Paragraph/ } )
			.first()
			.click();
		await page.keyboard.press( 'End' );
		await page.keyboard.type( ' over the daemon' );

		await expect(
			editor2.canvas
				.getByRole( 'document', { name: /Block: Paragraph/ } )
				.first()
		).toContainText( 'Streamed over the daemon', { timeout: 20000 } );

		// It arrived as a stream event.
		expect( ( await sseState( page2 ) ).events ).toBeGreaterThan(
			eventsBefore
		);
	} );

	test( 'a hidden tab keeps its stream and receives while in the background', async ( {
		collaborationUtils,
		requestUtils,
		editor,
		page,
	} ) => {
		/*
		 * The web-tier `sse` transport drops a hidden tab's stream, because
		 * there the stream is a PHP worker that has to stay up for as long
		 * as the tab lives. The daemon's stream holds no worker, so this
		 * transport keeps it and a backgrounded tab is still receiving when
		 * it is looked at again.
		 */
		const post = await requestUtils.createPost( {
			title: 'sse-daemon hidden tab',
			content: paragraph( 'Background' ),
			status: 'draft',
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		await waitForStream( page );
		await waitForStream( page2 );

		await setVisibility( page, 'hidden' );

		// Still open: hiding did not close it.
		await page.waitForTimeout( 1000 );
		expect( ( await sseState( page ) ).open ).toBe( true );

		const eventsBefore = ( await sseState( page ) ).events;

		await editor2.canvas
			.getByRole( 'document', { name: /Block: Paragraph/ } )
			.first()
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' while hidden' );

		// The hidden tab received it on the stream it already held.
		await expect
			.poll( async () => ( await sseState( page ) ).events, {
				timeout: 20000,
			} )
			.toBeGreaterThan( eventsBefore );

		await expect(
			editor.canvas
				.getByRole( 'document', { name: /Block: Paragraph/ } )
				.first()
		).toContainText( 'Background while hidden', { timeout: 20000 } );
	} );
} );
