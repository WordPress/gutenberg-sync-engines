/**
 * External dependencies
 */
import type { Page } from '@playwright/test';

/**
 * WordPress dependencies
 */
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';

/**
 * Issue #57: a window that opens a post mid-session under the yjs-server
 * engine must not change the post by itself.
 *
 * The race is made deterministic instead of relying on a slow machine: the
 * reloading window's sync requests are held for a few seconds, so the
 * editor is fully mounted (and the person can type) before the server's
 * snapshot arrives. Whatever the editor dispatched in that window sits in
 * the engine's pre-bootstrap buffer and is replayed once the snapshot
 * lands.
 *
 * What the cases established (2026-09-16):
 *
 * - The editor dispatches NOTHING before the snapshot when nobody types:
 *   its initial parse of the saved post is a memoized read, not an edit.
 *   The issue's original trigger (an automatic parse dispatched as an edit)
 *   does not exist; case 1 shows a delayed join is harmless on its own.
 * - A deliberate keystroke before the snapshot carries the WHOLE block
 *   tree as parsed from the saved post. A verbatim replay of that tree
 *   against the first snapshot row the log delivers treated every
 *   difference as the joiner's own edit. When that row matched the saved
 *   post (case 2), only the keystroke landed. When it was older than the
 *   saved post (a save happened during the room's life, case 3), the
 *   peer's saved text was inserted a second time. When it was newer (the
 *   server compacted the log and dropped the genesis, case 4), the peer's
 *   unsaved text was deleted. Both windows agreed on the damaged text and
 *   no conflict was shown.
 *
 * The engine now carries over only the difference between the saved post
 * and the buffered tree, once the whole bootstrapping response has
 * landed, so cases 3 and 4 pass: the keystroke lands and nothing else.
 */

const HOLD_MS = 4000;
const PEER_TEXT = ' plus user one';
// Three bursts of five-plus keystrokes for the compacted case, each landed
// on the server before the next starts. The server counts a room's rows at
// the start of a request, so a checkpoint fires one request late: burst 2
// writes the first checkpoint, burst 3 the second, which also drops the log
// before the first. A joiner then reads the first checkpoint (holding
// bursts 1 and 2) as its first snapshot row.
const PEER_BURSTS = [ ' plus ', 'user ', 'one!!' ];
const CHECKPOINT_FIXTURE =
	'gutenberg-test-plugin-yjs-server-checkpoint-interval';

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if ( 'yjs-server' !== settings.wp_sync_engine ) {
			return;
		}
	}
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: { wp_sync_engine: engine },
	} );
}

async function waitForSyncQuiet( page: Page ): Promise< void > {
	const QUIET_MS = 1500;
	const MAX_MS = 10000;
	let lastRequestAt = Date.now();
	const onRequest = ( request: { url: () => string } ) => {
		if ( request.url().includes( 'wp-sync' ) ) {
			lastRequestAt = Date.now();
		}
	};
	page.on( 'request', onRequest );
	const deadline = Date.now() + MAX_MS;
	try {
		while ( Date.now() < deadline ) {
			if ( Date.now() - lastRequestAt >= QUIET_MS ) {
				return;
			}
			await page.waitForTimeout( 100 );
		}
	} finally {
		page.off( 'request', onRequest );
	}
}

/**
 * Runs inside a window: records what its canvas shows over time (first
 * block's id and text) so a failure explains itself in the attached report.
 */
function timelineScript() {
	const w = window as any;
	const timeline: Array< [ number, string ] > = [];
	w.__lateJoinTimeline = timeline;
	const t0 = Date.now();
	let last = '';
	setInterval( () => {
		const block = w.wp?.data
			?.select( 'core/block-editor' )
			?.getBlocks()?.[ 0 ];
		const text = block
			? `${ block.clientId.slice( 0, 8 ) }:${ String(
					block.attributes.content
			  ) }`
			: '(none)';
		if ( text !== last ) {
			last = text;
			timeline.push( [ Date.now() - t0, text ] );
		}
	}, 50 );
}

test.describe( 'Collaboration - yjs-server late join (issue #57)', () => {
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'yjs-server' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	const CASES: Array< {
		title: string;
		typeDuringHold: boolean;
		savedBeforeJoin: boolean;
		compacted: boolean;
	} > = [
		{
			title: 'a window whose first sync response is delayed does not revert a peer’s unsaved text',
			typeDuringHold: false,
			savedBeforeJoin: false,
			compacted: false,
		},
		{
			title: 'a window that TYPES before its delayed first sync response keeps a peer’s unsaved text',
			typeDuringHold: true,
			savedBeforeJoin: false,
			compacted: false,
		},
		{
			title: 'the same after user 1 SAVED: the replay must not insert the saved text a second time',
			typeDuringHold: true,
			savedBeforeJoin: true,
			compacted: false,
		},
		{
			title: 'the same after the server compacted the room: the replay must not delete the peer’s text',
			typeDuringHold: true,
			savedBeforeJoin: false,
			compacted: true,
		},
	];

	for ( const {
		title,
		typeDuringHold,
		savedBeforeJoin,
		compacted,
	} of CASES ) {
		test(
			title,
			async (
				{ collaborationUtils, requestUtils, editor, page },
				testInfo
			) => {
				if ( compacted ) {
					await requestUtils.activatePlugin( CHECKPOINT_FIXTURE );
				}
				try {
					const post = await requestUtils.createPost( {
						title: 'Late join',
						status: 'draft',
						content:
							'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
						date_gmt: new Date().toISOString(),
					} );

					await collaborationUtils.openCollaborativeSession(
						post.id
					);
					const { editor2, page2 } = collaborationUtils;

					for ( const currentEditor of [ editor, editor2 ] ) {
						await expect( async () => {
							const blocks = await currentEditor.getBlocks();
							expect( blocks ).toMatchObject( [
								{
									name: 'core/paragraph',
									attributes: { content: 'Existing content' },
								},
							] );
						} ).toPass( { timeout: 10000 } );
					}

					// User 1 types text that is NOT saved (yet).
					await editor.canvas
						.locator( '[data-type="core/paragraph"]' )
						.first()
						.click();
					await page.keyboard.press( 'End' );
					if ( compacted ) {
						let typed = 'Existing content';
						for ( const burst of PEER_BURSTS ) {
							await page.keyboard.type( burst, { delay: 30 } );
							typed += burst;
							const expectedSoFar = typed;
							await expect( async () => {
								const blocks = await editor2.getBlocks();
								expect( blocks[ 0 ].attributes.content ).toBe(
									expectedSoFar
								);
							} ).toPass( { timeout: 10000 } );
						}
					} else {
						await page.keyboard.type( PEER_TEXT, { delay: 30 } );
					}
					const peerText = compacted
						? PEER_BURSTS.join( '' )
						: PEER_TEXT;

					// The room holds it: user 2 sees it before reloading.
					await expect( async () => {
						const blocks = await editor2.getBlocks();
						expect( blocks[ 0 ].attributes.content ).toBe(
							`Existing content${ peerText }`
						);
					} ).toPass( { timeout: 10000 } );

					if ( savedBeforeJoin ) {
						// The room outlives the save, so its genesis row is now
						// older than the saved post the joiner will parse.
						const saved = page.waitForResponse(
							( response ) =>
								decodeURIComponent( response.url() ).includes(
									'/wp/v2/posts/'
								) && 'POST' === response.request().method()
						);
						await editor.saveDraft();
						await saved;
						await waitForSyncQuiet( page );
					}

					await page.evaluate( timelineScript );
					await page2.context().addInitScript( timelineScript );

					// Hold every sync request of the reloading window until
					// releaseAt, so the snapshot lands only after the editor
					// is mounted and (in the typing cases) used.
					let releaseAt = 0;
					await page2.route(
						( url ) => url.href.includes( 'wp-sync' ),
						async ( route ) => {
							const wait = releaseAt - Date.now();
							if ( wait > 0 ) {
								await new Promise( ( resolve ) =>
									setTimeout( resolve, wait )
								);
							}
							await route.continue();
						}
					);

					releaseAt = Date.now() + HOLD_MS;
					await page2.reload();
					await collaborationUtils.waitForCollaborationReady( page2 );

					if ( typeDuringHold ) {
						// A deliberate edit while the snapshot is still held
						// back: the editor shows the SAVED content, so the
						// person types after its last word.
						await editor2.canvas
							.locator( '[data-type="core/paragraph"]' )
							.first()
							.click();
						await page2.keyboard.press( 'End' );
						await page2.keyboard.type( ' B' );
						expect( Date.now() ).toBeLessThan( releaseAt );
					}

					// Let the hold expire, the snapshot land, and both windows
					// settle.
					await page2.waitForTimeout( HOLD_MS + 2000 );
					await waitForSyncQuiet( page2 );
					await waitForSyncQuiet( page );

					const timelines = {
						user1: await page.evaluate(
							() => ( window as any ).__lateJoinTimeline
						),
						user2: await page2.evaluate(
							() => ( window as any ).__lateJoinTimeline
						),
					};
					await testInfo.attach( 'late-join-timelines.json', {
						body: JSON.stringify( timelines, null, 2 ),
						contentType: 'application/json',
					} );

					// Both windows must agree, and the peer's text must survive
					// exactly once. When the joiner typed too, the two
					// insertions were concurrent from the document's point of
					// view, so their order is the CRDT's call.
					const blocks1 = await editor.getBlocks();
					const blocks2 = await editor2.getBlocks();
					const text1 = String( blocks1[ 0 ].attributes.content );
					const text2 = String( blocks2[ 0 ].attributes.content );
					expect( text2 ).toBe( text1 );
					const acceptable = typeDuringHold
						? [
								`Existing content${ peerText } B`,
								`Existing content B${ peerText }`,
						  ]
						: [ `Existing content${ peerText }` ];
					expect( acceptable ).toContain( text1 );
				} finally {
					if ( compacted ) {
						await requestUtils.deactivatePlugin(
							CHECKPOINT_FIXTURE
						);
					}
				}
			}
		);
	}
	test( 'the first paragraph typed into an EMPTY post before the delayed first sync response survives', async ( {
		collaborationUtils,
		requestUtils,
		editor,
		page,
	} ) => {
		// An empty post parses to no blocks, so the comparison that drives
		// the typing-only replay has nothing to work from. The document
		// holds no blocks either, so the buffered edit is merged as it is:
		// the paragraph must reach both windows.
		const post = await requestUtils.createPost( {
			title: 'Late join, empty post',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );
		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		let releaseAt = 0;
		await page2.route(
			( url ) => url.href.includes( 'wp-sync' ),
			async ( route ) => {
				const wait = releaseAt - Date.now();
				if ( wait > 0 ) {
					await new Promise( ( resolve ) =>
						setTimeout( resolve, wait )
					);
				}
				await route.continue();
			}
		);
		releaseAt = Date.now() + HOLD_MS;
		await page2.reload();
		await collaborationUtils.waitForCollaborationReady( page2 );

		await editor2.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page2.keyboard.type( 'Hi' );
		expect( Date.now() ).toBeLessThan( releaseAt );

		await page2.waitForTimeout( HOLD_MS + 2000 );
		await waitForSyncQuiet( page2 );
		await waitForSyncQuiet( page );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks ).toMatchObject( [
					{
						name: 'core/paragraph',
						attributes: { content: 'Hi' },
					},
				] );
			} ).toPass( { timeout: 10000 } );
		}
	} );
} );
