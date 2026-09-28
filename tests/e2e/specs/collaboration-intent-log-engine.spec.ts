/**
 * WordPress dependencies
 */
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';
// The engine's deterministic genesis id function (vector-pinned against the
// PHP twin) — imported directly so the spec asserts EXACT id agreement.
import { genesisSyncId } from '../../js/engines/intent-log/genesis-sync-id.js';

/**
 * Two-client collaboration through the intent-log sync engine.
 *
 * These specs flip the site's `wp_sync_engine` option to `intent-log` (the
 * server announces it; clients resolve the intent-log adapter) and exercise
 * the full stack: capture bridge → session → polling transport →
 * WP_Intent_Log_Engine → back. The suite restores the default engine when
 * done (intent-log is also the framework's conventional default, so with
 * the option unset the remaining collaboration specs exercise it too).
 */

/*
 * The block serializer escapes `--` inside comment attributes as
 * `\u002d\u002d` so the block delimiter stays a valid HTML comment.
 * SyncIds are base64url and can legitimately contain consecutive dashes,
 * so undo that escape before matching ids against raw persisted content.
 */
function unescapeCommentDashes( raw: string ): string {
	return raw.replaceAll( '\\u002d', '-' );
}

async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		// Nulling an already-absent option 500s (rest_invalid_stored_value:
		// the settings controller validates the stored value first, and an
		// absent row reads as `false`). Restore only when one of THIS
		// suite's flips is still in effect ('intent-log' from beforeEach,
		// 'yjs-server' from the engine-flip spec).
		const settings = await requestUtils.rest( {
			path: '/wp/v2/settings',
		} );
		if (
			! [ 'intent-log', 'yjs-server' ].includes( settings.wp_sync_engine )
		) {
			return;
		}
	}
	await requestUtils.rest( {
		method: 'POST',
		path: '/wp/v2/settings',
		data: { wp_sync_engine: engine },
	} );
}

test.describe( 'Collaboration - intent-log engine @engine-intent-log', () => {
	// Per TEST, after fixture setup: the collaboration fixture's
	// writing-form toggle must never be able to wipe the engine selection
	// between the flip and the pages loading.
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'intent-log' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	test( 'syncs text edits between two users', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Sync Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;

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

	test( 'appending to an existing paragraph keeps it visible and identity-stable on the peer', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Regression: id-less editor blocks (freshly parsed post content)
		// used to re-mint a syncId every capture cycle, deriving
		// remove_block + insert_block per keystroke — the paragraph
		// flickered out of existence on the peer's CANVAS even though
		// store-level polling assertions eventually converged.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Append Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Steady paragraph</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await page1.keyboard.type( ' appended' );

		// The peer's CANVAS shows the appended text…
		await expect(
			editor2.canvas.locator( '[data-type="core/paragraph"]' ).first()
		).toContainText( 'Steady paragraph appended', { timeout: 10000 } );
		// …and exactly one paragraph exists (no remove/insert churn residue).
		await expect(
			editor2.canvas.locator( '[data-type="core/paragraph"]' )
		).toHaveCount( 1 );

		// A second append still targets the SAME block (identity adoption is
		// stable across capture cycles): the paragraph neither duplicates
		// nor flickers, and both canvases converge on the full text.
		await page1.keyboard.type( ' again' );
		await expect(
			editor2.canvas.locator( '[data-type="core/paragraph"]' ).first()
		).toContainText( 'Steady paragraph appended again', {
			timeout: 10000,
		} );
		await expect(
			editor2.canvas.locator( '[data-type="core/paragraph"]' )
		).toHaveCount( 1 );
		await expect(
			editor.canvas.locator( '[data-type="core/paragraph"]' )
		).toHaveCount( 1 );
	} );

	test( 'both users typing on an EMPTY post converge without deleting each other', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Regression: on a fresh post (empty genesis) each client seeds its
		// own paragraph; the peer's paragraph lands in the shared document
		// before the local editor renders it, and a stale capture used to
		// interpret its absence as a deletion — the clients silently deleted
		// each other's content forever.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Empty Post Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// Both users type into the empty canvas at once.
		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'First author paragraph' );
		await editor2.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page2.keyboard.type( 'Second author paragraph' );

		/*
		 * Both editors converge on BOTH paragraphs (order may vary by
		 * arrival; neither may vanish).
		 *
		 * HISTORICAL FAILURE MODE (fixed): under CI load this used to fail
		 * with the SECOND author's paragraph settling on a truncated prefix
		 * (for example "Second author par") while both paragraphs survived
		 * — the intent-log echo race. A peer push landing mid-typing
		 * reverted the tail of the typer's own paragraph, and the next
		 * capture treated the truncated canvas as testimony against the
		 * current document, so the tail never returned. Capture now diffs
		 * each tree against the state that tree reflects (see "THE OBSERVED
		 * BASELINE" in src/engines/intent-log-manager.ts), which merges the
		 * two instead. If a truncation like that reappears, it is a
		 * regression of that mechanism — do not loosen these assertions to
		 * make CI green.
		 */
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				const contents = blocks.map(
					( block ) => block.attributes.content
				);
				expect( contents ).toEqual(
					expect.arrayContaining( [
						'First author paragraph',
						'Second author paragraph',
					] )
				);
			} ).toPass( { timeout: 15000 } );
		}

		// And they STAY converged (no delete/reinsert war): after a settle
		// window, both canvases still show both paragraphs.
		await page1.waitForTimeout( 3000 );
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect(
				currentEditor.canvas.locator( '[data-type="core/paragraph"]' )
			).toHaveCount( 2 );
		}
	} );

	test( 'a passive reader on an EMPTY post receives typed content', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Field scenario: user A types into a brand-new empty post while
		// user B just watches. B authors nothing (no rows, no awareness
		// churn) — pure receive path over an empty genesis.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Passive Reader Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		const pageErrors: string[] = [];
		page2.on( 'pageerror', ( error ) =>
			pageErrors.push( String( error ) )
		);
		page2.on( 'console', ( message ) => {
			// Resource-load 403s are generic editor noise for the second
			// user's capabilities, not sync errors.
			if (
				'error' === message.type() &&
				! message.text().includes( 'Failed to load resource' )
			) {
				pageErrors.push( message.text() );
			}
		} );

		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'paragraph added by admin' );

		await expect(
			editor2.canvas.locator( '[data-type="core/paragraph"]' ).first()
		).toContainText( 'paragraph added by admin', { timeout: 15000 } );

		expect( pageErrors ).toEqual( [] );
	} );

	test( 'reader-first ordering: the post creator sees content typed by a later joiner', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Field scenario inverted roles: the READER opens the empty post
		// first (as its creator would from post-new.php) and idles; the
		// WRITER joins second and types. The first client's initial poll
		// initializes the room (stores the empty snapshot); its editor must
		// still render content that arrives later.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Reader First Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		const pageErrors: string[] = [];
		page1.on( 'pageerror', ( error ) =>
			pageErrors.push( String( error ) )
		);
		page1.on( 'console', ( message ) => {
			if ( 'error' === message.type() ) {
				pageErrors.push( message.text() );
			}
		} );

		// Editor1 (opened first) idles; editor2 (joined second) types.
		await editor2.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page2.keyboard.type( 'typed by the second user' );

		await expect(
			editor.canvas.locator( '[data-type="core/paragraph"]' ).first()
		).toContainText( 'typed by the second user', { timeout: 15000 } );

		expect( pageErrors ).toEqual( [] );
	} );

	test( 'splitting a settled paragraph converges with stable identities while the peer edits the sibling', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The durable-id split regression: once the stamper has assigned
		// metadata.syncIds, Gutenberg's split copies ALL attributes — the
		// syncId included — onto the second half. The head must keep its
		// identity, the second half must re-mint, and the FOLLOWING block's
		// identity must survive untouched even while the peer is typing
		// into it (the stolen-identity bug duplicated content here).
		const post = await requestUtils.createPost( {
			title: 'Intent Log Durable Split Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'HelloWorld' );
		await page1.keyboard.press( 'Enter' );
		await page1.keyboard.type( 'SecondBlock' );

		// Wait for identity to become DURABLE: both blocks stamped, and the
		// peer converged on the same ids.
		const idsOf = async ( targetEditor: typeof editor ) => {
			const blocks = await targetEditor.getBlocks();
			return blocks.map(
				( block ) =>
					( block.attributes.metadata as { syncId?: string } )?.syncId
			);
		};
		let settledIds: Array< string | undefined > = [];
		await expect( async () => {
			settledIds = await idsOf( editor );
			expect( settledIds ).toHaveLength( 2 );
			expect( settledIds.every( Boolean ) ).toBe( true );
			expect( await idsOf( editor2 ) ).toEqual( settledIds );
		} ).toPass( { timeout: 15000 } );

		// Split the first paragraph mid-text while the peer edits the
		// second block.
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		for ( let i = 0; i < 5; i++ ) {
			await page1.keyboard.press( 'ArrowLeft' );
		}
		await page1.keyboard.press( 'Enter' );
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.nth( 1 )
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( '-B' );

		// Both editors converge on the same 3 blocks with correct texts…
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect(
					blocks.map( ( block ) => block.attributes.content )
				).toEqual( [ 'Hello', 'World', 'SecondBlock-B' ] );
			} ).toPass( { timeout: 15000 } );
		}
		// …and identities. The engine contract: both editors agree on every
		// id; the SIBLING's identity survives the split untouched (the
		// stolen-identity bug landed the peer's edits in the wrong block
		// here); and the split resolves to exactly one half continuing the
		// settled identity plus one freshly minted — which half continues
		// is Gutenberg's split implementation detail, not pinned.
		await expect( async () => {
			const ids1 = await idsOf( editor );
			const ids2 = await idsOf( editor2 );
			expect( ids1 ).toEqual( ids2 );
			expect( ids1.every( Boolean ) ).toBe( true );
			expect( ids1[ 2 ] ).toBe( settledIds[ 1 ] );
			const halves = [ ids1[ 0 ], ids1[ 1 ] ];
			expect( halves ).toContain( settledIds[ 0 ] );
			expect(
				halves.filter( ( id ) => ! settledIds.includes( id ) )
			).toHaveLength( 1 );
		} ).toPass( { timeout: 15000 } );
	} );

	test( 'splitting immediately while typing (pre-stamp window) converges without duplication', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The id-less split shape: the capture may run before the stamper
		// assigns ids, so identity is inferred. Adoption must keep the
		// following block's identity by content, never positionally.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Fast Split Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;
		const page1 = editor.page;

		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'HelloWorld' );
		await page1.keyboard.press( 'Enter' );
		await page1.keyboard.type( 'SecondBlock' );
		// No settle wait: split immediately.
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		for ( let i = 0; i < 5; i++ ) {
			await page1.keyboard.press( 'ArrowLeft' );
		}
		await page1.keyboard.press( 'Enter' );

		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect(
					blocks.map( ( block ) => block.attributes.content )
				).toEqual( [ 'Hello', 'World', 'SecondBlock' ] );
			} ).toPass( { timeout: 15000 } );
		}
		// Sustained: no delete/reinsert war after a settle window.
		await page1.waitForTimeout( 3000 );
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect(
				currentEditor.canvas.locator( '[data-type="core/paragraph"]' )
			).toHaveCount( 3 );
		}
	} );

	test( 'syncIds are durable: they persist into saved content and survive reload', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Durable Ids Test',
			status: 'draft',
			content: '',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const page1 = editor.page;

		await editor.canvas
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		await page1.keyboard.type( 'Durable paragraph' );

		const idsOf = async () => {
			const blocks = await editor.getBlocks();
			return blocks.map(
				( block ) =>
					( block.attributes.metadata as { syncId?: string } )?.syncId
			);
		};
		/*
		 * Wait for the SETTLED identity, not the first stamped one: the
		 * stamper assigns a tab-local id immediately, then the shared
		 * document's identity wins during settle. The durable invariant is
		 * about the converged id — stable across consecutive reads.
		 */
		let stampedId: string | undefined;
		await expect( async () => {
			const [ current ] = await idsOf();
			expect( current ).toBeTruthy();
			await page1.waitForTimeout( 2000 );
			const [ settled ] = await idsOf();
			expect( settled ).toBe( current );
			stampedId = settled;
		} ).toPass( { timeout: 30000 } );

		await editor.saveDraft();

		// The id rides the block delimiter into persisted content…
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( unescapeCommentDashes( saved.content.raw ) ).toContain(
			`"syncId":"${ stampedId }"`
		);

		// …and survives a full reload unchanged.
		await page1.reload();
		await expect( async () => {
			expect( ( await idsOf() )[ 0 ] ).toBe( stampedId );
		} ).toPass( { timeout: 15000 } );
	} );

	test( 'a newborn block’s identity is assigned once and an immediate save persists it (no save-vs-settle drift)', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Regression: the id stamper's random lane used to race the capture
		// bridge for every block created in-session — the stamper's direct
		// block-editor write landed before the capture push's entity-level
		// edit propagated down, putting a THIRD identity on the block that
		// the shared document never knew. A save in that window persisted
		// the foreign id (the save-vs-settle id drift). With the stamper's
		// in-session stand-down, a newborn block carries exactly ONE
		// identity, ever, and even an immediate save persists that id.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Id Stability Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Existing</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openPost( post.id );
		const page1 = editor.page;

		// Record every distinct id the new (second) block ever carries.
		await page1.evaluate( () => {
			const idsSeen: string[] = [];
			( window as any ).__blockIdTrace = idsSeen;
			const blockEditor = ( window as any ).wp.data.select(
				'core/block-editor'
			);
			( window as any ).wp.data.subscribe( () => {
				const blocks = blockEditor.getBlocks();
				const id = blocks[ 1 ]?.attributes?.metadata?.syncId;
				if ( id && idsSeen[ idsSeen.length - 1 ] !== id ) {
					idsSeen.push( id );
				}
			} );
		} );

		await editor.insertBlock( {
			name: 'core/paragraph',
			attributes: { content: 'Newborn block' },
		} );
		// Save immediately — the historical drift window.
		await editor.saveDraft();

		// Let the settle machinery (including the 1.2 s delayed re-push)
		// run; the block's identity must never have changed.
		await page1.waitForTimeout( 3000 );
		const idsSeen = await page1.evaluate(
			() => ( window as any ).__blockIdTrace as string[]
		);
		expect( idsSeen ).toHaveLength( 1 );

		/*
		 * The immediate save must never persist a FOREIGN identity (an id
		 * the shared document does not carry — the drift). It may catch
		 * the newborn block before the engine's id reaches the canvas and
		 * persist it id-less; that self-heals on the next save.
		 */
		const savedIdsOf = ( raw: string ) =>
			[
				...unescapeCommentDashes( raw ).matchAll(
					/"syncId":"([^"]+)"/g
				),
			].map( ( match ) => match[ 1 ] );
		const originalId = await page1.evaluate(
			() =>
				( window as any ).wp.data
					.select( 'core/block-editor' )
					.getBlocks()[ 0 ].attributes.metadata.syncId
		);
		const firstSave = await requestUtils.rest< {
			content: { raw: string };
		} >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		for ( const id of savedIdsOf( firstSave.content.raw ) ) {
			expect( [ originalId, idsSeen[ 0 ] ] ).toContain( id );
		}

		// The canvas has settled on the engine's identity…
		await expect( async () => {
			const canvasId = await page1.evaluate(
				() =>
					( window as any ).wp.data
						.select( 'core/block-editor' )
						.getBlocks()[ 1 ]?.attributes?.metadata?.syncId
			);
			expect( canvasId ).toBe( idsSeen[ 0 ] );
		} ).toPass( { timeout: 10000 } );

		// …and a settled save persists it. Sync-applied pushes don't
		// re-dirty the post, so make a small edit (the realistic path:
		// any later edit carries the settled tree) via the store — the
		// identity push remounts canvas blocks, which makes keyboard
		// focus racy here — then save.
		await page1.evaluate( () => {
			const { select, dispatch } = ( window as any ).wp.data;
			const block = select( 'core/block-editor' ).getBlocks()[ 1 ];
			dispatch( 'core/block-editor' ).updateBlockAttributes(
				block.clientId,
				{ content: 'Newborn block settled' }
			);
		} );
		// saveDraft() resolves on a "Draft saved" notice, and the first
		// save's notice is still up; wait for this save's own response
		// (a lone tab flushes its held work through the room first).
		const saved = page1.waitForResponse(
			( response ) =>
				decodeURIComponent( response.url() ).includes(
					`/wp/v2/posts/${ post.id }`
				) && 'POST' === response.request().method()
		);
		await editor.saveDraft();
		await saved;
		const settledSave = await requestUtils.rest< {
			content: { raw: string };
		} >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( unescapeCommentDashes( settledSave.content.raw ) ).toContain(
			`"syncId":"${ idsSeen[ 0 ] }"`
		);
	} );

	test( 'a save captures both users’ settled edits and persists clean content', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Save Flow Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Shared start</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		// User 2 extends the existing paragraph; user 1 adds a new one.
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

		// Both editors converge before the save.
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

		// The persisted content carries BOTH users' settled work…
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain( 'Shared start plus user two' );
		expect( saved.content.raw ).toContain( 'Added by admin' );

		// …and no engine-internal state leaks into it.
		expect( saved.content.raw ).not.toContain( '_wrapper' );
		expect( saved.content.raw ).not.toContain( 'attrVersions' );

		// The non-saving peer's editor is unaffected by the save.
		const peerBlocks = await editor2.getBlocks();
		expect( peerBlocks ).toMatchObject( [
			{ attributes: { content: 'Shared start plus user two' } },
			{ attributes: { content: 'Added by admin' } },
		] );
	} );

	test( 'concurrent edits to different blocks both survive', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Concurrency Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// User 1 edits the first block, user 2 the second, immediately.
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

		await page1.keyboard.type( ' from one' );
		await page2.keyboard.type( ' from two' );

		// Both editors converge on both edits.
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First from one'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second from two'
				);
			} ).toPass( { timeout: 10000 } );
		}
	} );

	test( 'concurrent same-paragraph edits surface an escalation notice instead of silently merging', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The discard-until-quiescent loop (60 s budget with 3 s settle
		// waits per attempt) plus the reload and bootstrap-replay waits
		// push this test's happy path past the 60 s default cap on CI.
		test.setTimeout( 120_000 );

		const post = await requestUtils.createPost( {
			title: 'Intent Log Escalation Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Contested paragraph</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// Both users type into the SAME paragraph simultaneously. Sustained
		// overlapping writes to one text frame guarantee that at least one
		// client authors against a stale sequence, which the engine sets
		// aside for review (frame-conflict) rather than silently merging.
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'Home' );

		await Promise.all( [
			page1.keyboard.type( ' one one one one one', { delay: 100 } ),
			page2.keyboard.type( 'two two two two two ', { delay: 100 } ),
		] );

		// At least one side surfaces the escalation: per-item notices below
		// the aggregation threshold, one counter notice above it.
		let noticePage = page1;
		let noticeEditor = editor;
		await expect( async () => {
			const counts = await Promise.all( [
				page1.getByText( /set aside/ ).count(),
				page2.getByText( /set aside/ ).count(),
			] );
			expect( counts[ 0 ] + counts[ 1 ] ).toBeGreaterThan( 0 );
			noticePage = counts[ 0 ] > 0 ? page1 : page2;
			noticeEditor = counts[ 0 ] > 0 ? editor : editor2;
		} ).toPass( { timeout: 15000 } );

		/*
		 * The conflicts anchor IN CONTEXT: the contested paragraph gets an
		 * inline pending-edit card (ONE merged task per block, no chip),
		 * whose Adopt/Reject verbs are the primary resolution surface.
		 */
		const pendingCard = noticePage.locator(
			'.editor-collaboration-pending-card__body'
		);
		await expect( pendingCard.first() ).toBeVisible( { timeout: 15000 } );
		await expect(
			pendingCard
				.getByRole( 'button', { name: 'Reject', exact: true } )
				.first()
		).toBeVisible();

		/*
		 * The review panel in the document sidebar is a summary-only index:
		 * anchored conflicts list without verbs and link to their block;
		 * resolution happens at the inline card. Rejecting closes each
		 * proposal for every collaborator, durably — after a reload the
		 * resolved conflicts must NOT resurface (the resolution rows settle
		 * the bootstrap replay). A sustained typing race parks many edits;
		 * reject them all through the cards (and any unanchored leftovers
		 * through the panel, which keeps verbs only for those).
		 */
		await noticeEditor.openDocumentSettingsSidebar();
		// The sidebar auto-switches to the Block tab while a block is
		// selected; the review panel lives in the document (Post) tab.
		await noticePage
			.getByRole( 'tab', { name: 'Post', exact: true } )
			.click();
		const panel = noticePage.locator(
			'.editor-collaboration-review-panel'
		);
		await expect( panel ).toBeVisible( { timeout: 15000 } );
		// Anchored conflicts carry no panel verbs — the summary-only
		// contract (the panel still renders the group summaries).
		await expect(
			panel.getByRole( 'button', { name: 'Reject', exact: true } )
		).toHaveCount( 0 );
		await expect( async () => {
			// Reject everything currently parked: each block's merged card
			// resolves every conflict on that block; unanchored items (no
			// live block) resolve through their panel verbs.
			for ( let i = 0; i < 40; i++ ) {
				const cardReject = pendingCard
					.getByRole( 'button', { name: 'Reject', exact: true } )
					.first();
				if ( ( await cardReject.count() ) > 0 ) {
					await cardReject.click();
					continue;
				}
				const panelReject = panel
					.getByRole( 'button', { name: 'Reject', exact: true } )
					.first();
				if ( ( await panelReject.count() ) > 0 ) {
					await panelReject.click();
					continue;
				}
				break;
			}
			// Quiescence, not just momentary emptiness: in-flight pushes
			// from the typing race can escalate MORE edits after the list
			// first empties. Only settled-and-still-empty after a full
			// poll/flush cycle counts — otherwise reject again.
			await noticePage.waitForTimeout( 3000 );
			expect( await panel.count() ).toBe( 0 );
			// The in-canvas cards unmount with the list.
			expect( await pendingCard.count() ).toBe( 0 );
			// Resolving also clears the notices (per-item and aggregate
			// alike).
			expect(
				await noticePage
					.locator( '.components-notice' )
					.filter( { hasText: 'set aside' } )
					.count()
			).toBe( 0 );
		} ).toPass( { timeout: 60000 } );

		// Let the resolution rows flush to the server (the list shrinks
		// optimistically; durability needs the wire round trip) before
		// testing persistence across a reload.
		await noticePage.waitForTimeout( 4000 );

		await noticePage.reload();
		await expect(
			noticePage.locator( 'iframe[name="editor-canvas"]' )
		).toBeVisible( { timeout: 30000 } );
		// Allow the bootstrap replay to settle; a resolved proposal must
		// not re-notify or repopulate the review panel.
		await noticePage.waitForTimeout( 4000 );
		await expect(
			noticePage
				.locator( '.components-notice' )
				.filter( { hasText: 'set aside' } )
		).toHaveCount( 0 );
		await noticeEditor.openDocumentSettingsSidebar();
		// The sidebar remembers the Block tab across reloads; the panel
		// (were it wrongly present) would live in the Post tab.
		await noticePage
			.getByRole( 'tab', { name: 'Post', exact: true } )
			.click();
		await expect(
			noticePage.locator( '.editor-collaboration-review-panel' )
		).toHaveCount( 0 );
		await expect(
			noticePage.locator( '.editor-collaboration-pending-card__body' )
		).toHaveCount( 0 );
	} );

	test( 'custom HTML blocks sync between users and persist through save', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Custom HTML Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Before the raw block</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { page2 } = collaborationUtils;
		const page1 = editor.page;

		/*
		 * REGRESSION: Custom HTML keeps its markup in innerContent
		 * fragments (no content attribute), which the capture bridge used
		 * to ignore entirely — the block never synced at all. It now rides
		 * the engine's content field through the codec.
		 */
		await page1.evaluate( ( html ) => {
			const block = ( window as any ).wp.blocks.createBlock(
				'core/html',
				{}
			);
			block.innerContent = [ html ];
			( window as any ).wp.data
				.dispatch( 'core/block-editor' )
				.insertBlocks( block );
		}, '<div class="synced-raw">custom markup</div>' );

		// The peer receives the block with its markup.
		await expect( async () => {
			const peerHtml = await page2.evaluate( () =>
				( window as any ).wp.data
					.select( 'core/block-editor' )
					.getBlocks()
					.filter( ( b: { name: string } ) => 'core/html' === b.name )
					.map( ( b: { innerContent?: Array< string | null > } ) =>
						( b.innerContent ?? [] ).join( '' )
					)
			);
			expect( peerHtml ).toEqual( [
				'<div class="synced-raw">custom markup</div>',
			] );
		} ).toPass( { timeout: 15000 } );

		// The markup persists through the author's save.
		await editor.saveDraft();
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain(
			'<div class="synced-raw">custom markup</div>'
		);
		expect( saved.content.raw ).toContain( 'wp:html' );
	} );

	test( 'legacy blocks get DETERMINISTIC genesis ids: both tabs and the server mint identical identities with no adoption round-trip', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// A legacy post: saved content with NO syncIds.
		const post = await requestUtils.createPost( {
			title: 'Intent Log Deterministic Genesis Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>First legacy</p>\n<!-- /wp:paragraph -->\n' +
				'<!-- wp:paragraph -->\n<p>Second legacy</p>\n<!-- /wp:paragraph -->\n' +
				'<!-- wp:paragraph -->\n<p>Third legacy</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		// The ids every independent minter must derive from this content.
		const expectedIds = [ 0, 1, 2 ].map( ( index ) =>
			genesisSyncId( { postId: post.id, revisionId: 0 }, [ index ] )
		);

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;

		// Both tabs converge on the EXACT deterministic ids — not merely on
		// matching ids (which adoption could also produce, slower).
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				const ids = blocks.map(
					( block ) =>
						(
							block.attributes.metadata as {
								syncId?: string;
							}
						 )?.syncId
				);
				expect( ids ).toEqual( expectedIds );
			} ).toPass( { timeout: 15000 } );
		}

		/*
		 * The identities are durable: a real edit + save persists them
		 * verbatim. (Identity stamping alone is deliberately non-persistent
		 * — it must never dirty an untouched post — so the spec makes a
		 * content edit first.)
		 */
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await editor.page.keyboard.press( 'End' );
		await editor.page.keyboard.type( ' edited' );
		await editor.saveDraft();
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		const savedRaw = unescapeCommentDashes( saved.content.raw );
		for ( const id of expectedIds ) {
			expect( savedRaw ).toContain( `"syncId":"${ id }"` );
		}
	} );

	test( 'multibyte text syncs and persists intact (UTF-16 code-unit coordinates)', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Multibyte Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Départ 你好</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		// User 2 appends multibyte text to the multibyte paragraph.
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' — café niño 世界' );

		const expected = 'Départ 你好 — café niño 世界';
		await expect( async () => {
			const blocks = await editor.getBlocks();
			expect( blocks[ 0 ].attributes.content ).toBe( expected );
		} ).toPass( { timeout: 10000 } );

		// The author saves; the multibyte content survives the server round
		// trip byte-intact.
		await editor2.saveDraft();
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain( expected );
	} );

	test( 'formatted content survives genesis, sync, and save (rich-text coordinates)', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Formatting Round Trip',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Hello <em>styled</em> world</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;

		// The peer sees the formatting from genesis.
		await expect( async () => {
			const blocks = await editor2.getBlocks();
			expect( blocks[ 0 ].attributes.content ).toContain(
				'<em>styled</em>'
			);
		} ).toPass( { timeout: 10000 } );

		// The peer appends text; the em span survives untouched on both.
		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' indeed' );

		await expect( async () => {
			const blocks = await editor.getBlocks();
			expect( blocks[ 0 ].attributes.content ).toBe(
				'Hello <em>styled</em> world indeed'
			);
		} ).toPass( { timeout: 10000 } );

		await editor2.saveDraft();
		const saved = await requestUtils.rest< { content: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.content.raw ).toContain(
			'Hello <em>styled</em> world indeed'
		);
	} );

	test( 'one user bolds a word while the other types in the SAME paragraph: both changes survive', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// The marquee capability of rich-text coordinates: a format span and
		// concurrent typing merge in plain-text space — under HTML-string
		// diffing this was an escalation (or worse, markup corruption).
		const post = await requestUtils.createPost( {
			title: 'Intent Log Concurrent Format Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Make World bold now</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// User 1 selects the word "World" and bolds it; user 2 types at the
		// end of the same paragraph at the same time.
		const paragraph1 = editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first();
		await paragraph1.dblclick( { position: { x: 60, y: 10 } } );
		// Anchor selection on the exact word regardless of layout: select
		// "World" via the store for precision.
		await page1.evaluate( () => {
			// eslint-disable-next-line @wordpress/no-global-get-selection -- Browser-context DOM code inside page.evaluate, not editor React.
			const selectAll = window.getSelection();
			const block = document.querySelector(
				'[data-type="core/paragraph"]'
			);
			const textNode = block?.firstChild;
			if ( ! textNode || ! selectAll ) {
				return;
			}
			const text = textNode.textContent ?? '';
			const start = text.indexOf( 'World' );
			const range = document.createRange();
			range.setStart( textNode, start );
			range.setEnd( textNode, start + 'World'.length );
			selectAll.removeAllRanges();
			selectAll.addRange( range );
		} );

		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page2.keyboard.press( 'End' );

		await Promise.all( [
			page1.keyboard.press( 'ControlOrMeta+b' ),
			page2.keyboard.type( ' please', { delay: 50 } ),
		] );

		// Both changes survive on both editors.
		for ( const currentEditor of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await currentEditor.getBlocks();
				const content = blocks[ 0 ].attributes.content as string;
				expect( content ).toContain( '<strong>World</strong>' );
				expect( content ).toContain( 'now please' );
			} ).toPass( { timeout: 15000 } );
		}
	} );

	test( 'the wpSync console inspector records decoded wire traffic when enabled', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Inspector Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Inspect me</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const page1 = editor.page;

		type WpSyncWindow = Window & {
			wpSync: {
				enable: () => string;
				untail: () => string;
				log: () => Array< {
					room: string;
					rows: Array< { summary: string } >;
				} >;
				doc: () => { root?: unknown[] } | undefined;
			};
		};
		await page1.evaluate( () => {
			const wpSync = ( window as unknown as WpSyncWindow ).wpSync;
			wpSync.enable();
			wpSync.untail(); // Keep the console quiet for the harness.
		} );

		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await page1.keyboard.type( ' closely' );

		await expect( async () => {
			const captured = await page1.evaluate( () => {
				const wpSync = ( window as unknown as WpSyncWindow ).wpSync;
				return {
					records: wpSync.log(),
					docBlocks: wpSync.doc()?.root?.length ?? 0,
				};
			} );
			expect( captured.records.length ).toBeGreaterThan( 0 );
			const summaries = captured.records.flatMap( ( record ) =>
				record.rows.map( ( row ) => row.summary )
			);
			expect(
				summaries.some( ( summary ) =>
					summary.includes( 'insert_text' )
				)
			).toBe( true );
			// Session state accessors work too.
			expect( captured.docBlocks ).toBeGreaterThan( 0 );
		} ).toPass( { timeout: 10000 } );

		// Cleanup: the flag persists per browser profile.
		await page1.evaluate( () =>
			window.localStorage.removeItem( 'wp_sync_debug' )
		);
	} );

	test( 'title edits sync between users in both directions', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Original Title',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2 } = collaborationUtils;

		// User 1 rewrites the title; user 2 sees it.
		await editor.canvas
			.getByRole( 'textbox', { name: 'Add title' } )
			.fill( 'Title from user one' );
		await expect(
			editor2.canvas.getByRole( 'textbox', { name: 'Add title' } )
		).toHaveText( 'Title from user one', { timeout: 10000 } );

		// User 2 rewrites it back; user 1 sees it (sequential, no conflict).
		await editor2.canvas
			.getByRole( 'textbox', { name: 'Add title' } )
			.fill( 'Title from user two' );
		await expect(
			editor.canvas.getByRole( 'textbox', { name: 'Add title' } )
		).toHaveText( 'Title from user two', { timeout: 10000 } );

		// The synced title persists through a save by the non-author.
		await editor.saveDraft();
		const saved = await requestUtils.rest< { title: { raw: string } } >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.title.raw ).toBe( 'Title from user two' );
	} );

	test( 'entity properties (excerpt, status, sticky, tags, meta) sync live in both directions and survive a save', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Fresh tags per run so reruns never collide on term names.
		const stamp = Date.now();
		const tagIds: number[] = [];
		for ( const name of [ 'live-one', 'live-two' ] ) {
			const tag = await requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/tags',
				data: { name: `rtc-prop-${ name }-${ stamp }` },
			} );
			tagIds.push( tag.id );
		}

		const post = await requestUtils.createPost( {
			title: 'Property Sync',
			status: 'draft',
			excerpt: 'Original excerpt',
			content:
				'<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { page2 } = collaborationUtils;
		const page1 = editor.page;

		// User 1 updates workflow fields and terms; user 2 sees them live
		// (no save).
		await page1.evaluate( ( ids ) => {
			( window as any ).wp.data.dispatch( 'core/editor' ).editPost( {
				excerpt: 'Excerpt from user one',
				status: 'pending',
				tags: ids,
			} );
		}, tagIds );
		await expect( async () => {
			const values = await page2.evaluate( () => {
				const { select } = ( window as any ).wp.data;
				return {
					excerpt:
						select( 'core/editor' ).getEditedPostAttribute(
							'excerpt'
						),
					status: select( 'core/editor' ).getEditedPostAttribute(
						'status'
					),
					tags: select( 'core/editor' ).getEditedPostAttribute(
						'tags'
					),
				};
			} );
			expect( values ).toEqual( {
				excerpt: 'Excerpt from user one',
				status: 'pending',
				tags: tagIds,
			} );
		} ).toPass( { timeout: 15000 } );

		// A boolean flows the other way with its type intact.
		await page2.evaluate( () => {
			( window as any ).wp.data
				.dispatch( 'core/editor' )
				.editPost( { sticky: true } );
		} );
		await expect( async () => {
			const sticky = await page1.evaluate( () =>
				( window as any ).wp.data
					.select( 'core/editor' )
					.getEditedPostAttribute( 'sticky' )
			);
			expect( sticky ).toBe( true );
		} ).toPass( { timeout: 15000 } );

		// Registered post meta syncs per key: user 2 writes footnotes
		// (registered meta) and user 1 receives them live.
		const footnotes = '[{"content":"A live footnote","id":"phase3-fn"}]';
		await page2.evaluate( ( value ) => {
			( window as any ).wp.data
				.dispatch( 'core/editor' )
				.editPost( { meta: { footnotes: value } } );
		}, footnotes );
		await expect( async () => {
			const received = await page1.evaluate(
				() =>
					( window as any ).wp.data
						.select( 'core/editor' )
						.getEditedPostAttribute( 'meta' )?.footnotes
			);
			expect( received ).toBe( footnotes );
		} ).toPass( { timeout: 15000 } );

		// One save (user 2, who never touched excerpt, status, or tags)
		// persists the whole synced state.
		await page2.evaluate( async () => {
			await ( window as any ).wp.data
				.dispatch( 'core/editor' )
				.savePost();
		} );
		const saved = await requestUtils.rest< {
			excerpt: { raw: string };
			status: string;
			sticky: boolean;
			tags: number[];
			meta: { footnotes: string };
		} >( {
			path: `/wp/v2/posts/${ post.id }`,
			params: { context: 'edit' },
		} );
		expect( saved.excerpt.raw ).toBe( 'Excerpt from user one' );
		expect( saved.status ).toBe( 'pending' );
		expect( saved.sticky ).toBe( true );
		expect( saved.tags ).toEqual( expect.arrayContaining( tagIds ) );
		expect( saved.meta.footnotes ).toBe( footnotes );
	} );

	test( 'a category created mid-session appears in the peer’s term list and assignment', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'New Term Sync',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { page2 } = collaborationUtils;
		const page1 = editor.page;

		// Both clients resolve the term list, which loads the
		// taxonomy/category collection room (the notification lane).
		for ( const page of [ page1, page2 ] ) {
			await page.evaluate( async () => {
				await ( window as any ).wp.data
					.resolveSelect( 'core' )
					.getEntityRecords( 'taxonomy', 'category', {
						per_page: -1,
					} );
			} );
		}

		// User 1 creates a brand-new category (the sidebar's "Add New
		// Category" flow) and assigns it to the post.
		const categoryName = `Live Category ${ Date.now() }`;
		const termId = await page1.evaluate( async ( name ) => {
			const { dispatch } = ( window as any ).wp.data;
			const record = await dispatch( 'core' ).saveEntityRecord(
				'taxonomy',
				'category',
				{ name }
			);
			dispatch( 'core/editor' ).editPost( {
				categories: [ record.id ],
			} );
			return record.id;
		}, categoryName );

		// User 2's term list gains the new category WITHOUT any save —
		// the peer save signal refetches the collection…
		await expect( async () => {
			const names = await page2.evaluate( () =>
				(
					( window as any ).wp.data
						.select( 'core' )
						.getEntityRecords( 'taxonomy', 'category', {
							per_page: -1,
						} ) ?? []
				).map( ( term: { name: string } ) => term.name )
			);
			expect( names ).toContain( categoryName );
		} ).toPass( { timeout: 15000 } );

		// …and the post's category assignment synced alongside it.
		await expect( async () => {
			const categories = await page2.evaluate( () =>
				( window as any ).wp.data
					.select( 'core/editor' )
					.getEditedPostAttribute( 'categories' )
			);
			expect( categories ).toEqual( [ termId ] );
		} ).toPass( { timeout: 15000 } );
	} );

	test( 'concurrent divergent title edits surface an escalation notice, and editors converge', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Contested',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// Both users rewrite the title at the same moment: one write wins
		// the register, the other is set aside for review.
		await Promise.all( [
			editor.canvas
				.getByRole( 'textbox', { name: 'Add title' } )
				.fill( 'Title A' ),
			editor2.canvas
				.getByRole( 'textbox', { name: 'Add title' } )
				.fill( 'Title B' ),
		] );

		await expect( async () => {
			const counts = await Promise.all( [
				page1.getByText( /was set aside/ ).count(),
				page2.getByText( /was set aside/ ).count(),
			] );
			expect( counts[ 0 ] + counts[ 1 ] ).toBeGreaterThan( 0 );
		} ).toPass( { timeout: 15000 } );

		// Both editors converge on the winning title.
		await expect( async () => {
			const titles = await Promise.all(
				[ editor, editor2 ].map( ( currentEditor ) =>
					currentEditor.canvas
						.getByRole( 'textbox', { name: 'Add title' } )
						.textContent()
				)
			);
			expect( titles[ 0 ] ).toBe( titles[ 1 ] );
			expect( [ 'Title A', 'Title B' ] ).toContain( titles[ 0 ] );
		} ).toPass( { timeout: 15000 } );
	} );

	test( 'a mid-session engine change drops open tabs into the lock modal instead of retry-hammering', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Intent Log Engine Flip Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>Before the flip</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { page2 } = collaborationUtils;
		const page1 = editor.page;

		// The site's engine changes to yjs-server while both tabs are
		// mid-session. (Deleting the option is no longer a flip: intent-log
		// IS the framework default.) Their polls still stamp intent-log, so
		// the server fences them with 409 rest_sync_engine_mismatch and the
		// clients must fall into the unrecoverable-mismatch modal — not an
		// endless 409 retry loop. The suite's afterAll deletes the option.
		await setSyncEngine( requestUtils, 'yjs-server' );

		// Tabs connected over the advisory channel poll on demand plus a
		// 25 s safety poll, so the fence is noticed within that window.
		for ( const page of [ page1, page2 ] ) {
			await expect(
				page.getByText( 'Collaboration settings changed' )
			).toBeVisible( { timeout: 35000 } );
		}
	} );

	test( 'collaborative undo reverts only this user’s edit and redo restores it, on both canvases', async ( {
		collaborationUtils,
		requestUtils,
		editor,
	} ) => {
		// Settle windows (capture delay + poll + ack) stack up; give the
		// happy path room on CI.
		test.setTimeout( 120_000 );

		const post = await requestUtils.createPost( {
			title: 'Intent Log Undo Test',
			status: 'draft',
			content:
				'<!-- wp:paragraph -->\n<p>First paragraph</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second paragraph</p>\n<!-- /wp:paragraph -->',
			date_gmt: new Date().toISOString(),
		} );

		await collaborationUtils.openCollaborativeSession( post.id );
		const { editor2, page2 } = collaborationUtils;
		const page1 = editor.page;

		// User A edits the FIRST paragraph, user B the SECOND.
		await editor.canvas
			.locator( '[data-type="core/paragraph"]' )
			.first()
			.click();
		await page1.keyboard.press( 'End' );
		await page1.keyboard.type( ' by admin', { delay: 50 } );

		await editor2.canvas
			.locator( '[data-type="core/paragraph"]' )
			.nth( 1 )
			.click();
		await page2.keyboard.press( 'End' );
		await page2.keyboard.type( ' by user two', { delay: 50 } );

		// Both edits settle and converge on both canvases.
		for ( const which of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await which.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First paragraph by admin'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second paragraph by user two'
				);
			} ).toPass( { timeout: 20000 } );
		}

		/*
		 * Collaborative undo needs the unit SETTLED (accepted rows + acks
		 * absorbed) before the stack arms — give the wire a beat past
		 * convergence, then undo. Only A's OWN edit reverts; B's edit is
		 * untouchable by A's undo, and the inverse propagates to B like any
		 * ordinary intent.
		 */
		await page1.waitForTimeout( 3000 );
		await page1.keyboard.press( 'ControlOrMeta+z' );

		for ( const which of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await which.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First paragraph'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second paragraph by user two'
				);
			} ).toPass( { timeout: 20000 } );
		}

		// Redo restores the undone edit, again for both.
		await page1.waitForTimeout( 3000 );
		await page1.keyboard.press( 'ControlOrMeta+Shift+z' );

		for ( const which of [ editor, editor2 ] ) {
			await expect( async () => {
				const blocks = await which.getBlocks();
				expect( blocks[ 0 ].attributes.content ).toBe(
					'First paragraph by admin'
				);
				expect( blocks[ 1 ].attributes.content ).toBe(
					'Second paragraph by user two'
				);
			} ).toPass( { timeout: 20000 } );
		}
	} );
} );
