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
 * The advisory channel over its WebSocket link, relayed by a server that
 * is NOT the plugin's daemon: the example bring-your-own relay
 * (examples/advisory-relay/relay.mjs), which checks each tab's signed
 * access token with the shared secret and never touches WordPress or its
 * database. The config runs the relay on port 8790; the fixture plugin
 * activated here configures the same secret on the site, and the
 * WebSocket URL setting points the tabs at the relay. Two tabs meet in the relay's roster, an idle
 * tab polls only when told to, and an edit still travels over REST.
 *
 * Runs on the daemon lane but with SHORT POLLING selected for its
 * duration, like the daemon-relayed advisory spec.
 */

const REPO_ROOT = path.resolve( __dirname, '../../../..' );
const TRANSPORT_OPTION = 'gutenberg_sync_engines_transport';
const ADVISORY_OPTION = 'gutenberg_sync_engines_advisory_channel';
const ADVISORY_URL_OPTION = 'gutenberg_sync_engines_advisory_websocket_url';
const FIXTURE_PLUGIN = 'gutenberg-test-plugin-advisory-relay-access-token';
const RELAY_URL = 'ws://localhost:8790';

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

async function socketUrl( page: Page ): Promise< string | undefined > {
	return await page.evaluate( () => {
		const settings = (
			window as Window & {
				_gutenbergSyncEnginesSettings?: {
					advisory?: { socketUrl?: string };
				};
			}
		 )._gutenbergSyncEnginesSettings;
		return settings?.advisory?.socketUrl;
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

test.describe( 'Collaboration - advisory channel over a bring-your-own relay', () => {
	let previousRealWs: string | undefined;

	test.beforeAll( async ( { requestUtils } ) => {
		// Short polling for this spec (the lane selected websocket), the
		// websocket link as the advisory channel, the "WebSocket advisory
		// server" setting aimed at the relay, and the fixture that turns
		// access-token mode on with the relay's secret.
		wpCli( 'option', 'update', TRANSPORT_OPTION, 'http-polling' );
		wpCli( 'option', 'update', ADVISORY_OPTION, 'websocket-advisory' );
		wpCli( 'option', 'update', ADVISORY_URL_OPTION, RELAY_URL );
		await requestUtils.activatePlugin( FIXTURE_PLUGIN );
		previousRealWs = process.env.GUTENBERG_RTC_REAL_WS;
		delete process.env.GUTENBERG_RTC_REAL_WS;
	} );

	test.afterAll( async ( { requestUtils } ) => {
		if ( undefined !== previousRealWs ) {
			process.env.GUTENBERG_RTC_REAL_WS = previousRealWs;
		}
		await requestUtils.deactivatePlugin( FIXTURE_PLUGIN );
		wpCli( 'option', 'update', TRANSPORT_OPTION, 'websocket' );
		wpCli( 'option', 'delete', ADVISORY_OPTION );
		wpCli( 'option', 'delete', ADVISORY_URL_OPTION );
	} );

	test.afterEach( async ( { collaborationUtils } ) => {
		await collaborationUtils.teardown();
	} );

	test( 'two tabs meet in the relay roster on signed access tokens, poll on demand, and converge over REST', async ( {
		collaborationUtils,
		requestUtils,
		page,
		editor,
	} ) => {
		const post = await requestUtils.createPost( {
			title: 'Advisory relay: two tabs',
			content: '<!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph -->',
			status: 'draft',
		} );
		await collaborationUtils.openCollaborativeSession( post.id );
		const page2 = collaborationUtils.getPage( 0 );

		// The advisory server setting pointed the page at the relay, not
		// the daemon.
		expect( await socketUrl( page ) ).toBe( RELAY_URL );

		// The relay's roster names both tabs as soon as both sockets are
		// open: it accepted both access tokens without asking WordPress.
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
		// endpoint (announced through the relay, delivered by the poll).
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
