/**
 * Seeded browser fuzz spec for real-time collaboration.
 *
 * Adapted from the Gutenberg RTC browser fuzzer
 * (danluu/gutenberg try/fuzz, test/e2e/specs/editor/collaboration/
 * collaboration-fuzz.spec.ts), reduced to the core that finds bugs and
 * reparameterized for this plugin's engine × transport matrix:
 *
 * - Every test is one SEED. The seed deterministically chooses the initial
 *   post content, the action at every step, the acting user, milestone
 *   (save/reload/late-join) placement, and fault injection. A failing seed
 *   replays exactly (same engine/transport/steps/users).
 * - Actions come from a bounded grammar (block inserts/edits/moves/deletes,
 *   nested structures, title edits, real typing, concurrent edits), not
 *   arbitrary DOM mutation.
 * - After every step, all participants must CONVERGE on the same
 *   SERIALIZED content + title (serialization is what persists; raw
 *   attribute objects legitimately differ across engine code paths), and
 *   no block may be in the invalid-content recovery state.
 * - One seeded step becomes a save milestone; another reloads a random
 *   participant mid-session (a server-authoritative engine must restore the
 *   live document). The run ends with save + reload + REST round-trip.
 * - Before some steps the next sync request from the acting page is delayed
 *   or failed with a retryable status (429/500/503). Faults are HTTP-only:
 *   route interception cannot touch WebSocket frames, so the runner disables
 *   them on the websocket transport.
 *
 * The engine/transport are NOT set here — the matrix runner
 * (tests/fuzzer/run.mjs) configures the site before invoking this spec and
 * passes RTC_FUZZ_ENGINE / RTC_FUZZ_TRANSPORT so the spec can record them
 * and adapt (fault injection, discovery waits).
 */

/**
 * External dependencies
 */
import type { Locator, Page } from '@playwright/test';

/**
 * WordPress dependencies
 */
import type { Editor } from '@wordpress/e2e-test-utils-playwright';

/**
 * Internal dependencies
 */
import {
	test,
	expect,
} from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures';
import type CollaborationUtils from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';
import { SECOND_USER } from '../../../gutenberg/test/e2e/specs/editor/collaboration/fixtures/collaboration-utils';
import { waitForSyncQuiet } from '../../e2e/config/collaboration-fixtures';

type Random = () => number;

interface TraceEntry {
	detail?: Record< string, unknown >;
	label: string;
	step: number;
	userIndex: number;
}

interface ActionContext {
	editor: Editor;
	editors: Editor[];
	page: Page;
	pages: Page[];
	rng: Random;
	seed: number;
	step: number;
	userIndex: number;
}

const SEED_START = getEnvInt( 'RTC_FUZZ_SEED_START', 1 );

// RTC_FUZZ_CPU_THROTTLE=<rate> slows every editor page through Chrome's
// devtools CPU emulation, mirroring the e2e fixtures' RTC_E2E_CPU_THROTTLE
// knob (issue #37): busy-machine races reproduce on an idle machine. Off
// unless set.
const CPU_THROTTLE = getEnvInt( 'RTC_FUZZ_CPU_THROTTLE', 0 );
async function maybeThrottlePage( page: Page ): Promise< void > {
	if ( CPU_THROTTLE <= 1 ) {
		return;
	}
	const session = await page.context().newCDPSession( page );
	await session.send( 'Emulation.setCPUThrottlingRate', {
		rate: CPU_THROTTLE,
	} );
}
const SEED_COUNT = getEnvInt( 'RTC_FUZZ_SEED_COUNT', 3 );
const SEEDS = getEnvIntList( 'RTC_FUZZ_SEEDS' );
const STEP_COUNT = getEnvInt( 'RTC_FUZZ_STEPS', 12 );
const USER_COUNT = Math.max( 2, getEnvInt( 'RTC_FUZZ_USERS', 2 ) );
const ENGINE = process.env.RTC_FUZZ_ENGINE || 'unknown';
const TRANSPORT = process.env.RTC_FUZZ_TRANSPORT || 'unknown';
const CONVERGENCE_TIMEOUT_MS = getEnvInt(
	'RTC_FUZZ_CONVERGENCE_TIMEOUT_MS',
	20000
);
const DISCOVERY_TIMEOUT_MS = getEnvInt(
	'RTC_FUZZ_DISCOVERY_TIMEOUT_MS',
	30000
);
const DISABLE_SYNC_FAULTS =
	process.env.RTC_FUZZ_DISABLE_SYNC_FAULTS === '1' ||
	TRANSPORT === 'websocket';
const DISABLE_RELOAD = process.env.RTC_FUZZ_DISABLE_RELOAD === '1';
// Engines with a documented no-title-sync gap (the runner sets this from
// its capability map) skip title actions; untouched titles stay converged,
// so the oracle needs no change.
const SYNC_TITLE = process.env.RTC_FUZZ_SYNC_TITLE !== '0';
const TEST_TIMEOUT_MS = getEnvInt(
	'RTC_FUZZ_TEST_TIMEOUT_MS',
	120000 + STEP_COUNT * 15000
);
const RETRIABLE_SYNC_FAILURE_STATUSES = [ 429, 500, 503 ];
// Probability that a step is preceded by a sync fault (60% of faults are
// delays, the rest retryable failures).
const FAULT_RATE = ( () => {
	const raw = Number.parseFloat( process.env.RTC_FUZZ_FAULT_RATE || '0.25' );
	return Number.isFinite( raw ) ? Math.min( Math.max( raw, 0 ), 1 ) : 0.25;
} )();
// Leave/re-join lifecycle milestones (a non-primary collaborator closes
// their tab mid-session and later rejoins with the same account).
const DISABLE_LIFECYCLE = process.env.RTC_FUZZ_DISABLE_LIFECYCLE === '1';
// Probability that a step becomes a BURST: several actions from distinct
// actors fired concurrently with NO convergence wait in between — the
// timing pressure a single-action-then-converge loop never produces.
// RTC_FUZZ_LOG_SYNC=1 records every sync request/response summary per page
// into the fuzz-run.json attachment (wire-level triage without a debugger).
const LOG_SYNC = process.env.RTC_FUZZ_LOG_SYNC === '1';
const BURST_RATE = ( () => {
	const raw = Number.parseFloat( process.env.RTC_FUZZ_BURST_RATE || '0.2' );
	return Number.isFinite( raw ) ? Math.min( Math.max( raw, 0 ), 1 ) : 0.2;
} )();
// Action-weighting profile: 'undo' emphasizes undo/redo (including undo
// pressed inside the unsettled window), 'concurrency' emphasizes
// same-block concurrent edits and typing. Changing the profile changes
// what a seed replays as — replay with the same profile.
const PROFILE = process.env.RTC_FUZZ_PROFILE || 'default';

const THIRD_USER = {
	username: 'fuzz-collaborator-3',
	email: 'fuzz-collaborator-3@example.com',
	firstName: 'Fuzz',
	lastName: 'Third',
	password: 'password',
	roles: [ 'editor' ],
};

function getEnvInt( name: string, fallback: number ): number {
	const raw = process.env[ name ];
	if ( ! raw ) {
		return fallback;
	}
	const value = Number.parseInt( raw, 10 );
	return Number.isFinite( value ) ? value : fallback;
}

function getEnvIntList( name: string ): number[] | null {
	const raw = process.env[ name ];
	if ( ! raw ) {
		return null;
	}
	const values = raw
		.split( ',' )
		.map( ( token ) => Number.parseInt( token.trim(), 10 ) )
		.filter( ( value ) => Number.isFinite( value ) );
	return values.length ? values : null;
}

/**
 * mulberry32: small deterministic PRNG so a seed replays the exact run.
 *
 * @param seed Seed integer.
 */
function createRng( seed: number ): Random {
	/* eslint-disable no-bitwise -- mulberry32 is inherently bitwise. */
	let state = seed >>> 0;
	return () => {
		state = ( state + 0x6d2b79f5 ) | 0;
		let t = Math.imul( state ^ ( state >>> 15 ), 1 | state );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
	/* eslint-enable no-bitwise */
}

function pick< T >( rng: Random, values: T[] ): T {
	return values[ Math.floor( rng() * values.length ) ];
}

function pickIndex( rng: Random, length: number ): number {
	return Math.floor( rng() * length );
}

/**
 * Deterministic content marker: unique per seed/step/user so convergence
 * mismatches identify the exact action that produced the text.
 *
 * @param seed  Run seed.
 * @param step  Step index.
 * @param user  Acting user index.
 * @param label Short action tag.
 */
function marker(
	seed: number,
	step: number,
	user: number,
	label: string
): string {
	return `f${ seed }s${ step }u${ user }-${ label }`;
}

const MULTIBYTE_SUFFIXES = [ ' é–ü', ' 日本語', ' 😀🎉', ' Ωмega' ];

const PARAGRAPH = ( content: string ) =>
	`<!-- wp:paragraph -->\n<p>${ content }</p>\n<!-- /wp:paragraph -->`;

/**
 * The seeded initial-content templates. Mirrors the upstream fuzzer's
 * profiles: plain, empty (concurrent genesis), multibyte, nested structures,
 * and a long shared paragraph for same-block concurrent edits.
 *
 * @param seed Run seed.
 */
function getInitialContent( seed: number ): string {
	const templates = [
		[
			PARAGRAPH( 'Alpha paragraph' ),
			PARAGRAPH( 'Beta paragraph' ),
			PARAGRAPH( 'Gamma paragraph' ),
		].join( '\n\n' ),
		'',
		[
			PARAGRAPH( 'Multibyte é–ü seed 日本語' ),
			PARAGRAPH( 'Emoji 😀🎉 paragraph' ),
		].join( '\n\n' ),
		[
			'<!-- wp:group {"layout":{"type":"constrained"}} -->',
			'<div class="wp-block-group">',
			PARAGRAPH( 'Nested opener' ),
			'<!-- wp:list -->',
			'<ul class="wp-block-list"><!-- wp:list-item -->',
			'<li>Nested list item</li>',
			'<!-- /wp:list-item --></ul>',
			'<!-- /wp:list -->',
			'</div>',
			'<!-- /wp:group -->',
			PARAGRAPH( 'Sibling paragraph' ),
		].join( '\n' ),
		PARAGRAPH(
			'Shared long paragraph where both collaborators will type ' +
				'concurrently and the merged sentence must keep every token.'
		),
	];
	return templates[ seed % templates.length ];
}

/**
 * Actions that add at least one block when they don't report `skipped`.
 * Once one has run, a zero-block converged state means content was lost —
 * until a delete makes an empty document legitimate again.
 */
const BLOCK_INSERTING_ACTIONS = new Set( [
	'insert-paragraph',
	'append-paragraph',
	'insert-heading',
	'insert-list',
	'insert-quote',
	'insert-nested-group',
	'insert-into-group',
	'deep-nest-group',
	'concurrent-append',
	// The peer's insert survives the other user's undo (undo pops the
	// undoer's OWN unit), so the document is non-empty afterwards.
	'concurrent-edit-and-undo',
] );

/**
 * Actions that can remove blocks via history: an undo can revert an
 * insert, so a zero-block document afterwards is legitimate.
 */
const HISTORY_ACTIONS = new Set( [
	'undo',
	'redo',
	'type-then-undo-quick',
	'edit-then-undo-settled',
] );

interface FlatBlock {
	clientId: string;
	content: string;
	name: string;
	rootClientId: string;
}

/**
 * Flattened block list (clientId, name, rootClientId) for target selection.
 *
 * @param page Page to inspect.
 */
async function getFlatBlocks( page: Page ): Promise< FlatBlock[] > {
	return page.evaluate( () => {
		const flat: FlatBlock[] = [];
		const walk = ( blocks: any[], rootClientId: string ) => {
			for ( const block of blocks ) {
				flat.push( {
					clientId: block.clientId,
					content: String( block.attributes?.content ?? '' ),
					name: block.name,
					rootClientId,
				} );
				walk( block.innerBlocks ?? [], block.clientId );
			}
		};
		walk(
			( window as any ).wp.data.select( 'core/block-editor' ).getBlocks(),
			''
		);
		return flat;
	} );
}

async function getTopLevelCount( page: Page ): Promise< number > {
	return page.evaluate(
		() =>
			( window as any ).wp.data.select( 'core/block-editor' ).getBlocks()
				.length
	);
}

interface BlockSpec {
	attributes?: Record< string, unknown >;
	inner?: BlockSpec[];
	name: string;
}

/**
 * Insert a block via the store. `spec` is a serializable block description
 * ({ name, attributes, inner: [...] }); index -1 appends.
 *
 * @param page         Acting page.
 * @param spec         Serializable block description.
 * @param index        Top-level insertion index; -1 appends.
 * @param rootClientId
 */
async function insertBlockAt(
	page: Page,
	spec: BlockSpec,
	index: number,
	rootClientId = ''
): Promise< void > {
	await page.evaluate(
		( { blockSpec, insertIndex, root } ) => {
			const { createBlock } = ( window as any ).wp.blocks;
			const build = ( node: any ): any =>
				createBlock(
					node.name,
					node.attributes ?? {},
					( node.inner ?? [] ).map( build )
				);
			const { dispatch, select } = ( window as any ).wp.data;
			const count =
				select( 'core/block-editor' ).getBlocks( root ).length;
			dispatch( 'core/block-editor' ).insertBlock(
				build( blockSpec ),
				insertIndex < 0 || insertIndex > count ? count : insertIndex,
				root,
				false
			);
		},
		{ blockSpec: spec, insertIndex: index, root: rootClientId }
	);
}

async function updateBlockContent(
	page: Page,
	clientId: string,
	content: string
): Promise< void > {
	await page.evaluate(
		( args ) => {
			( window as any ).wp.data
				.dispatch( 'core/block-editor' )
				.updateBlockAttributes( args.clientId, {
					content: args.content,
				} );
		},
		{ clientId, content }
	);
}

/**
 * Dispatch editor undo/redo — the same store action the toolbar button and
 * the keyboard shortcut dispatch, which core-data routes to the active
 * engine's collaborative undo manager (SyncManager.undoManager).
 *
 * @param page Acting page.
 * @param kind 'undo' or 'redo'.
 */
async function dispatchHistory(
	page: Page,
	kind: 'undo' | 'redo'
): Promise< void > {
	await page.evaluate( ( action ) => {
		( window as any ).wp.data.dispatch( 'core/editor' )[ action ]();
	}, kind );
}

/**
 * The collaborative undo stack state as the editor sees it.
 *
 * @param page Page to read.
 */
async function getHistoryState(
	page: Page
): Promise< { hasUndo: boolean; hasRedo: boolean } > {
	return page.evaluate( () => {
		const coreSelect = ( window as any ).wp.data.select( 'core' );
		return {
			hasUndo: Boolean( coreSelect.hasUndo() ),
			hasRedo: Boolean( coreSelect.hasRedo() ),
		};
	} );
}

/**
 * Append a marker to the Nth paragraph (flattened order) via the store.
 * Resolved per page: clientIds are editor-local, but converged trees list
 * paragraphs in the same order, so the index names "the same" block on
 * every page.
 *
 * @param page Acting page.
 * @param nth  Flattened paragraph index (clamped to the last paragraph).
 * @param mark Marker to append.
 */
async function appendToNthParagraph(
	page: Page,
	nth: number,
	mark: string
): Promise< boolean > {
	return page.evaluate(
		( args ) => {
			const { dispatch, select } = ( window as any ).wp.data;
			const flat: any[] = [];
			const walk = ( blocks: any[] ) => {
				for ( const block of blocks ) {
					if ( 'core/paragraph' === block.name ) {
						flat.push( block );
					}
					walk( block.innerBlocks ?? [] );
				}
			};
			walk( select( 'core/block-editor' ).getBlocks() );
			if ( ! flat.length ) {
				return false;
			}
			const target = flat[ Math.min( args.nth, flat.length - 1 ) ];
			dispatch( 'core/block-editor' ).updateBlockAttributes(
				target.clientId,
				{
					content: `${ String( target.attributes?.content ?? '' ) } ${
						args.mark
					}`,
				}
			);
			return true;
		},
		{ mark, nth }
	);
}

/**
 * The engines' review cards: the pending-edit card on a block whose edit
 * was set aside, and the approval card for a proposed new block. Both are
 * popovers drawn over the canvas, so either can sit on top of the block
 * the next UI action wants to click (issue #109).
 */
const REVIEW_CARD_SELECTOR =
	'.editor-collaboration-pending-card, .editor-collaboration-insertion-card';

// How long a UI click may wait before the harness looks for a review card
// in its way. The full action timeout still applies to the click that
// follows.
const COVERED_CLICK_TIMEOUT_MS = 3000;

interface CardResolution {
	card: 'insertion' | 'pending';
	choice: 'adopt' | 'reject';
}

/**
 * A choice source for one UI action's review cards, derived from the seed,
 * step, and acting user. It is separate from the run's RNG on purpose: a
 * card appears only on some timings, and drawing from the shared RNG would
 * shift every later seeded choice whenever one does.
 *
 * @param seed      Run seed.
 * @param step      Step (opId) of the action.
 * @param userIndex Acting user index.
 */
function createCardRng( seed: number, step: number, userIndex: number ) {
	return createRng( seed * 1000003 + step * 101 + userIndex );
}

/**
 * The visible review cards whose box overlaps the target's box.
 *
 * @param page   Page that draws the cards.
 * @param target Element the action wants to click.
 */
async function findCoveringCards(
	page: Page,
	target: Locator
): Promise< Locator[] > {
	const box = await target.boundingBox();
	if ( ! box ) {
		return [];
	}
	const covering: Locator[] = [];
	const cards = page.locator( REVIEW_CARD_SELECTOR );
	for ( let i = 0; i < ( await cards.count() ); i++ ) {
		const card = cards.nth( i );
		const cardBox = await card.boundingBox();
		if (
			cardBox &&
			cardBox.x < box.x + box.width &&
			box.x < cardBox.x + cardBox.width &&
			cardBox.y < box.y + box.height &&
			box.y < cardBox.y + cardBox.height
		) {
			covering.push( card );
		}
	}
	return covering;
}

/**
 * Make a seeded Adopt/Reject (Approve/Discard) choice on one review card
 * and wait for the card to go away. Adopt falls back to Reject when this
 * user may not adopt (the card shows a hint instead of the button).
 *
 * @param card The card to resolve.
 * @param rng  Choice source.
 */
async function resolveReviewCard(
	card: Locator,
	rng: Random
): Promise< CardResolution > {
	const handle = await card.elementHandle();
	const kind = ( await card.evaluate( ( element ) =>
		element.classList.contains( 'editor-collaboration-insertion-card' )
	) )
		? 'insertion'
		: 'pending';
	const [ adoptName, rejectName ] =
		kind === 'insertion' ? [ 'Approve', 'Discard' ] : [ 'Adopt', 'Reject' ];
	const adopt = card.getByRole( 'button', { exact: true, name: adoptName } );
	const choice =
		rng() < 0.5 && ( await adopt.count() ) > 0 ? 'adopt' : 'reject';
	await ( choice === 'adopt'
		? adopt
		: card.getByRole( 'button', { exact: true, name: rejectName } )
	).click();
	await handle?.waitForElementState( 'hidden', { timeout: 10000 } );
	return { card: kind, choice };
}

/**
 * Click a canvas element the way a person would: when an engine's review
 * card covers it, deal with the card first (a seeded Adopt or Reject) and
 * then click. The resolutions are returned so the action records them in
 * its trace detail. Anything else in the way fails the click as before.
 *
 * @param page   Page that owns the target.
 * @param target Element to click.
 * @param rng    Choice source for card resolutions.
 */
async function clickPastReviewCards(
	page: Page,
	target: Locator,
	rng: Random
): Promise< CardResolution[] > {
	const resolutions: CardResolution[] = [];
	for ( let attempt = 0; attempt < 3; attempt++ ) {
		try {
			await target.click( { timeout: COVERED_CLICK_TIMEOUT_MS } );
			return resolutions;
		} catch {
			const covering = await findCoveringCards( page, target );
			if ( ! covering.length ) {
				break;
			}
			for ( const card of covering ) {
				resolutions.push( await resolveReviewCard( card, rng ) );
			}
		}
	}
	await target.click();
	return resolutions;
}

/**
 * Click into the Nth paragraph and type at its end — real keystrokes, so
 * the engine's capture path (not the store-update path) is exercised.
 *
 * @param editor Editor handle for the acting page.
 * @param page   Acting page.
 * @param nth    Paragraph index (clamped).
 * @param text   Text to type.
 * @param rng    Choice source for review cards in the way.
 * @return The review cards resolved on the way, or null when there is no
 *         paragraph to type into.
 */
async function typeIntoNthParagraph(
	editor: Editor,
	page: Page,
	nth: number,
	text: string,
	rng: Random
): Promise< CardResolution[] | null > {
	const paragraphs = editor.canvas.locator( '[data-type="core/paragraph"]' );
	const count = await paragraphs.count();
	if ( ! count ) {
		return null;
	}
	const target = paragraphs.nth( Math.min( nth, count - 1 ) );
	const cards = await clickPastReviewCards( page, target, rng );
	await page.keyboard.press( 'End' );
	await page.keyboard.type( text );
	return cards;
}

/**
 * Arm a one-shot fault on the acting page's next sync request. Matches both
 * pretty and plain-permalink sync routes (wp-env uses
 * `?rest_route=%2Fwp-sync%2F...`). HTTP transports only.
 *
 * @param page          Acting page.
 * @param fault         The fault to inject.
 * @param fault.delayMs Delay in ms (delay fault).
 * @param fault.status  HTTP status to fail with (failure fault).
 */
async function armSyncFault(
	page: Page,
	fault: { delayMs?: number; status?: number }
): Promise< void > {
	let armed = true;
	const matcher = ( url: URL ) =>
		url.href.includes( 'wp-sync' ) ||
		decodeURIComponent( url.search ).includes( '/wp-sync/' );
	await page.route( matcher, async ( route ) => {
		if ( ! armed ) {
			await route.fallback();
			return;
		}
		armed = false;
		if ( fault.status ) {
			await route.fulfill( {
				body: JSON.stringify( {
					code: 'rtc_fuzz_injected_fault',
					message: 'Injected transient sync failure.',
				} ),
				contentType: 'application/json',
				status: fault.status,
			} );
		} else {
			await new Promise( ( resolve ) =>
				setTimeout( resolve, fault.delayMs ?? 500 )
			);
			await route.fallback();
		}
		await page.unroute( matcher ).catch( () => undefined );
	} );
}

/**
 * No block anywhere in the tree may be an invalid-content recovery block —
 * the classic engine-genesis failure mode (a server genesis that forgets
 * isValid renders every block as recovery UI).
 *
 * @param page  Page to inspect.
 * @param label Context for the failure message.
 */
async function assertNoInvalidBlocks( page: Page, label: string ) {
	const invalid = await page.evaluate( () => {
		const bad: Array< { name: string; original: string } > = [];
		const walk = ( blocks: any[] ) => {
			for ( const block of blocks ) {
				if ( block.isValid === false ) {
					bad.push( {
						name: block.name,
						original: String(
							block.originalContent ??
								block.attributes?.originalContent ??
								''
						).slice( 0, 400 ),
					} );
				}
				walk( block.innerBlocks ?? [] );
			}
		};
		walk(
			( window as any ).wp.data.select( 'core/block-editor' ).getBlocks()
		);
		return bad;
	} );
	expect(
		invalid,
		`invalid-content recovery blocks after ${ label }: ${ JSON.stringify(
			invalid
		) }`
	).toEqual( [] );
}

/**
 * The bounded action grammar. Each action receives an ActionContext and
 * returns the trace detail it wants recorded. Actions must leave the
 * document with at least one block.
 */
const ACTIONS: Array< {
	label: string;
	run: ( ctx: ActionContext ) => Promise< Record< string, unknown > | void >;
} > = [
	{
		label: 'insert-paragraph',
		run: async ( { page, seed, step, userIndex, rng } ) => {
			const count = await getTopLevelCount( page );
			const index = pickIndex( rng, count + 1 );
			const text =
				marker( seed, step, userIndex, 'ins' ) +
				( rng() < 0.3 ? pick( rng, MULTIBYTE_SUFFIXES ) : '' );
			await insertBlockAt(
				page,
				{ attributes: { content: text }, name: 'core/paragraph' },
				index
			);
			return { index, text };
		},
	},
	{
		label: 'append-paragraph',
		run: async ( { page, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'app' );
			await insertBlockAt(
				page,
				{ attributes: { content: text }, name: 'core/paragraph' },
				-1
			);
			return { text };
		},
	},
	{
		label: 'edit-paragraph',
		run: async ( { page, seed, step, userIndex, rng } ) => {
			const paragraphs = ( await getFlatBlocks( page ) ).filter(
				( block ) => block.name === 'core/paragraph'
			);
			if ( ! paragraphs.length ) {
				return { skipped: 'no paragraphs' };
			}
			const target = pick( rng, paragraphs );
			const text = `${ target.content } ${ marker(
				seed,
				step,
				userIndex,
				'edit'
			) }`;
			await updateBlockContent( page, target.clientId, text );
			return { clientId: target.clientId, text };
		},
	},
	{
		label: 'edit-title',
		run: async ( { page, seed, step, userIndex } ) => {
			const title = marker( seed, step, userIndex, 'title' );
			await page.evaluate( ( value ) => {
				( window as any ).wp.data
					.dispatch( 'core/editor' )
					.editPost( { title: value } );
			}, title );
			return { title };
		},
	},
	{
		label: 'insert-heading',
		run: async ( { page, seed, step, userIndex, rng } ) => {
			const level = pick( rng, [ 2, 3, 4 ] );
			const text = marker( seed, step, userIndex, 'head' );
			await insertBlockAt(
				page,
				{
					attributes: { content: text, level },
					name: 'core/heading',
				},
				-1
			);
			return { level, text };
		},
	},
	{
		label: 'insert-list',
		run: async ( { page, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'list' );
			await insertBlockAt(
				page,
				{
					inner: [
						{
							attributes: { content: text },
							name: 'core/list-item',
						},
					],
					name: 'core/list',
				},
				-1
			);
			return { text };
		},
	},
	{
		label: 'insert-quote',
		run: async ( { page, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'quote' );
			await insertBlockAt(
				page,
				{
					inner: [
						{
							attributes: { content: text },
							name: 'core/paragraph',
						},
					],
					name: 'core/quote',
				},
				-1
			);
			return { text };
		},
	},
	{
		label: 'insert-nested-group',
		run: async ( { page, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'group' );
			await insertBlockAt(
				page,
				{
					inner: [
						{
							attributes: { content: text },
							name: 'core/paragraph',
						},
						{
							inner: [
								{
									attributes: {
										content: `${ text }-inner`,
									},
									name: 'core/paragraph',
								},
							],
							name: 'core/group',
						},
					],
					name: 'core/group',
				},
				-1
			);
			return { text };
		},
	},
	{
		label: 'delete-block',
		run: async ( { page, rng } ) => {
			const count = await getTopLevelCount( page );
			if ( count < 2 ) {
				return { skipped: 'single block' };
			}
			const index = pickIndex( rng, count );
			await page.evaluate( ( blockIndex ) => {
				const { dispatch, select } = ( window as any ).wp.data;
				const block =
					select( 'core/block-editor' ).getBlocks()[ blockIndex ];
				if ( block ) {
					dispatch( 'core/block-editor' ).removeBlock(
						block.clientId,
						false
					);
				}
			}, index );
			return { index };
		},
	},
	{
		label: 'move-block',
		run: async ( { page, rng } ) => {
			const count = await getTopLevelCount( page );
			if ( count < 2 ) {
				return { skipped: 'single block' };
			}
			const index = pickIndex( rng, count );
			const direction = rng() < 0.5 ? 'up' : 'down';
			await page.evaluate(
				( args ) => {
					const { dispatch, select } = ( window as any ).wp.data;
					const blocks = select( 'core/block-editor' ).getBlocks();
					const block = blocks[ args.index ];
					if ( ! block ) {
						return;
					}
					if ( args.direction === 'up' ) {
						dispatch( 'core/block-editor' ).moveBlocksUp(
							[ block.clientId ],
							''
						);
					} else {
						dispatch( 'core/block-editor' ).moveBlocksDown(
							[ block.clientId ],
							''
						);
					}
				},
				{ direction, index }
			);
			return { direction, index };
		},
	},
	{
		label: 'ui-type-paragraph',
		run: async ( { page, editor, seed, step, userIndex } ) => {
			const text = ` ${ marker( seed, step, userIndex, 'type' ) }`;
			const target = editor.canvas
				.locator( '[data-type="core/paragraph"]' )
				.last();
			if ( ( await target.count() ) === 0 ) {
				return { skipped: 'no paragraph to type into' };
			}
			const cards = await clickPastReviewCards(
				page,
				target,
				createCardRng( seed, step, userIndex )
			);
			await page.keyboard.press( 'End' );
			await page.keyboard.type( text );
			return cards.length ? { cards, text } : { text };
		},
	},
	{
		label: 'ui-type-title',
		run: async ( { page, editor, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'uititle' );
			const title = editor.canvas.getByRole( 'textbox', {
				name: 'Add title',
			} );
			const cards = await clickPastReviewCards(
				page,
				title,
				createCardRng( seed, step, userIndex )
			);
			await page.keyboard.press( 'ControlOrMeta+a' );
			await page.keyboard.type( text );
			return cards.length ? { cards, text } : { text };
		},
	},
	{
		label: 'insert-into-group',
		run: async ( { page, seed, step, userIndex, rng } ) => {
			const groups = ( await getFlatBlocks( page ) ).filter(
				( block ) => block.name === 'core/group'
			);
			if ( ! groups.length ) {
				return { skipped: 'no groups' };
			}
			const target = pick( rng, groups );
			const text = marker( seed, step, userIndex, 'ingrp' );
			await insertBlockAt(
				page,
				{ attributes: { content: text }, name: 'core/paragraph' },
				0,
				target.clientId
			);
			return { group: target.clientId, text };
		},
	},
	{
		label: 'move-into-group',
		run: async ( { page, rng } ) => {
			const moved = await page.evaluate( ( random ) => {
				const { dispatch, select } = ( window as any ).wp.data;
				const top = select( 'core/block-editor' ).getBlocks();
				const groups = top.filter(
					( block: any ) => 'core/group' === block.name
				);
				const movable = top.filter(
					( block: any ) => 'core/group' !== block.name
				);
				if ( ! groups.length || movable.length < 2 ) {
					return null;
				}
				const source = movable[ Math.floor( random * movable.length ) ];
				const group = groups[ 0 ];
				dispatch( 'core/block-editor' ).moveBlocksToPosition(
					[ source.clientId ],
					'',
					group.clientId,
					0
				);
				return { group: group.clientId, source: source.clientId };
			}, rng() );
			return moved ?? { skipped: 'no group/movable pair' };
		},
	},
	{
		label: 'deep-nest-group',
		run: async ( { page, seed, step, userIndex } ) => {
			const text = marker( seed, step, userIndex, 'deep' );
			await insertBlockAt(
				page,
				{
					inner: [
						{
							attributes: { content: `${ text }-1` },
							name: 'core/paragraph',
						},
						{
							inner: [
								{
									attributes: { content: `${ text }-2` },
									name: 'core/paragraph',
								},
								{
									inner: [
										{
											attributes: {
												content: `${ text }-3`,
											},
											name: 'core/paragraph',
										},
									],
									name: 'core/group',
								},
							],
							name: 'core/group',
						},
					],
					name: 'core/group',
				},
				-1
			);
			return { text };
		},
	},
	{
		label: 'concurrent-append',
		run: async ( { pages, seed, step, rng } ) => {
			if ( pages.length < 2 ) {
				// Solo (a collaborator left): nothing to be concurrent with.
				return { skipped: 'single participant' };
			}
			const secondIndex = pages.length > 2 && rng() < 0.5 ? 2 : 1;
			const texts = [
				marker( seed, step, 0, 'conc' ),
				marker( seed, step, secondIndex, 'conc' ),
			];
			await Promise.all( [
				insertBlockAt(
					pages[ 0 ],
					{
						attributes: { content: texts[ 0 ] },
						name: 'core/paragraph',
					},
					-1
				),
				insertBlockAt(
					pages[ secondIndex ],
					{
						attributes: { content: texts[ 1 ] },
						name: 'core/paragraph',
					},
					-1
				),
			] );
			return { secondIndex, texts };
		},
	},
	{
		label: 'undo',
		run: async ( { page } ) => {
			const before = await getHistoryState( page );
			await dispatchHistory( page, 'undo' );
			return { before };
		},
	},
	{
		label: 'redo',
		run: async ( { page } ) => {
			const before = await getHistoryState( page );
			await dispatchHistory( page, 'redo' );
			return { before };
		},
	},
	{
		label: 'type-then-undo-quick',
		run: async ( { page, editor, seed, step, userIndex, rng } ) => {
			// Undo INSIDE the unsettled window: intent-log units only become
			// undoable after the capture delay + ack round trip, so an undo
			// this early races unit settling — exactly where "undo did
			// something unexpected" reports live.
			const text = ` ${ marker( seed, step, userIndex, 'tuq' ) }`;
			const cards = await typeIntoNthParagraph(
				editor,
				page,
				Number.MAX_SAFE_INTEGER,
				text,
				createCardRng( seed, step, userIndex )
			);
			if ( ! cards ) {
				return { skipped: 'no paragraph to type into' };
			}
			const delayMs = Math.floor( rng() * 900 );
			await page.waitForTimeout( delayMs );
			const before = await getHistoryState( page );
			await dispatchHistory( page, 'undo' );
			return cards.length
				? { before, cards, delayMs, text }
				: { before, delayMs, text };
		},
	},
	{
		label: 'edit-then-undo-settled',
		run: async ( { page, seed, step, userIndex, rng } ) => {
			// The deterministic undo exercise: edit, wait for the unit to
			// become undoable (settled), then undo it.
			const paragraphs = ( await getFlatBlocks( page ) ).filter(
				( block ) => block.name === 'core/paragraph'
			);
			if ( ! paragraphs.length ) {
				return { skipped: 'no paragraphs' };
			}
			const nth = pickIndex( rng, paragraphs.length );
			const text = marker( seed, step, userIndex, 'eus' );
			await appendToNthParagraph( page, nth, text );
			const settled = await page
				.waitForFunction(
					() => ( window as any ).wp.data.select( 'core' ).hasUndo(),
					undefined,
					{ timeout: 15000 }
				)
				.then( () => true )
				.catch( () => false );
			await dispatchHistory( page, 'undo' );
			return { nth, settled, text };
		},
	},
	{
		label: 'concurrent-same-block-edit',
		run: async ( { pages, seed, step, rng } ) => {
			if ( pages.length < 2 ) {
				return { skipped: 'single participant' };
			}
			const paragraphs = ( await getFlatBlocks( pages[ 0 ] ) ).filter(
				( block ) => block.name === 'core/paragraph'
			);
			if ( ! paragraphs.length ) {
				return { skipped: 'no paragraphs' };
			}
			const nth = pickIndex( rng, paragraphs.length );
			const secondIndex = pages.length > 2 && rng() < 0.5 ? 2 : 1;
			const texts = [
				marker( seed, step, 0, 'csb' ),
				marker( seed, step, secondIndex, 'csb' ),
			];
			await Promise.all( [
				appendToNthParagraph( pages[ 0 ], nth, texts[ 0 ] ),
				appendToNthParagraph( pages[ secondIndex ], nth, texts[ 1 ] ),
			] );
			return { nth, secondIndex, texts };
		},
	},
	{
		label: 'concurrent-type-same-paragraph',
		run: async ( { editors, pages, seed, step, rng } ) => {
			if ( pages.length < 2 ) {
				return { skipped: 'single participant' };
			}
			// Both users place their caret at the end of the SAME paragraph
			// and type simultaneously — the tightest same-frame timing the
			// browser can produce, and the documented intent-log
			// frame-conflict escalation zone.
			const paragraphs = ( await getFlatBlocks( pages[ 0 ] ) ).filter(
				( block ) => block.name === 'core/paragraph'
			);
			if ( ! paragraphs.length ) {
				return { skipped: 'no paragraphs' };
			}
			const nth = pickIndex( rng, paragraphs.length );
			const secondIndex = pages.length > 2 && rng() < 0.5 ? 2 : 1;
			const texts = [
				marker( seed, step, 0, 'ctp' ),
				marker( seed, step, secondIndex, 'ctp' ),
			];
			const [ firstCards, secondCards ] = await Promise.all( [
				typeIntoNthParagraph(
					editors[ 0 ],
					pages[ 0 ],
					nth,
					` ${ texts[ 0 ] }`,
					createCardRng( seed, step, 0 )
				),
				typeIntoNthParagraph(
					editors[ secondIndex ],
					pages[ secondIndex ],
					nth,
					` ${ texts[ 1 ] }`,
					createCardRng( seed, step, secondIndex )
				),
			] );
			const cards = [
				...( firstCards ?? [] ).map( ( card ) => ( {
					...card,
					userIndex: 0,
				} ) ),
				...( secondCards ?? [] ).map( ( card ) => ( {
					...card,
					userIndex: secondIndex,
				} ) ),
			];
			return cards.length
				? { cards, nth, secondIndex, texts }
				: { nth, secondIndex, texts };
		},
	},
	{
		label: 'concurrent-edit-and-undo',
		run: async ( { pages, seed, step, rng } ) => {
			if ( pages.length < 2 ) {
				return { skipped: 'single participant' };
			}
			// One user undoes while a peer lands a concurrent edit: the
			// inverse must transform over the peer's rows.
			const secondIndex = pages.length > 2 && rng() < 0.5 ? 2 : 1;
			const before = await getHistoryState( pages[ 0 ] );
			const text = marker( seed, step, secondIndex, 'cua' );
			await Promise.all( [
				dispatchHistory( pages[ 0 ], 'undo' ),
				insertBlockAt(
					pages[ secondIndex ],
					{
						attributes: { content: text },
						name: 'core/paragraph',
					},
					-1
				),
			] );
			return { before, secondIndex, text };
		},
	},
];

const TITLE_ACTION_LABELS = new Set( [ 'edit-title', 'ui-type-title' ] );

/*
 * Profile weighting: an action listed N times is picked N× as often. The
 * default profile keeps the uniform grammar; targeted campaigns tilt the
 * distribution toward the behavior under test without losing the rest of
 * the grammar (background edits are what make undo/concurrency hard).
 */
const PROFILE_WEIGHTS: Record< string, Record< string, number > > = {
	concurrency: {
		'concurrent-append': 3,
		'concurrent-edit-and-undo': 2,
		'concurrent-same-block-edit': 4,
		'concurrent-type-same-paragraph': 4,
		'edit-paragraph': 2,
		'ui-type-paragraph': 2,
	},
	undo: {
		'concurrent-edit-and-undo': 3,
		'edit-paragraph': 2,
		'edit-then-undo-settled': 4,
		redo: 3,
		'type-then-undo-quick': 4,
		'ui-type-paragraph': 2,
		undo: 3,
	},
};

const ACTIVE_ACTIONS = (
	SYNC_TITLE
		? ACTIONS
		: ACTIONS.filter(
				( action ) => ! TITLE_ACTION_LABELS.has( action.label )
		  )
).flatMap( ( action ) =>
	Array( PROFILE_WEIGHTS[ PROFILE ]?.[ action.label ] ?? 1 ).fill( action )
);

/**
 * Reserve a distinct milestone step (save, reload, late join) so two
 * milestones never land on the same step.
 *
 * @param rng       Seeded RNG.
 * @param stepCount Total steps.
 * @param used      Already-reserved steps.
 */
function chooseMilestoneStep(
	rng: Random,
	stepCount: number,
	used: Set< number >
): number {
	if ( used.size >= stepCount ) {
		return -1;
	}
	for (;;) {
		const step = pickIndex( rng, stepCount );
		if ( ! used.has( step ) ) {
			used.add( step );
			return step;
		}
	}
}

interface ComparableState {
	blockCount: number;
	content: string;
	title: string;
}

/**
 * Every marker this run has authored is UNIQUE (seed/step/user/label), so a
 * marker appearing more than once in converged content is content
 * DUPLICATION — a bug class convergence checking cannot see (all pages
 * agree on the duplicated text): bad undo inverse derivation, a re-pushed
 * block, or a capture echo. The negative lookahead keeps a base marker
 * from matching its own suffixed variants (`-inner`, `-1`…).
 *
 * @param haystack Serialized content + title.
 * @param mark     Marker to count.
 */
function countMarkerOccurrences( haystack: string, mark: string ): number {
	const matches = haystack.match( new RegExp( `${ mark }(?![-\\w])`, 'g' ) );
	return matches ? matches.length : 0;
}

const MARKER_PATTERN = /f\d+s\d+u\d+-[a-z]+/g;

/**
 * The persistence-relevant view of a page's editor: the SERIALIZED block
 * content plus the title. Raw attribute objects are deliberately not
 * compared — engines legitimately differ in in-memory representation (e.g.
 * intent-log's snapshot materialization reifies empty rich-text fields as
 * explicit "" attributes that createBlock-authored trees omit) while
 * serializing to identical markup. Serialization is what saves, so it is
 * the equality that matters.
 *
 * @param page Page to read.
 */
async function getComparableState( page: Page ): Promise< ComparableState > {
	return page.evaluate( () => {
		const blocks = ( window as any ).wp.data
			.select( 'core/block-editor' )
			.getBlocks();
		return {
			blockCount: blocks.length,
			content: ( window as any ).wp.blocks.serialize( blocks ),
			title:
				( window as any ).wp.data
					.select( 'core/editor' )
					.getEditedPostAttribute( 'title' ) ?? '',
		};
	} );
}

/**
 * Waits until every page exposes the same serialized content + title.
 *
 * @param pages   Pages to compare.
 * @param timeout Budget in ms.
 */
async function waitForConvergence(
	pages: Page[],
	timeout: number
): Promise< ComparableState > {
	const deadline = Date.now() + timeout;
	let states: ComparableState[] = [];
	for (;;) {
		states = await Promise.all( pages.map( getComparableState ) );
		const first = JSON.stringify( states[ 0 ] );
		if ( states.every( ( state ) => JSON.stringify( state ) === first ) ) {
			return states[ 0 ];
		}
		if ( Date.now() >= deadline ) {
			throw new Error(
				`Serialized state did not converge within ${ timeout }ms: ${ JSON.stringify(
					states
				) }`
			);
		}
		await pages[ 0 ].waitForTimeout( 250 );
	}
}

/**
 * Wait for all participants to discover each other: the awareness-driven
 * Collaborators list shows on every page, and then (HTTP transports) each
 * page's sync traffic goes quiet for a beat. The subtree fixture's wait
 * for three FUTURE poll responses per page cannot be used: with the
 * advisory channel, tabs that have found each other poll only on demand
 * plus a slow safety timer, so those polls may never come — the plugin's
 * e2e fixtures replaced it for the same reason. waitForConvergence covers
 * document sync.
 *
 * @param pages All participant pages.
 */
async function waitForDiscovery( pages: Page[] ) {
	await Promise.all(
		pages.map( ( pg ) =>
			pg
				.getByRole( 'button', { name: /Collaborators list/ } )
				.waitFor( { timeout: DISCOVERY_TIMEOUT_MS } )
		)
	);
	if ( TRANSPORT === 'websocket' || TRANSPORT === 'sse' ) {
		// Sync rides WS frames, or one long-lived stream response per tab
		// that answers only when it ends.
		return;
	}
	await Promise.all( pages.map( ( pg ) => waitForSyncQuiet( pg ) ) );
}

/**
 * Save the post from a page via the store and wait for the save to settle.
 *
 * @param page Saving page.
 */
async function saveDraftFromPage( page: Page ) {
	await page.evaluate( () =>
		( window as any ).wp.data.dispatch( 'core/editor' ).savePost()
	);
	await page.waitForFunction(
		() => {
			const editorSelect = ( window as any ).wp.data.select(
				'core/editor'
			);
			return (
				! editorSelect.isSavingPost() &&
				! editorSelect.isAutosavingPost()
			);
		},
		undefined,
		{ timeout: 30000 }
	);
	const succeeded = await page.evaluate( () =>
		( window as any ).wp.data
			.select( 'core/editor' )
			.didPostSaveRequestSucceed()
	);
	expect( succeeded, 'save request must succeed' ).toBe( true );
}

/**
 * Reload a participant page and wait for the collaboration runtime and any
 * reconciliation save to settle.
 *
 * @param collaborationUtils Fixture utils.
 * @param page               Page to reload.
 */
async function reloadPage(
	collaborationUtils: CollaborationUtils,
	page: Page
) {
	await page.reload();
	await collaborationUtils.waitForCollaborationReady( page );
	await collaborationUtils.waitForEntityReadyAndSaveSettled( page );
}

test.describe( `Collaboration fuzz [${ ENGINE }/${ TRANSPORT }]`, () => {
	// NOT 'serial': a failing seed must not abort the rest of the sweep.
	test.describe.configure( { timeout: TEST_TIMEOUT_MS } );

	const seeds =
		SEEDS ??
		Array.from(
			{ length: SEED_COUNT },
			( _value, offset ) => SEED_START + offset
		);

	for ( const seed of seeds ) {
		test( `seed ${ seed }`, async ( {
			collaborationUtils,
			requestUtils,
		}, testInfo ) => {
			test.setTimeout( TEST_TIMEOUT_MS );

			const rng = createRng( seed );
			const trace: TraceEntry[] = [];
			// Every marker authored this run, harvested from trace details.
			// Markers are unique per authoring op, so >1 occurrence in
			// converged content is duplication (see countMarkerOccurrences).
			const seenMarkers = new Set< string >();
			const record = ( entry: TraceEntry ) => {
				trace.push( entry );
				if ( entry.detail ) {
					for ( const match of JSON.stringify( entry.detail ).match(
						MARKER_PATTERN
					) ?? [] ) {
						seenMarkers.add( match );
					}
				}
			};
			const assertNoDuplicatedMarkers = (
				state: ComparableState,
				label: string
			) => {
				const haystack = `${ state.content }\n${ state.title }`;
				const duplicated: Record< string, number > = {};
				for ( const mark of seenMarkers ) {
					const count = countMarkerOccurrences( haystack, mark );
					if ( count > 1 ) {
						duplicated[ mark ] = count;
					}
				}
				expect(
					duplicated,
					`markers duplicated in converged content after ${ label }`
				).toEqual( {} );
			};
			const consoleLog: Array< {
				page: number;
				t: number;
				kind: string;
				text: string;
			} > = [];
			const tapSyncWire = ( pg: Page, index: number ) => {
				if ( ! LOG_SYNC ) {
					return;
				}
				pg.on( 'request', ( request ) => {
					if (
						request.url().includes( 'wp-sync' ) &&
						request.method() === 'POST'
					) {
						const body = request.postData() || '';
						consoleLog.push( {
							kind: 'sync-req',
							page: index,
							t: Date.now(),
							text: `after=${
								body.match( /"after":(\d+)/ )?.[ 1 ] ?? '?'
							} updates~${
								( body.match( /"data"/g ) || [] ).length
							}`,
						} );
					}
				} );
				pg.on( 'response', ( response ) => {
					if (
						response.url().includes( 'wp-sync' ) &&
						response.request().method() === 'POST'
					) {
						response
							.text()
							.then( ( body ) =>
								consoleLog.push( {
									kind: 'sync-res',
									page: index,
									t: Date.now(),
									text: `status=${ response.status() } updates~${
										( body.match( /"data"/g ) || [] ).length
									} end=${
										body.match(
											/"end_cursor":(\d+)/
										)?.[ 1 ] ?? '?'
									} aw~${
										(
											body.match( /collaboratorInfo/g ) ||
											[]
										).length
									}`,
								} )
							)
							.catch( () => undefined );
					}
				} );
				pg.on( 'requestfailed', ( request ) => {
					if ( request.url().includes( 'wp-sync' ) ) {
						consoleLog.push( {
							kind: 'sync-reqfail',
							page: index,
							t: Date.now(),
							text: String( request.failure()?.errorText ),
						} );
					}
				} );
			};
			const tapConsole = ( pg: Page, index: number ) => {
				pg.on( 'console', ( message ) => {
					if ( [ 'error', 'warning' ].includes( message.type() ) ) {
						consoleLog.push( {
							kind: message.type(),
							page: index,
							t: Date.now(),
							text: message.text().slice( 0, 400 ),
						} );
					}
				} );
				pg.on( 'pageerror', ( error ) =>
					consoleLog.push( {
						kind: 'pageerror',
						page: index,
						t: Date.now(),
						text: String( error ).slice( 0, 400 ),
					} )
				);
			};

			try {
				const post = await requestUtils.createPost( {
					content: getInitialContent( seed ),
					date_gmt: new Date().toISOString(),
					status: 'draft',
					title: `RTC fuzz seed ${ seed }`,
				} );

				/*
				 * EXISTING-POST variant (~1/3 of seeds): before the
				 * collaborative session, the primary user opens the post
				 * ALONE, edits, saves, and navigates away. The room then
				 * already holds log history and saved content when the real
				 * session starts — the re-genesis path a brand-new post
				 * never exercises.
				 */
				const soloPhase = seed % 3 === 2;
				if ( soloPhase ) {
					const soloTexts = [
						marker( seed, 9000, 0, 'pre' ),
						marker( seed, 9001, 0, 'pre' ),
					];
					record( {
						detail: { texts: soloTexts },
						label: 'solo-phase',
						step: -1,
						userIndex: 0,
					} );
					await collaborationUtils.openPost( post.id );
					const soloPage = collaborationUtils.allPages[ 0 ];
					for ( const soloText of soloTexts ) {
						await insertBlockAt(
							soloPage,
							{
								attributes: { content: soloText },
								name: 'core/paragraph',
							},
							-1
						);
					}
					await saveDraftFromPage( soloPage );
					// Leaving the editor ends the solo session; the next
					// openPost starts a fresh one against the same room.
					await soloPage.goto( '/wp-admin/index.php' );
				}

				await collaborationUtils.openPost( post.id );
				const second = await collaborationUtils.joinUser(
					post.id,
					SECOND_USER
				);
				// Participants are managed HERE (not via the fixture's
				// allPages): a leave closes a context, and closed pages must
				// drop out of every wait.
				const participants: Array< { editor: Editor; page: Page } > = [
					{
						editor: collaborationUtils.allEditors[ 0 ],
						page: collaborationUtils.allPages[ 0 ],
					},
					{ editor: second.editor, page: second.page },
				];
				tapConsole( participants[ 0 ].page, 0 );
				tapConsole( participants[ 1 ].page, 1 );
				tapSyncWire( participants[ 0 ].page, 0 );
				tapSyncWire( participants[ 1 ].page, 1 );
				await maybeThrottlePage( participants[ 0 ].page );
				await maybeThrottlePage( participants[ 1 ].page );
				const activePages = () =>
					participants.map( ( entry ) => entry.page );
				await waitForDiscovery( activePages() );
				await waitForConvergence(
					activePages(),
					CONVERGENCE_TIMEOUT_MS
				);
				await assertNoInvalidBlocks(
					participants[ 0 ].page,
					'initial load'
				);

				const usedMilestones = new Set< number >();
				const saveStep = chooseMilestoneStep(
					rng,
					STEP_COUNT,
					usedMilestones
				);
				const reloadStep = DISABLE_RELOAD
					? -1
					: chooseMilestoneStep( rng, STEP_COUNT, usedMilestones );
				const lateJoinStep =
					USER_COUNT > 2
						? chooseMilestoneStep( rng, STEP_COUNT, usedMilestones )
						: -1;
				/*
				 * LEAVE/RE-JOIN lifecycle (~60% of seeds, when enabled): the
				 * second collaborator closes their tab at one seeded step and
				 * rejoins with the same account at a later one. Their unacked
				 * local edits may legitimately be lost with the tab; the
				 * remaining participants must stay converged throughout, and
				 * the rejoiner must both receive the current document and be
				 * able to contribute.
				 */
				let leaveStep = -1;
				let rejoinStep = -1;
				if ( ! DISABLE_LIFECYCLE && rng() < 0.6 && STEP_COUNT >= 4 ) {
					const first = chooseMilestoneStep(
						rng,
						STEP_COUNT,
						usedMilestones
					);
					const secondStep = chooseMilestoneStep(
						rng,
						STEP_COUNT,
						usedMilestones
					);
					if ( first >= 0 && secondStep >= 0 ) {
						leaveStep = Math.min( first, secondStep );
						rejoinStep = Math.max( first, secondStep );
					}
				}
				let departed = false;

				// A zero-block converged state is legitimate when the seed
				// starts from the empty-genesis template, or after deletes
				// (two pages can each pass delete-block's own single-block
				// guard and concurrently empty the document). Only treat
				// zero blocks as content LOSS while this is false.
				let documentMayBeEmpty = getInitialContent( seed ) === '';

				// Unique per action invocation, used as the marker step so a
				// burst repeating (step, actor, action) still mints distinct
				// markers. Starts above any loop step; solo-phase markers use
				// 9000+.
				let nextOpId = 100;

				const runSingleAction = async ( step: number ) => {
					const pages = activePages();
					const actorIndex = pickIndex( rng, pages.length );
					const actor = pages[ actorIndex ];
					const faultRoll = rng();

					if (
						! DISABLE_SYNC_FAULTS &&
						faultRoll < FAULT_RATE * 0.6
					) {
						const delayMs = 250 + Math.floor( rng() * 1250 );
						record( {
							detail: { delayMs },
							label: 'fault-delay',
							step,
							userIndex: actorIndex,
						} );
						await armSyncFault( actor, { delayMs } );
					} else if (
						! DISABLE_SYNC_FAULTS &&
						faultRoll < FAULT_RATE
					) {
						const status = pick(
							rng,
							RETRIABLE_SYNC_FAILURE_STATUSES
						);
						record( {
							detail: { status },
							label: 'fault-fail',
							step,
							userIndex: actorIndex,
						} );
						await armSyncFault( actor, { status } );
					}

					const action = pick( rng, ACTIVE_ACTIONS );
					const opId = nextOpId++;
					const detail =
						await test.step( `seed ${ seed } step ${ step } ${ action.label } user ${ actorIndex }`, async () =>
							( await action.run( {
								editor: participants[ actorIndex ].editor,
								editors: participants.map(
									( entry ) => entry.editor
								),
								page: actor,
								pages,
								rng,
								seed,
								// Markers mint from the unique opId; the trace
								// keeps the loop step.
								step: opId,
								userIndex: actorIndex,
							} ) ) ?? {} );
					record( {
						detail: {
							...( detail as Record< string, unknown > ),
							opId,
						},
						label: action.label,
						step,
						userIndex: actorIndex,
					} );
					if ( ! ( detail as { skipped?: string } ).skipped ) {
						if (
							action.label === 'delete-block' ||
							HISTORY_ACTIONS.has( action.label )
						) {
							documentMayBeEmpty = true;
						} else if (
							BLOCK_INSERTING_ACTIONS.has( action.label )
						) {
							documentMayBeEmpty = false;
						}
					}
				};

				for ( let step = 0; step < STEP_COUNT; step++ ) {
					if ( step === lateJoinStep ) {
						record( {
							detail: {
								text: marker(
									seed,
									step,
									participants.length,
									'late'
								),
							},
							label: 'late-join',
							step,
							userIndex: participants.length,
						} );
						await requestUtils.createUser( THIRD_USER );
						const third = await collaborationUtils.joinUser(
							post.id,
							THIRD_USER
						);
						participants.push( {
							editor: third.editor,
							page: third.page,
						} );
						tapConsole( third.page, participants.length - 1 );
						tapSyncWire( third.page, participants.length - 1 );
						await maybeThrottlePage( third.page );
						await waitForDiscovery( activePages() );
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
						// A late joiner must be able to contribute, not just
						// receive.
						await insertBlockAt(
							third.page,
							{
								attributes: {
									content: marker(
										seed,
										step,
										participants.length - 1,
										'late'
									),
								},
								name: 'core/paragraph',
							},
							-1
						);
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
					}

					if ( step === leaveStep && participants.length > 1 ) {
						record( { label: 'leave', step, userIndex: 1 } );
						const [ leaver ] = participants.splice( 1, 1 );
						await leaver.page.context().close();
						departed = true;
						// Remaining participants must still be converged.
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
					}

					if ( step === rejoinStep && departed ) {
						record( {
							detail: { text: marker( seed, step, 1, 'rejoin' ) },
							label: 'rejoin',
							step,
							userIndex: 1,
						} );
						const rejoined = await collaborationUtils.joinUser(
							post.id,
							SECOND_USER
						);
						participants.splice( 1, 0, {
							editor: rejoined.editor,
							page: rejoined.page,
						} );
						tapConsole( rejoined.page, 1 );
						tapSyncWire( rejoined.page, 1 );
						await maybeThrottlePage( rejoined.page );
						departed = false;
						await waitForDiscovery( activePages() );
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
						// The rejoiner must be able to contribute.
						await insertBlockAt(
							rejoined.page,
							{
								attributes: {
									content: marker( seed, step, 1, 'rejoin' ),
								},
								name: 'core/paragraph',
							},
							-1
						);
						documentMayBeEmpty = false;
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
						await assertNoInvalidBlocks(
							rejoined.page,
							'post-rejoin'
						);
					}

					const burstRoll = rng();
					if ( burstRoll < BURST_RATE && activePages().length > 1 ) {
						// BURST: several actions, no convergence in between.
						const burstSize = 2 + pickIndex( rng, 2 );
						record( {
							detail: { burstSize },
							label: 'burst',
							step,
							userIndex: -1,
						} );
						for ( let i = 0; i < burstSize; i++ ) {
							await runSingleAction( step );
						}
					} else {
						await runSingleAction( step );
					}

					const state = await waitForConvergence(
						activePages(),
						CONVERGENCE_TIMEOUT_MS
					);
					if ( ! documentMayBeEmpty ) {
						expect( state.blockCount ).toBeGreaterThan( 0 );
					}
					assertNoDuplicatedMarkers( state, `step ${ step }` );
					await assertNoInvalidBlocks(
						participants[ 0 ].page,
						`step ${ step }`
					);

					if ( step === saveStep ) {
						record( {
							label: 'save-milestone',
							step,
							userIndex: 0,
						} );
						await saveDraftFromPage( participants[ 0 ].page );
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
					}

					if ( step === reloadStep ) {
						const reloadIndex = pickIndex(
							rng,
							participants.length
						);
						record( {
							label: 'reload-milestone',
							step,
							userIndex: reloadIndex,
						} );
						await reloadPage(
							collaborationUtils,
							participants[ reloadIndex ].page
						);
						await waitForConvergence(
							activePages(),
							CONVERGENCE_TIMEOUT_MS
						);
						await assertNoInvalidBlocks(
							participants[ reloadIndex ].page,
							'post-reload'
						);
					}
				}

				// Final persistence round-trip: save from one page, reload
				// another, and require full convergence — a
				// server-authoritative engine must rebuild the same document
				// for a fresh session.
				record( {
					label: 'final-save',
					step: STEP_COUNT,
					userIndex: 0,
				} );
				await saveDraftFromPage( participants[ 0 ].page );
				const finalState = await waitForConvergence(
					activePages(),
					CONVERGENCE_TIMEOUT_MS
				);
				assertNoDuplicatedMarkers( finalState, 'final save' );
				if ( ! DISABLE_RELOAD && participants.length > 1 ) {
					await reloadPage(
						collaborationUtils,
						participants[ 1 ].page
					);
					const settled = await waitForConvergence(
						activePages(),
						CONVERGENCE_TIMEOUT_MS
					);
					expect( JSON.stringify( settled ) ).toBe(
						JSON.stringify( finalState )
					);
					assertNoDuplicatedMarkers( settled, 'final reload' );
					await assertNoInvalidBlocks(
						participants[ 1 ].page,
						'final reload'
					);
				}

				if ( ! documentMayBeEmpty ) {
					expect( finalState.blockCount ).toBeGreaterThan( 0 );
				}
				const saved = ( await requestUtils.rest( {
					params: { context: 'edit' },
					path: `/wp/v2/posts/${ post.id }`,
				} ) ) as {
					content: { raw: string };
					title: { raw: string };
				};
				expect( saved.title.raw ).toBe( finalState.title );
				if ( ! documentMayBeEmpty ) {
					expect( saved.content.raw.length ).toBeGreaterThan( 0 );
				}
			} finally {
				await testInfo.attach( 'fuzz-run.json', {
					body: JSON.stringify(
						{
							consoleLog,
							engine: ENGINE,
							profile: PROFILE,
							seed,
							stepCount: STEP_COUNT,
							trace,
							transport: TRANSPORT,
							userCount: USER_COUNT,
						},
						null,
						'\t'
					),
					contentType: 'application/json',
				} );
			}
		} );
	}
} );
