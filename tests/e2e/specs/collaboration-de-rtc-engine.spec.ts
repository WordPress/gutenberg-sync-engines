/**
 * WordPress dependencies
 */
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';
import {
	CONFLICT_CARD,
	decideConflictCards,
	findConflictCard,
	openConflictDialog,
} from '../config/review-cards';
import {
	SECOND_USER,
	type CollaborationUtils,
} from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

/**
 * Two-client collaboration through the de-rtc sync engine: Distributed
 * Editing's save-centric model on the room protocol. Clients propose
 * whole content against the version they last incorporated; the SERVER
 * three-way-merges every proposal with the ported DE-RTC merge core and
 * announces each canonical version.
 *
 * These specs flip the site's `wp_sync_engine` option to `de-rtc` and
 * exercise the full stack: editor changes → de-rtc session codec →
 * polling transport → WP_De_RTC_Engine (merge core) → back. The suite
 * restores the default engine when done.
 *
 * Deliberately absent: the empty-post concurrent-first-paragraph
 * scenario (concurrent differing appends at the same edge are a
 * BY-DESIGN escalation under DE-RTC policy, not a merge — and a
 * REVIEWABLE one: escalations park for the conflict review panel,
 * exercised by the review-lane spec below). Title and entity
 * properties ride the proposal wire as per-property registers.
 */

/*
 * The block serializer escapes `--` inside comment attributes as
 * `\u002d\u002d` so the block delimiter stays a valid HTML comment.
 * Genesis syncIds are base64url and can contain consecutive dashes, so
 * undo that escape before matching ids against raw persisted content.
 */
function unescapeCommentDashes( raw: string ): string {
	return raw.replaceAll( '\\u002d', '-' );
}

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		// Nulling an already-absent option 500s (see the intent-log spec's
		// identical helper): restore only while our flip is in effect.
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if ( 'de-rtc' !== settings.wp_sync_engine ) {
			return;
		}
	}
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: { wp_sync_engine: engine },
	} );
}

/**
 * openCollaborativeSession with a welcome-guide belt: the fixture
 * dismisses the second user's welcome guide with a preferences dispatch
 * that late preference hydration can clobber under full-suite load; an
 * open guide modal aria-hides the whole page, so mutual discovery times
 * out even though sync is healthy. Close the modal directly when it
 * (re)appears.
 *
 * @param collaborationUtils The collaboration fixture.
 * @param postId             The post to open.
 */
async function openSession(
	collaborationUtils: CollaborationUtils,
	postId: number
) {
	await collaborationUtils.openPost( postId );
	await collaborationUtils.joinUser( postId, SECOND_USER );
	const page2 = collaborationUtils.page2;
	await page2.evaluate( () => {
		( window as any ).wp.data
			.dispatch( 'core/preferences' )
			.set( 'core/edit-post', 'welcomeGuide', false );
	} );
	await page2
		.getByRole( 'dialog' )
		.getByRole( 'button', { name: 'Close' } )
		.click( { timeout: 3000 } )
		.catch( () => {} );
	await collaborationUtils.waitForMutualDiscovery();
}

test.describe( 'Collaboration - de-rtc engine @engine-de-rtc', () => {
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'de-rtc' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	test( 'syncs text edits between two users from a server-side genesis', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'De-RTC Sync Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2 } = collaborationUtils;

		// Both clients bootstrapped from the SERVER's genesis snapshot (the
		// document was never seeded client-side).
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

		// User 1 appends a paragraph.
		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Written by user one' },
		} );

		// User 2 sees both paragraphs.
		await expect( async () => {
			const blocks = await editor2.getBlocks();
			expect( blocks ).toMatchObject( [
				{
					name: 'core/paragraph',
					attributes: { content: 'Existing content' },
				},
				{
					name: 'core/paragraph',
					attributes: { content: 'Written by user one' },
				},
			] );
		} ).toPass( { timeout: 10000 } );

		// User 2 edits the first paragraph; user 1 sees the edit.
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await collaborationUtils.page2.keyboard.press( 'End' );
		await collaborationUtils.page2.keyboard.type( ' plus user two' );

		await expect( async () => {
			const blocks = await editor.getBlocks();
			expect( blocks[ 0 ].attributes.content ).toBe(
				'Existing content plus user two'
			);
		} ).toPass( { timeout: 10000 } );
	} );

	test( 'concurrent edits to different blocks both survive the three-way merge', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'De-RTC Concurrency Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.nth( 1 )
			.click();
		await page2.keyboard.press( 'End' );

		// One proposal lands first; the other arrives with a stale base and
		// the SERVER rebases it over the accepted edit.
		//
		// Type BOTH bursts at once, a keystroke at a time: typed instantly
		// on a fast host, each burst is already complete before its first
		// commit goes out, so a single proposal carries the whole thing
		// and the interleaving this test is named for never happens. The
		// delay makes each commit's response land mid-burst on every host
		// — which is how a slow CI runner caught the rest of a burst
		// evaporating (" from two" collapsing to " ", see the pending-own-
		// merge commit hold in the de-rtc session).
		await Promise.all( [
			page1.keyboard.type( ' from one', { delay: 150 } ),
			page2.keyboard.type( ' from two', { delay: 150 } ),
		] );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First from one'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second from two'
				);
			} ).toPass( { timeout: 15000 } );
		}
	} );

	test( 'a save captures both users’ settled edits and persists clean content', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'De-RTC Save Flow Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Shared start</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2, page2 } = collaborationUtils;

		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' plus user two' );

		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Added by admin' },
		} );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks ).toMatchObject( [
					{
						attributes: {
							content: 'Shared start plus user two',
						},
					},
					{ attributes: { content: 'Added by admin' } },
				] );
			} ).toPass( { timeout: 15000 } );
		}

		await editor.saveDraft();

		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain( 'Shared start plus user two' );
		expect( saved.content.raw ).toContain( 'Added by admin' );

		// The non-saving peer's editor is unaffected by the save.
		const peerBlocks = await editor2.getBlocks();
		expect( peerBlocks ).toMatchObject( [
			{ attributes: { content: 'Shared start plus user two' } },
			{ attributes: { content: 'Added by admin' } },
		] );
	} );

	test( 'title and excerpt edits live-sync between users as property registers', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Original title',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Body text</p>\n<!-- /wp:paragraph -->',
		} );

		await openSession( collaborationUtils, post.id );
		const { page2 } = collaborationUtils;
		const page1 = editor.page;

		// User one rewrites the title in the editor chrome.
		const titleField1 = editor.canvas.getByRole( 'textbox', {
			name: 'Add title',
		} );
		await titleField1.click();
		await page1.keyboard.press( 'ControlOrMeta+a' );
		await page1.keyboard.type( 'Title from user one' );

		// User two receives it without saving.
		await expect( async () => {
			const title2 = await page2.evaluate( () =>
				( window as any ).wp.data
					.select( 'core/editor' )
					.getEditedPostAttribute( 'title' )
			);
			expect( title2 ).toBe( 'Title from user one' );
		} ).toPass( { timeout: 15000 } );

		// A scalar register travels the other way.
		await page2.evaluate( () => {
			( window as any ).wp.data
				.dispatch( 'core/editor' )
				.editPost( { excerpt: 'Excerpt from user two' } );
		} );
		await expect( async () => {
			const excerpt1 = await page1.evaluate( () =>
				( window as any ).wp.data
					.select( 'core/editor' )
					.getEditedPostAttribute( 'excerpt' )
			);
			expect( excerpt1 ).toBe( 'Excerpt from user two' );
		} ).toPass( { timeout: 15000 } );
	} );

	test( 'a genuine conflict parks for review, the card presents it, and the decision closes it for both users', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The escalation needs a sustained same-region typing race plus
		// settle waits; comfortably past the 60 s default cap on CI.
		test.setTimeout( 120_000 );

		const post = await requestUtils.createPost( {
			title: 'DE-RTC Review Lane Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Contested paragraph words</p>\n<!-- /wp:paragraph -->',
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		/*
		 * Both users REPLACE the same words from the same base version
		 * (edge inserts at Home/End would merge cleanly — de-rtc's
		 * three-way merge conflicts only on overlapping rewrites). The
		 * server accepts whichever proposal lands first; the other is a
		 * genuine conflict (`manual-conflict-required`) that now PARKS as
		 * a durable review row instead of being silently abandoned.
		 *
		 * DETERMINISTIC provocation: whether the conflict escalates used
		 * to depend on scheduling — if user two's replica incorporated
		 * user one's accepted version BEFORE its own commit left, the
		 * later proposal could serialize cleanly and nothing parked (the
		 * spec then flaked and leaned on CI retries). Holding user two's
		 * SYNC traffic (never the commit lane) while user one's rewrite
		 * lands guarantees user two proposes from the stale base, which
		 * is the same-block overlap the merge core must escalate. The
		 * held poll routes are released right after.
		 */
		const paragraph1 = editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first();
		const paragraph2 = editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first();

		// Both URL shapes: pretty (/wp-json/...) and plain
		// (?rest_route=%2F..., percent-encoded) — the established
		// decoded-match pattern from the http-only suite.
		const isSyncPoll = ( url: URL ) =>
			decodeURIComponent( url.href ).includes( '/wp-sync/v1/updates' );
		const isAutosaveCommit = ( response: {
			url: () => string;
			request: () => { method: () => string };
		} ) =>
			decodeURIComponent( response.url() ).includes(
				`/wp/v2/posts/${ post.id }/autosaves`
			) && 'POST' === response.request().method();

		const heldPolls: Array< { continue: () => Promise< void > } > = [];
		await page2.route( isSyncPoll, ( route ) => {
			heldPolls.push( route );
		} );

		// User one rewrites and their commit LANDS (the autosave commit
		// response is the server's acceptance).
		const userOneCommit = page1.waitForResponse( isAutosaveCommit, {
			timeout: 30000,
		} );
		await paragraph1.click( { clickCount: 3 } );
		await page1.keyboard.type( 'Rewrite by user one', { delay: 50 } );
		expect( ( await userOneCommit ).ok() ).toBe( true );

		// User two — still on the genesis version — rewrites the same
		// words and commits; the server three-way-merges from the stale
		// base and must park the overlap. The commit response itself
		// carries the parked row, so user two learns the escalation even
		// before their polls resume.
		const userTwoCommit = page2.waitForResponse( isAutosaveCommit, {
			timeout: 30000,
		} );
		await paragraph2.click( { clickCount: 3 } );
		await page2.keyboard.type( 'Rewrite by user two', { delay: 50 } );
		expect( ( await userTwoCommit ).ok() ).toBe( true );

		// Resume user two's sync traffic.
		for ( const route of heldPolls.splice( 0 ) ) {
			await route.continue().catch( () => {} );
		}
		await page2.unroute( isSyncPoll );

		/*
		 * At least one side surfaces the conflict IN PLACE (the parked row
		 * reaches BOTH replicas): the contested
		 * paragraph is replaced by the review card, the way an invalid
		 * block is replaced by its recovery card, so its content cannot be
		 * edited until the conflict is reviewed. No notice announces it.
		 */
		const card = CONFLICT_CARD;
		const { page: cardPage, editor: cardEditor } = await findConflictCard( [
			{ page: page1, editor },
			{ page: page2, editor: editor2 },
		] );
		await expect(
			cardEditor.canvas
				.getByRole( 'button', {
					name: 'Review conflict',
					exact: true,
				} )
				.first()
		).toBeVisible();
		for ( const page of [ page1, page2 ] ) {
			await expect( page.getByText( /set aside/ ) ).toHaveCount( 0 );
		}

		// Decisions are MUTATIONS and travel ONLY over the REST review
		// lane. Arm the listener BEFORE deciding so the spec proves
		// the route really ran, with the reviewer's content on it.
		const resolveResponse = cardPage.waitForResponse(
			( response ) =>
				decodeURIComponent( response.url() ).includes(
					'/wp-sync/v1/de-rtc/resolve'
				) && 'POST' === response.request().method(),
			{ timeout: 30000 }
		);

		// Decide everything parked, until the cards stay gone.
		await expect( async () => {
			await decideConflictCards( cardPage, cardEditor.canvas );
			// The cards must stay gone, not just clear for a moment.
			// In-flight pushes from the typing race can set MORE edits
			// aside after the cards first clear, so only a canvas still
			// empty after a full poll/flush cycle counts. Otherwise
			// decide again.
			await cardPage.waitForTimeout( 3000 );
			expect( await cardEditor.canvas.getByText( card ).count() ).toBe(
				0
			);
		} ).toPass( { timeout: 60000 } );

		// The REST resolve POST actually happened, succeeded, and carried
		// the accepted content.
		const resolved = await resolveResponse;
		expect( resolved.ok() ).toBe( true );
		expect( resolved.request().postDataJSON() ).toMatchObject( {
			resolution: 'accepted',
			content: expect.stringContaining( 'wp:paragraph' ),
		} );

		// The resolution rows travel to the OTHER collaborator too: their
		// cards clear.
		await expect( async () => {
			const otherEditor = cardEditor === editor ? editor2 : editor;
			expect( await otherEditor.canvas.getByText( card ).count() ).toBe(
				0
			);
		} ).toPass( { timeout: 20000 } );

		// Both canvases hold the same settled content.
		await expect( async () => {
			const [ blocks1, blocks2 ] = await Promise.all( [
				editor.getBlocks(),
				editor2.getBlocks(),
			] );
			expect( blocks1 ).toEqual( blocks2 );
		} ).toPass( { timeout: 20000 } );
	} );

	test( 'someone who types on after their edit was set aside keeps the block, and the reviewer gets the whole sentence', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		test.setTimeout( 120_000 );

		const post = await requestUtils.createPost( {
			title: 'DE-RTC Typing Through A Conflict Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Contested paragraph words</p>\n<!-- /wp:paragraph -->',
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		const paragraph1 = editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first();
		const paragraph2 = editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first();
		const isSyncPoll = ( url: URL ) =>
			decodeURIComponent( url.href ).includes( '/wp-sync/v1/updates' );
		const isAutosaveCommit = ( response: {
			url: () => string;
			request: () => { method: () => string };
		} ) =>
			decodeURIComponent( response.url() ).includes(
				`/wp/v2/posts/${ post.id }/autosaves`
			) && 'POST' === response.request().method();

		// User two stays on the genesis version while user one rewrites
		// (see the review-lane spec above for why the polls are held).
		const heldPolls: Array< { continue: () => Promise< void > } > = [];
		await page2.route( isSyncPoll, ( route ) => {
			heldPolls.push( route );
		} );

		/*
		 * At the commit cadence this suite pins (0, see the global
		 * setup) nearly every keystroke advances the room by one version,
		 * and the server keeps the last 20. User one's rewrite stays just inside
		 * that, so user two's first keystroke still finds the version it
		 * started from and is set aside. User two's own typing then runs
		 * the room past it: the rest of the sentence relies on the base
		 * form kept with their open record.
		 */
		const userOneText = 'Alpha bravo charlie';
		await paragraph1.click( { clickCount: 3 } );
		await page1.keyboard.type( userOneText, { delay: 50 } );
		await expect( async () => {
			const [ block ] = await editor.getBlocks();
			expect( block.attributes.content ).toBe( userOneText );
		} ).toPass( { timeout: 10000 } );
		await page1.waitForTimeout( 3000 );

		// User two rewrites the same words. The first keystroke's commit
		// is set aside. User two keeps typing through it.
		const userTwoText = 'Foxtrot golf hotel india juliet kilo';
		const firstCommit = page2.waitForResponse( isAutosaveCommit, {
			timeout: 30000,
		} );
		await paragraph2.click( { clickCount: 3 } );
		const typing = page2.keyboard.type( userTwoText, { delay: 80 } );
		await firstCommit;
		for ( const route of heldPolls.splice( 0 ) ) {
			await route.continue().catch( () => {} );
		}
		await page2.unroute( isSyncPoll );

		// While user two types, their block is still a paragraph they can
		// type in: no card has taken it.
		const card = /has conflicting edits/;
		await expect( editor2.canvas.getByText( card ) ).toHaveCount( 0 );
		await typing;

		// At the pause the card appears in both windows.
		for ( const canvas of [ editor.canvas, editor2.canvas ] ) {
			await expect( canvas.getByText( card ) ).toHaveCount( 1, {
				timeout: 20000,
			} );
		}

		// User one's text was never replaced.
		const [ kept ] = await editor.getBlocks();
		expect( kept.attributes.content ).toBe( userOneText );

		// The reviewer sees the whole sentence as the proposed version,
		// and the version both started from.
		const dialog = await openConflictDialog( page1, editor.canvas );
		const proposedPane = dialog
			.locator( '.gse-review-merge-dialog__pane' )
			.first();
		// The pane marks the changes word by word against the base, so
		// the sentence reads there with the removed words in between.
		for ( const word of userTwoText.split( ' ' ) ) {
			await expect( proposedPane ).toContainText( word );
		}
		await expect( proposedPane.getByRole( 'deletion' ) ).not.toHaveCount(
			0
		);
		await expect(
			dialog.locator( '.gse-review-merge-dialog__notice' )
		).toHaveCount( 0 );

		/*
		 * The current version changes while the dialog is open. The
		 * block is edited through the editor's store, behind the card,
		 * which stands in for a collaborator's version arriving: either
		 * way the reviewer's document changes under the open dialog. The
		 * merged result is still a plain copy of the current version, so
		 * it follows, and a notice says so.
		 */
		const laterText = `${ userOneText } delta`;
		const laterCommit = page1.waitForResponse( isAutosaveCommit, {
			timeout: 30000,
		} );
		await page1.evaluate( ( content ) => {
			const { select, dispatch } = window.wp.data;
			const [ block ] = select( 'core/block-editor' ).getBlocks();
			dispatch( 'core/block-editor' ).updateBlockAttributes(
				block.clientId,
				{ content }
			);
		}, laterText );
		await expect(
			dialog.locator( '.gse-review-merge-dialog__notice' )
		).toContainText(
			'The merged result now starts from the newer version',
			{ timeout: 10000 }
		);
		await expect(
			dialog.locator( '.gse-review-merge-dialog__merged' )
		).toContainText( laterText );
		await expect(
			dialog.locator( '.gse-review-merge-dialog__pane' ).nth( 1 )
		).toContainText( 'delta' );
		// Let that edit settle as a version, so the decision below names
		// the version that holds it.
		await laterCommit;
		await page1.waitForTimeout( 2000 );

		// Accepting the proposed version lands it for both, and one
		// decision closes the record everywhere.
		await proposedPane
			.getByRole( 'button', { name: 'Restore this version' } )
			.click();
		await dialog
			.getByRole( 'button', { name: 'Accept', exact: true } )
			.click();
		await expect( dialog ).toBeHidden( { timeout: 10000 } );

		await expect( async () => {
			const [ blocks1, blocks2 ] = await Promise.all( [
				editor.getBlocks(),
				editor2.getBlocks(),
			] );
			expect( blocks1[ 0 ].attributes.content ).toBe( userTwoText );
			expect( blocks2[ 0 ].attributes.content ).toBe( userTwoText );
			expect( await editor.canvas.getByText( card ).count() ).toBe( 0 );
			expect( await editor2.canvas.getByText( card ).count() ).toBe( 0 );
		} ).toPass( { timeout: 30000 } );
	} );

	test( 'at the default commit cadence, typing that follows a set-aside edit goes out at the first pause', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		test.setTimeout( 150_000 );

		// The shipped default: one commit every 10 seconds. The editors
		// read the setting when they load.
		const setCommitCadence = ( seconds: number ) =>
			requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/settings',
				data: {
					gutenberg_sync_engines_de_rtc_commit_interval: seconds,
				},
			} );
		await setCommitCadence( 10 );

		try {
			const post = await requestUtils.createPost( {
				title: 'DE-RTC Typing Through A Conflict At Cadence Test',
				status: 'draft',
				content:
					'<!-- wp:paragraph -->\n<p>Contested paragraph words</p>\n<!-- /wp:paragraph -->',
			} );

			await openSession( collaborationUtils, post.id );
			const { editor2, page2 } = collaborationUtils;
			const page1 = editor.page;

			const paragraph1 = editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first();
			const paragraph2 = editor2.canvas
				.locator( '[data-type="core/paragraph"]' )
				.first();
			const isSyncPoll = ( url: URL ) =>
				decodeURIComponent( url.href ).includes(
					'/wp-sync/v1/updates'
				);
			const isAutosaveCommit = ( response: {
				url: () => string;
				request: () => { method: () => string };
			} ) =>
				decodeURIComponent( response.url() ).includes(
					`/wp/v2/posts/${ post.id }/autosaves`
				) && 'POST' === response.request().method();

			const heldPolls: Array< { continue: () => Promise< void > } > = [];
			await page2.route( isSyncPoll, ( route ) => {
				heldPolls.push( route );
			} );

			// User one's rewrite: the first keystroke commits at once,
			// the rest with the next commit, a cadence later.
			const userOneText = 'Alpha bravo charlie';
			const userOneCommits: string[] = [];
			page1.on( 'response', ( response ) => {
				if ( isAutosaveCommit( response ) ) {
					userOneCommits.push( response.request().postData() ?? '' );
				}
			} );
			await paragraph1.click( { clickCount: 3 } );
			await page1.keyboard.type( userOneText, { delay: 50 } );
			await expect( async () => {
				expect(
					userOneCommits.some( ( body ) =>
						body.includes( userOneText )
					)
				).toBe( true );
			} ).toPass( { timeout: 20000 } );

			// User two rewrites the same words from the version before.
			// The first keystroke commits at once and is set aside.
			const userTwoText = 'Foxtrot golf hotel india juliet kilo';
			const userTwoCommits: Array< { at: number; body: string } > = [];
			page2.on( 'response', ( response ) => {
				if ( isAutosaveCommit( response ) ) {
					userTwoCommits.push( {
						at: Date.now(),
						body: response.request().postData() ?? '',
					} );
				}
			} );
			await paragraph2.click( { clickCount: 3 } );
			const typing = page2.keyboard.type( userTwoText, { delay: 80 } );
			await expect( async () => {
				expect( userTwoCommits.length ).toBeGreaterThan( 0 );
			} ).toPass( { timeout: 20000 } );
			for ( const route of heldPolls.splice( 0 ) ) {
				await route.continue().catch( () => {} );
			}
			await page2.unroute( isSyncPoll );
			await typing;
			const typedAt = Date.now();

			// The rest of the sentence goes out at the pause, not a
			// cadence after the first commit.
			await expect( async () => {
				expect(
					userTwoCommits.some( ( commit ) =>
						commit.body.includes( userTwoText )
					)
				).toBe( true );
			} ).toPass( { timeout: 4000 } );
			const whole = userTwoCommits.find( ( commit ) =>
				commit.body.includes( userTwoText )
			);
			expect( ( whole?.at ?? 0 ) - typedAt ).toBeLessThan( 4000 );

			// The reviewer's card carries the whole sentence.
			await expect(
				editor.canvas.getByText( /has conflicting edits/ )
			).toHaveCount( 1, { timeout: 20000 } );
			const dialog = await openConflictDialog( page1, editor.canvas );
			const proposedPane = dialog
				.locator( '.gse-review-merge-dialog__pane' )
				.first();
			for ( const word of userTwoText.split( ' ' ) ) {
				await expect( proposedPane ).toContainText( word );
			}

			// User one's text was never replaced.
			const [ kept ] = await editor.getBlocks();
			expect( kept.attributes.content ).toBe( userOneText );
		} finally {
			// Back to the cadence the suite pins (see the global setup).
			await setCommitCadence( 0 );
		}
	} );

	test( 'every block carries a durable identity that both users share, that persists into saved content, and that survives reload', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'De-RTC Durable Ids Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2 } = collaborationUtils;
		const page1 = editor.page;

		const idsOf = async ( currentEditor: typeof editor ) => {
			const blocks = await currentEditor.getBlocks();
			return blocks.map(
				( block ) =>
					( block.attributes.metadata as { syncId?: string } )?.syncId
			);
		};

		// The saved paragraph gets its deterministic genesis id from the
		// room, and both users agree on it.
		await expect( async () => {
			const [ mine ] = await idsOf( editor );
			const [ theirs ] = await idsOf( editor2 );
			expect( mine ).toBeTruthy();
			expect( theirs ).toBe( mine );
		} ).toPass( { timeout: 15000 } );

		// A block born in the session is stamped in the editor; its id
		// reaches the peer with the block.
		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Born in the session' },
		} );
		let ids: Array< string | undefined > = [];
		await expect( async () => {
			ids = await idsOf( editor );
			expect( ids ).toHaveLength( 2 );
			expect( ids[ 1 ] ).toBeTruthy();
			expect( await idsOf( editor2 ) ).toEqual( ids );
		} ).toPass( { timeout: 15000 } );
		// Settled, not merely first-stamped: stable across a quiet period.
		await page1.waitForTimeout( 2000 );
		expect( await idsOf( editor ) ).toEqual( ids );

		await editor.saveDraft();

		// The ids ride the block delimiters into persisted content…
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		const raw = unescapeCommentDashes( saved.content.raw );
		expect( raw ).toContain( `"syncId":"${ ids[ 0 ] }"` );
		expect( raw ).toContain( `"syncId":"${ ids[ 1 ] }"` );

		// …and survive a full reload unchanged.
		await page1.reload();
		await expect( async () => {
			expect( await idsOf( editor ) ).toEqual( ids );
		} ).toPass( { timeout: 20000 } );
	} );

	test( 'edits inside the same Group by two users both survive, merged by block identity', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'De-RTC Nested Merge Test',
			status: 'draft',
			content:
				'<!-- wp:group {"layout":{"type":"constrained"}} -->\n<div class="wp-block-group"><!-- wp:paragraph -->\n<p>First inner</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second inner</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->',
			date_gmt: new Date().toISOString(),
		} );

		await openSession( collaborationUtils, post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect(
				currentEditor.canvas.locator( '[data-type="core/paragraph"]' )
			).toHaveCount( 2 );
		}

		// User 1 types into the first inner paragraph while user 2 types
		// into the second — the same top-level Group on both sides, which
		// positional matching could only park.
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.nth( 1 )
			.click();
		await page2.keyboard.press( 'End' );
		await Promise.all( [
			page1.keyboard.type( ' plus one', { delay: 40 } ),
			page2.keyboard.type( ' plus two', { delay: 40 } ),
		] );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks ).toHaveLength( 1 );
				expect( blocks[ 0 ].name ).toBe( 'core/group' );
				expect(
					blocks[ 0 ].innerBlocks.map(
						( block ) => block.attributes.content
					)
				).toEqual( [
					'First inner plus one',
					'Second inner plus two',
				] );
			} ).toPass( { timeout: 20000 } );
		}

		// Nothing parked: both edits merged, no review card.
		await page1.waitForTimeout( 2000 );
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect(
				currentEditor.canvas.getByRole( 'button', {
					name: 'Review conflict',
					exact: true,
				} )
			).toHaveCount( 0 );
		}
	} );
} );
