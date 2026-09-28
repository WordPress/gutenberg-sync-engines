/**
 * External dependencies
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Internal dependencies
 */
import { test, expect } from '../../config/collaboration-fixtures';

/**
 * The advisory channel over its WebSocket link (docs/plan/advisory-channel.md):
 * short polling stays the transport, and each tab opens a socket to the
 * sync daemon, which relays presence and "go and poll" notices between
 * the tabs in a room and never a row. Two tabs see each other in the
 * daemon's roster, poll only on demand, and an edit still travels over
 * the REST endpoint and converges.
 *
 * Runs on the daemon lane (the daemon is up) but with SHORT POLLING
 * selected for its duration: under the websocket transport the polling
 * manager never runs, so no advisory channel would open.
 */

const REPO_ROOT = path.resolve( __dirname, '../../../..' );
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
const ADVISORY_OPTION = 'gutenberg_sync_engines_advisory_channel';

function wpCli( ...args: string[] ): string {
	const result = spawnSync(
		'npx',
		[
			'wp-env',
			'--config',
			'.wp-env.tests.json',
			'run',
			'cli',
			'wp',
			...args,
		],
		{ cwd: REPO_ROOT, encoding: 'utf8' }
	);
	if ( 0 !== result.status ) {
		throw new Error(
			`wp ${ args.join( ' ' ) } failed: ${ result.stderr }`
		);
	}
	return result.stdout.trim();
}

interface AdvisoryDebugState {
	active: boolean;
	channel: string;
	socket?: string;
	peers: Array< { token: string; clientId: number | null; open: boolean } >;
}

async function advisoryState( page: Page ): Promise< AdvisoryDebugState > {
	return await page.evaluate( () => {
		const api = (
			window as Window & {
				wpSync?: { advisory: () => AdvisoryDebugState };
			}
		 ).wpSync;
		return api ? api.advisory() : { active: false, channel: '', peers: [] };
	} );
}

async function waitForOpenPeer( page: Page, timeout: number ): Promise< void > {
	await page.waitForFunction(
		() => {
			const api = (
				window as Window & {
					wpSync?: { advisory: () => AdvisoryDebugState };
				}
			 ).wpSync;
			const state = api?.advisory();
			return (
				!! state &&
				state.peers.some(
					( peer ) => peer.open && null !== peer.clientId
				)
			);
		},
		undefined,
		{ timeout }
	);
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

test.describe( 'Collaboration - advisory channel over the websocket link', () => {
	let previousRealWs: string | undefined;

	test.beforeAll( () => {
		// Short polling for this spec (the lane selected websocket), and
		// the daemon relay as the advisory channel. The fixtures' sync
		// waits follow the transport, not the lane.
		wpCli( 'option', 'update', TRANSPORT_OPTION, 'http-polling' );
		wpCli( 'option', 'update', ADVISORY_OPTION, 'websocket-advisory' );
		previousRealWs = process.env.GUTENBERG_RTC_REAL_WS;
		delete process.env.GUTENBERG_RTC_REAL_WS;
	} );

	test.afterAll( () => {
		if ( undefined !== previousRealWs ) {
			process.env.GUTENBERG_RTC_REAL_WS = previousRealWs;
		}
		wpCli( 'option', 'update', TRANSPORT_OPTION, 'websocket' );
		wpCli( 'option', 'delete', ADVISORY_OPTION );
	} );

	test.afterEach( async ( { collaborationUtils } ) => {
		await collaborationUtils.teardown();
	} );

	test( 'two tabs meet in the daemon roster, poll on demand, and converge over REST', async ( {
		collaborationUtils,
		requestUtils,
		page,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'WebSocket advisory: two tabs',
			content: '<!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph -->',
			status: 'draft',
		} );
		await collaborationUtils.openCollaborativeSession( post.id );
		const page2 = collaborationUtils.getPage( 0 );

		// The daemon's roster names both tabs as soon as both sockets are
		// open — no handshake rides the heartbeat.
		await waitForOpenPeer( page, 30000 );
		await waitForOpenPeer( page2, 30000 );
		const state = await advisoryState( page );
		expect( state.active ).toBe( true );
		expect( state.channel ).toBe( 'websocket-advisory' );
		expect( state.socket ).toBe( 'open' );
		expect( state.peers.filter( ( peer ) => peer.open ) ).toHaveLength( 1 );

		// Give the tabs one more poll to notice full coverage, then watch
		// an idle tab: well under the 1 s timer cadence.
		await page.waitForTimeout( 2500 );
		expect( await countSyncRequests( page2, 8000 ) ).toBeLessThanOrEqual(
			2
		);

		// An edit on one side still reaches the other through the REST
		// endpoint (announced through the daemon, delivered by the poll).
		await editor.canvas
			.getByRole( 'document', { name: /Block: Paragraph/ } )
			.first()
			.click();
		await page.keyboard.press( 'End' );
		await page.keyboard.type( ' from one' );
		await expect(
			collaborationUtils
				.getEditor( 0 )
				.canvas.getByRole( 'document', { name: /Block: Paragraph/ } )
				.first()
		).toContainText( 'Shared from one', { timeout: 20000 } );
	} );
} );
