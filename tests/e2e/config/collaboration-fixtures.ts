/**
 * Plugin-local collaboration fixtures: the subtree's fixture wiring
 * (user setup, collaboration toggle, teardown) around a hardened
 * CollaborationUtils. The one override closes a full-suite-load flake
 * in the subtree fixture's login flow; the root-cause fix belongs
 * upstream in Gutenberg (human-owned), so the subtree stays pristine
 * and the specs import this module instead.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line @wordpress/dependency-group
import { test as base } from '@wordpress/e2e-test-utils-playwright';
export { expect } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import CollaborationUtils, {
	SECOND_USER,
	setCollaboration,
} from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';

/**
 * Diagnostic CPU throttle (issue #37): the burst-timing failures only fire
 * on busy machines, so `RTC_E2E_CPU_THROTTLE=<rate>` slows every editor
 * page by that factor (Chrome devtools emulation) to reproduce them on an
 * otherwise idle machine. Off (no-op) unless the variable is set above 1.
 *
 * @param page The page to slow down.
 */
async function applyCpuThrottle(
	page: import('@playwright/test').Page
): Promise< void > {
	const rate = Number( process.env.RTC_E2E_CPU_THROTTLE );
	if ( ! ( rate > 1 ) ) {
		return;
	}
	const session = await page.context().newCDPSession( page );
	await session.send( 'Emulation.setCPUThrottlingRate', { rate } );
}

/**
 * Companion probe for the throttle: records main-thread stalls (long
 * tasks) so a failed run shows WHEN each editor page stopped servicing
 * its event loop — the suspected mechanism behind locators that match
 * nothing while the element sits in the DOM. Buffered, so entries from
 * before installation are kept too. Read back at teardown.
 *
 * @param page The page to observe.
 */
async function installLongTaskProbe(
	page: import('@playwright/test').Page
): Promise< void > {
	if ( ! ( Number( process.env.RTC_E2E_CPU_THROTTLE ) > 1 ) ) {
		return;
	}
	await page
		.evaluate( () => {
			const store = ( (
				window as Window & {
					__rtcLongTasks?: Array< { s: number; d: number } >;
				}
			 ).__rtcLongTasks = [] as Array< { s: number; d: number } > );
			new PerformanceObserver( ( list ) => {
				for ( const entry of list.getEntries() ) {
					store.push( {
						s: Math.round( entry.startTime ),
						d: Math.round( entry.duration ),
					} );
				}
			} ).observe( { type: 'longtask', buffered: true } );
		} )
		.catch( () => {} );
}

/**
 * Optional CPU profiler for the joined (typing) page, to NAME the code
 * inside a main-thread stall the long-task probe can only time. Set
 * `RTC_E2E_CPU_PROFILE=1` alongside the throttle; the profile of user
 * B's whole editing session attaches to the test as
 * `cpu-profile-page2.cpuprofile` (open in Chrome devtools > Performance).
 */
const cpuProfilers = new WeakMap<
	import('@playwright/test').Page,
	import('playwright-core').CDPSession
>();

async function startCpuProfile(
	page: import('@playwright/test').Page
): Promise< void > {
	if ( '1' !== process.env.RTC_E2E_CPU_PROFILE ) {
		return;
	}
	const session = await page.context().newCDPSession( page );
	await session.send( 'Profiler.enable' );
	await session.send( 'Profiler.start' );
	cpuProfilers.set( page, session );
}

async function stopCpuProfile(
	page: import('@playwright/test').Page,
	label: string,
	testInfo: import('@playwright/test').TestInfo
): Promise< void > {
	const session = cpuProfilers.get( page );
	if ( ! session ) {
		return;
	}
	cpuProfilers.delete( page );
	try {
		const { profile } = ( await session.send( 'Profiler.stop' ) ) as {
			profile: unknown;
		};
		await testInfo.attach( `cpu-profile-${ label }.cpuprofile`, {
			body: JSON.stringify( profile ),
			contentType: 'application/json',
		} );
	} catch {
		// The page may already be gone; losing one profile is fine.
	}
}

/**
 * Waits until a page's sync traffic has been quiet for a moment (no
 * request to the sync endpoint for QUIET_MS, checked for up to MAX_MS).
 *
 * @param page The page to watch.
 */
export async function waitForSyncQuiet( page: Page ): Promise< void > {
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

class HardenedCollaborationUtils extends CollaborationUtils {
	/**
	 * The subtree fixture logs joining users in through wp-login.php,
	 * whose wp_attempt_focus() steals focus (and SELECTS the username
	 * field) on a timer after load. Under full-suite load that timer can
	 * fire between the fixture's two fill() calls, so the password is
	 * inserted into the still-selected username field, the mangled form
	 * submits, and the login page re-renders instead of navigating —
	 * observed in a retry-free full run as a username field holding the
	 * literal password, an empty password field, and a waitForURL
	 * timeout. One clean retry (a fresh context, a fresh login page)
	 * de-races the harness plumbing; the tests' assertion surfaces are
	 * untouched.
	 *
	 * @param args joinUser arguments (post ID, user credentials).
	 * @return The joined user's page and editor.
	 */
	async joinUser(
		...args: Parameters< CollaborationUtils[ 'joinUser' ] >
	): ReturnType< CollaborationUtils[ 'joinUser' ] > {
		let joined;
		try {
			joined = await super.joinUser( ...args );
		} catch {
			joined = await super.joinUser( ...args );
		}
		await applyCpuThrottle( joined.page );
		await installLongTaskProbe( joined.page );
		await startCpuProfile( joined.page );
		return joined;
	}

	/**
	 * The subtree fixture compares the two editors' block trees as JSON
	 * text, so the ORDER of attribute keys decides convergence. That order
	 * is an artifact of how each block reached its editor: the framework's
	 * block merge updates an existing block's attribute map in place, so
	 * a block that changed type keeps its old keys first (`content,
	 * metadata, level`), while the editor that made the change built the
	 * block fresh (`content, level, metadata`). With every block carrying
	 * `metadata.syncId` under de-rtc, that difference shows up on any
	 * type-changing edit (a paste over the document). Sort keys before
	 * comparing: two editors agree when their attributes agree.
	 *
	 * @param args getNormalizedPostState arguments (page).
	 * @return The state with attribute keys in sorted order at every depth.
	 */
	async getNormalizedPostState(
		...args: Parameters< CollaborationUtils[ 'getNormalizedPostState' ] >
	): ReturnType< CollaborationUtils[ 'getNormalizedPostState' ] > {
		const state = await super.getNormalizedPostState( ...args );
		const sortKeys = ( value: unknown ): unknown => {
			if ( Array.isArray( value ) ) {
				return value.map( sortKeys );
			}
			if ( value && 'object' === typeof value ) {
				return Object.fromEntries(
					Object.keys( value as Record< string, unknown > )
						.sort()
						.map( ( key ) => [
							key,
							sortKeys(
								( value as Record< string, unknown > )[ key ]
							),
						] )
				);
			}
			return value;
		};
		type Block = ( typeof state.blocks )[ number ];
		const sortBlocks = ( blocks: Block[] ): Block[] =>
			blocks.map( ( block ) => ( {
				...block,
				attributes: sortKeys(
					block.attributes
				) as Block[ 'attributes' ],
				innerBlocks: sortBlocks( block.innerBlocks as Block[] ),
			} ) );
		return { ...state, blocks: sortBlocks( state.blocks ) };
	}

	/**
	 * The subtree's discovery wait ends with three FUTURE poll responses
	 * per page. With the advisory channel, tabs that have found each other
	 * poll on demand plus a slow safety timer, so those polls may never
	 * come. Discovery here means the collaborators list shows on every
	 * page (awareness has seen the peer) and each page's sync traffic has
	 * then gone quiet for a beat.
	 *
	 * @param options         Options.
	 * @param options.timeout Maximum wait per page in ms.
	 */
	async waitForMutualDiscovery( { timeout }: { timeout?: number } = {} ) {
		if ( '1' === process.env.GUTENBERG_RTC_REAL_WS ) {
			return await super.waitForMutualDiscovery( { timeout } );
		}
		const pages = this.allPages;
		const resolvedTimeout = timeout ?? 10000 + pages.length * 2500;
		await Promise.all(
			pages.map( ( pg ) =>
				pg
					.getByRole( 'button', { name: /Collaborators list/ } )
					.waitFor( { timeout: resolvedTimeout } )
			)
		);
		await Promise.all( pages.map( ( pg ) => waitForSyncQuiet( pg ) ) );
	}

	/**
	 * The subtree's sync-cycle wait knows the HTTP transports (poll
	 * responses) and the retired test WS provider fixture — the REAL
	 * websocket transport has neither. When the suite runs on the real
	 * daemon lane (GUTENBERG_RTC_REAL_WS=1, set by
	 * playwright.rtc-websocket.config.ts), wait on the plugin websocket
	 * manager's own observability global instead: socket open and the
	 * target room past its first applied server response.
	 *
	 * @param args waitForSyncCycle arguments (page, cycles, options).
	 */
	async waitForSyncCycle(
		...args: Parameters< CollaborationUtils[ 'waitForSyncCycle' ] >
	): ReturnType< CollaborationUtils[ 'waitForSyncCycle' ] > {
		if ( '1' !== process.env.GUTENBERG_RTC_REAL_WS ) {
			return await super.waitForSyncCycle( ...args );
		}
		const [ page, cycles = 3, options = {} ] = args;
		const { timeout = 10000, room } = options as {
			timeout?: number;
			room?: string;
		};
		await page.waitForFunction(
			( target: string | null ) => {
				const state = (
					window as Window & {
						__wpSyncWsState?: {
							open: boolean;
							rooms: Record< string, { synced: boolean } >;
						};
					}
				 ).__wpSyncWsState;
				if ( ! state?.open ) {
					return false;
				}
				const roomsState = state.rooms ?? {};
				if ( target ) {
					return true === roomsState[ target ]?.synced;
				}
				return Object.keys( roomsState ).some(
					( name ) =>
						name.startsWith( 'postType/' ) &&
						roomsState[ name ].synced
				);
			},
			room ?? null,
			{ timeout: timeout * cycles }
		);
	}
}

type Fixtures = {
	collaborationUtils: CollaborationUtils;
};

// Mirrors the subtree's fixtures/index.ts wiring exactly, constructing
// the hardened subclass instead.
export const test = base.extend< Fixtures >( {
	collaborationUtils: async (
		{ admin, editor, requestUtils, page },
		use,
		testInfo
	) => {
		const utils = new HardenedCollaborationUtils( {
			admin,
			editor,
			requestUtils,
			page,
		} );
		await applyCpuThrottle( page );
		if ( Number( process.env.RTC_E2E_CPU_THROTTLE ) > 1 ) {
			// The primary page navigates after this, so the probe installs
			// as an init script instead of a one-shot evaluate.
			await page.context().addInitScript( () => {
				const store = ( (
					window as Window & {
						__rtcLongTasks?: Array< { s: number; d: number } >;
					}
				 ).__rtcLongTasks = [] as Array< { s: number; d: number } > );
				new PerformanceObserver( ( list ) => {
					for ( const entry of list.getEntries() ) {
						store.push( {
							s: Math.round( entry.startTime ),
							d: Math.round( entry.duration ),
						} );
					}
				} ).observe( { type: 'longtask', buffered: true } );
			} );
		}
		// Clean up any leftover users from previous runs before creating.
		await requestUtils.deleteAllUsers();
		await requestUtils.createUser( SECOND_USER );
		await setCollaboration( requestUtils, true );
		try {
			await use( utils );
		} finally {
			if ( Number( process.env.RTC_E2E_CPU_THROTTLE ) > 1 ) {
				const pages: Array<
					[ string, import('@playwright/test').Page ]
				> = [ [ 'page1', page ] ];
				const sessions = (
					utils as unknown as {
						sessions?: Array< {
							page: import('@playwright/test').Page;
						} >;
					}
				 ).sessions;
				( sessions ?? [] ).forEach( ( session, index ) =>
					pages.push( [ `page${ index + 2 }`, session.page ] )
				);
				for ( const [ label, target ] of pages ) {
					await stopCpuProfile( target, label, testInfo );
					const tasks = await target
						.evaluate(
							() =>
								(
									window as Window & {
										__rtcLongTasks?: unknown;
									}
								 ).__rtcLongTasks ?? null
						)
						.catch( () => null );
					if ( tasks ) {
						await testInfo.attach( `long-tasks-${ label }`, {
							body: JSON.stringify( tasks ),
							contentType: 'application/json',
						} );
					}
				}
			}
			try {
				await utils.teardown();
			} finally {
				await setCollaboration( requestUtils, false );
			}
		}
	},
} );
