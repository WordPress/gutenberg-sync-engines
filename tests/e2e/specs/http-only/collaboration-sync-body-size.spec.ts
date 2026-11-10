/**
 * WordPress dependencies
 */
import type { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import { test, expect } from '../../config/collaboration-fixtures';
import { SECOND_USER } from '../gutenberg-collaboration/fixtures/collaboration-utils';

const EXTRA_POST_COUNT = 40;
const LARGE_FIELD_SIZE = 450 * 1024;
const MAX_SYNC_BODY_SIZE = 16 * 1024 * 1024;

// One room per extra post record, plus at least the primary post's own
// room. How many ADDITIONAL baseline rooms register is engine-dependent
// (collection rooms — post lists, taxonomies, comments — register under
// CRDT engines but are a no-op under intent-log's v1 scope), so this is a
// floor, not an exact census: the test's subject is multi-room body-size
// batching, not room bookkeeping.
const MIN_EXPECTED_ROOMS = EXTRA_POST_COUNT + 1;

function isSyncUpdateRequest( url: string ): boolean {
	const decodedUrl = decodeURIComponent( url );
	return (
		decodedUrl.includes( '/wp-json/wp-sync/v1/updates' ) ||
		decodedUrl.includes( 'rest_route=/wp-sync/v1/updates' )
	);
}

/**
 * Pins the engine for this suite (and restores the default afterwards).
 *
 * The test's subject is multi-room body-size BATCHING, which needs an
 * engine whose sessions author updates for background entity-record edits.
 * yjs-server does; intent-log's v1 scope does not (its capture follows the
 * open editor), so under the site default this spec would wait forever for
 * updates that never come. Pinning also removes a latent order dependence
 * on whichever engine a previous suite left selected.
 *
 * @param {RequestUtils} requestUtils Playwright request utils.
 * @param {string|null}  engine       Engine slug, or null to restore.
 */
async function setSyncEngine(
	requestUtils: RequestUtils,
	engine: string | null
) {
	if ( null === engine ) {
		// Nulling an already-absent option 500s (see the engine specs'
		// identical helper): restore only while our flip is in effect.
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

test.describe( 'Collaboration sync body size', () => {
	test.beforeEach( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, 'yjs-server' );
	} );

	test.afterAll( async ( { requestUtils } ) => {
		await setSyncEngine( requestUtils, null );
	} );

	test( 'keeps multi-room sync polls under the body-size limit', async ( {
		collaborationUtils,
		requestUtils,
		page,
	} ) => {
		test.setTimeout( 180_000 );

		const syncRequests: Array< {
			length: number;
			rooms: number | null;
			updateCount: number | null;
		} > = [];
		const syncResponses: Array< {
			ok: boolean;
			status: number;
		} > = [];

		page.on( 'request', ( request ) => {
			if ( ! isSyncUpdateRequest( request.url() ) ) {
				return;
			}
			const body = request.postData() || '';
			let rooms = null;
			let updateCount = null;
			try {
				const parsed = JSON.parse( body );
				rooms = Array.isArray( parsed.rooms )
					? parsed.rooms.length
					: null;
				updateCount = Array.isArray( parsed.rooms )
					? parsed.rooms.reduce(
							( total: number, room: { updates?: unknown[] } ) =>
								total +
								( Array.isArray( room.updates )
									? room.updates.length
									: 0 ),
							0
					  )
					: null;
			} catch {}
			syncRequests.push( {
				length: Buffer.byteLength( body ),
				rooms,
				updateCount,
			} );
		} );

		page.on( 'response', ( response ) => {
			if ( ! isSyncUpdateRequest( response.url() ) ) {
				return;
			}
			syncResponses.push( {
				ok: response.ok(),
				status: response.status(),
			} );
		} );

		const post = await requestUtils.createPost( {
			title: 'Sync Body Size',
			status: 'draft',
			date_gmt: new Date().toISOString(),
		} );
		const extraPosts = [];
		for ( let i = 0; i < EXTRA_POST_COUNT; i++ ) {
			extraPosts.push(
				await requestUtils.createPost( {
					title: `Sync Body Size Extra ${ i }`,
					status: 'draft',
					date_gmt: new Date().toISOString(),
				} )
			);
		}
		const extraPostIds = extraPosts.map( ( extraPost ) => extraPost.id );

		await collaborationUtils.openPost( post.id );
		await collaborationUtils.joinUser( post.id, SECOND_USER );
		await collaborationUtils.waitForMutualDiscovery();

		await page.evaluate( async ( ids ) => {
			await Promise.all(
				ids.map( ( id ) =>
					window.wp.data
						.resolveSelect( 'core' )
						.getEntityRecord( 'postType', 'post', id )
				)
			);
		}, extraPostIds );

		await expect
			.poll(
				() =>
					Math.max(
						0,
						...syncRequests.map( ( request ) => request.rooms || 0 )
					),
				{ timeout: 20000 }
			)
			.toBeGreaterThanOrEqual( MIN_EXPECTED_ROOMS );

		await page.evaluate(
			( { ids, largeFieldSize } ) => {
				const largeText = 'x'.repeat( largeFieldSize );
				for ( const id of ids ) {
					window.wp.data
						.dispatch( 'core' )
						.editEntityRecord( 'postType', 'post', id, {
							title: `${ id }-${ largeText }`,
						} );
				}
			},
			{ ids: extraPostIds, largeFieldSize: LARGE_FIELD_SIZE }
		);

		await expect
			.poll(
				() =>
					syncRequests.some(
						( request ) =>
							request.updateCount !== null &&
							request.updateCount > 0
					),
				{ timeout: 20000 }
			)
			.toBe( true );

		await expect
			.poll(
				() =>
					syncRequests.filter(
						( request ) =>
							request.updateCount !== null &&
							request.updateCount > 0
					).length,
				{ timeout: 20000 }
			)
			.toBeGreaterThan( 1 );

		expect(
			Math.max( 0, ...syncRequests.map( ( request ) => request.length ) )
		).toBeLessThanOrEqual( MAX_SYNC_BODY_SIZE );
		expect(
			syncResponses.some( ( response ) => response.status === 413 )
		).toBe( false );
		await expect(
			page.getByRole( 'dialog', { name: 'Connection lost' } )
		).toBeHidden();
	} );
} );
