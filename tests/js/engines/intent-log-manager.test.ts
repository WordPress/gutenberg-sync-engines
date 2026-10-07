/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

/**
 * WordPress dependencies
 */
import { addFilter, removeFilter } from '@wordpress/hooks';

// The real module drags ESM-only deps into Jest. The manager reads
// attribute schemas for its block-default merge, and serializes and parses
// blocks for conflict review. The stand-ins render blocks as opaque JSON
// (name, attributes, children), the same trick the de-rtc suites use.
jest.mock( '@wordpress/blocks', () => {
	const strip = ( block: any ): unknown => ( {
		name: block.name,
		attributes: block.attributes,
		innerBlocks: ( block.innerBlocks ?? [] ).map( strip ),
	} );
	return {
		getBlockType: ( name: string ) =>
			'core/group' === name
				? {
						attributes: {
							tagName: { default: 'div', type: 'string' },
						},
				  }
				: undefined,
		serialize: ( blocks: unknown[] ) =>
			JSON.stringify( blocks.map( strip ) ),
		serializeRawBlock: ( block: {
			blockName: string;
			innerContent: string[];
		} ) =>
			JSON.stringify( [
				{
					name: block.blockName,
					markup: block.innerContent.join( '' ).trim(),
				},
			] ),
		parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	};
} );

// Taxonomy discovery (the manager mirrors entities.js: post-type
// taxonomies by rest_base). The built-in post type carries the two
// standard taxonomies.
jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn( ( { path }: { path: string } ) => {
		if ( path.startsWith( '/wp/v2/types' ) ) {
			return Promise.resolve( {
				post: { taxonomies: [ 'category', 'post_tag' ] },
			} );
		}
		if ( path.startsWith( '/wp/v2/taxonomies' ) ) {
			return Promise.resolve( {
				category: { rest_base: 'categories' },
				post_tag: { rest_base: 'tags' },
			} );
		}
		return Promise.resolve( {} );
	} ),
} ) );

/**
 * Internal dependencies
 */
import { Awareness } from 'y-protocols/awareness';
import { createIntentLogManager } from '../../../src/engines/intent-log-manager';
import {
	registerConflictSource,
	resetConflictSourcesForTesting,
	resolveConflict as registryResolveConflict,
} from '../../../src/review/conflicts';
import { createIntentLogEngineAdapter } from '../../../src/engines/intent-log-adapter';
import {
	INTENT_LOG_UPDATE_TYPES,
	INTENT_LOG_ENGINE_SLUG,
	INTENT_LOG_ENGINE_PROTOCOL,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import {
	getEngineAdapters,
	LOCAL_EDITOR_ORIGIN,
	LOCAL_UNDO_IGNORED_ORIGIN,
	registerSyncEngine,
	resetEngineAdaptersForTesting,
	resolveEngineAdapter,
	resetProviderCreatorsForTesting,
} from '../../../src/framework';
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';
import type { BlockSpec } from '../../../src/engines/intent-log/document.js';
// The frozen core's real server: the regression harness below runs two
// managers against it to reproduce cross-client schedules.
import {
	createServer as rebaseCreateServer,
	serverDocAt as serverDocAtForTest,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type {
	EngineSessionCodec,
	EngineUpdate,
	ProviderCreator,
	RecordHandlers,
} from '@wordpress/sync';

/**
 * A capturing fake transport provider: records the codec it received and
 * exposes the queued local updates plus a way to push server rows in.
 */
function makeFakeTransport() {
	const captured: {
		session?: EngineSessionCodec;
		sent: EngineUpdate[];
		destroyed: boolean;
	} = { sent: [], destroyed: false };

	const creator: ProviderCreator = async ( options ) => {
		captured.session = options.session;
		options.session.onLocalUpdate( ( update ) =>
			captured.sent.push( update )
		);
		return {
			destroy: () => {
				captured.destroyed = true;
			},
			on: () => {},
		};
	};

	return { captured, creator };
}

function makeHandlers(): RecordHandlers & { edits: unknown[] } {
	const edits: unknown[] = [];
	return {
		edits,
		addUndoMeta: jest.fn() as RecordHandlers[ 'addUndoMeta' ],
		editRecord: ( ( data: unknown ) =>
			edits.push( data ) ) as RecordHandlers[ 'editRecord' ],
		getEditedRecord:
			( async () => ( {} ) ) as RecordHandlers[ 'getEditedRecord' ],
		onStatusChange: jest.fn() as RecordHandlers[ 'onStatusChange' ],
		persistCRDTDoc: jest.fn() as RecordHandlers[ 'persistCRDTDoc' ],
		refetchRecord: ( async () => {} ) as RecordHandlers[ 'refetchRecord' ],
		restoreUndoMeta: jest.fn() as RecordHandlers[ 'restoreUndoMeta' ],
	};
}

const snapshotRow = (
	blocks: BlockSpec[],
	props: Record< string, unknown > = {}
) => ( {
	data: JSON.stringify( { doc: createDocument( blocks, props ) } ),
	type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
} );

/**
 * A parked row: an intent the server set aside for review.
 *
 * @param intent  The intent.
 * @param actorId Its author.
 * @param reason  Why it was set aside.
 */
const parkedRow = (
	intent: Record< string, unknown >,
	actorId: string,
	reason = 'frame-conflict'
) => ( {
	data: JSON.stringify( { intent, actorId, reason } ),
	type: INTENT_LOG_UPDATE_TYPES.PARKED,
} );

/**
 * The paragraph texts of a record's side.
 *
 * @param side The side, as serialized blocks.
 */
const textOf = ( side: string | null ) =>
	JSON.parse( side ?? '[]' ).map(
		( block: { attributes: { content: string } } ) =>
			block.attributes.content
	);

const FILTER = 'sync.providers';
const HOOK = 'test/intent-log-manager';

/**
 * Runs the manager's deferred editor sync (see scheduleEditorSync): pushes
 * driven by a capture wait for the typing burst to fall quiet, because
 * core-data commits the editor's own tree AFTER handing it to the manager.
 */
const flushEditorSync = () => {
	jest.advanceTimersByTime( 1500 );
};

describe( 'intent-log manager', () => {
	beforeEach( () => {
		jest.useFakeTimers();
	} );

	afterEach( () => {
		jest.clearAllTimers();
		jest.useRealTimers();
		removeFilter( FILTER, HOOK );
		resetEngineAdaptersForTesting();
		resetConflictSourcesForTesting();
		resetProviderCreatorsForTesting();
		delete window.__experimentalEnableRealTimeCollaboration;
		delete window._wpCollaborationSync;
	} );

	async function loadManagedEntity( record: Record< string, unknown > = {} ) {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );

		const manager = createIntentLogManager();
		const handlers = makeHandlers();
		await manager.load(
			{} as never,
			'postType/post',
			'1',
			record,
			handlers
		);
		return { manager, handlers, transport };
	}

	it( 'registers via registerSyncEngine and resolves from the announcement', () => {
		registerSyncEngine( createIntentLogEngineAdapter() );
		window._wpCollaborationSync = {
			engine: INTENT_LOG_ENGINE_SLUG,
			engineProtocol: INTENT_LOG_ENGINE_PROTOCOL,
			transports: [ 'http-polling' ],
			transportProtocol: 1,
		};
		expect( getEngineAdapters()[ INTENT_LOG_ENGINE_SLUG ] ).toBeDefined();
		expect( resolveEngineAdapter()?.slug ).toBe( INTENT_LOG_ENGINE_SLUG );
	} );

	it( 'hands its session codec to the transport and stays quiet pre-snapshot', async () => {
		const { manager, handlers, transport } = await loadManagedEntity();

		expect( transport.captured.session ).toBeDefined();
		// Editor updates before the snapshot are ignored, not queued.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: { content: 'typed early' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		expect( transport.captured.sent ).toHaveLength( 0 );
		expect( handlers.edits ).toHaveLength( 0 );
	} );

	it( 'REGRESSION: an edit made during the join round trip is captured at bootstrap (reload + insert on an empty-genesis room)', async () => {
		// Fuzzer finding (intent-log/http-polling seed 6, concurrency
		// profile): a participant reloads on an empty-genesis room and
		// inserts a block before the room snapshot arrives. Pre-init
		// edits cannot be authored (no document yet) and the capture lane
		// is edge-triggered, so the insert stayed local forever — the
		// empty-genesis bootstrap skips the reconciling push too.
		const { manager, transport } = await loadManagedEntity();

		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: { content: 'typed during join' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		// Still pre-snapshot: nothing can be authored yet.
		expect( transport.captured.sent ).toHaveLength( 0 );

		// The empty-genesis snapshot lands: the buffered tree must be
		// captured against the fresh baseline and reach the wire. The
		// recovery is deferred past the delivery burst (a rejoiner's
		// history replays right behind the genesis row), so advance the
		// clock.
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );
		expect( transport.captured.sent ).toHaveLength( 0 );
		jest.advanceTimersByTime( 1 );

		expect( transport.captured.sent.length ).toBeGreaterThan( 0 );
		const types = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( types ).toContain( 'insert_block' );
		expect(
			transport.captured.sent.some( ( update ) =>
				update.data.includes( 'typed during join' )
			)
		).toBe( true );
	} );

	it( 'REGRESSION: a rejoin with history discards the buffered pre-init tree (no duplicated blocks)', async () => {
		// The counterpart guard: a REJOINER's room also opens with the
		// (empty) genesis snapshot, but its whole history replays in the
		// same delivery burst. The buffered pre-init tree is an echo of
		// the SAVED content the editor rendered — capturing it against
		// the bare genesis baseline re-authors every saved block as new
		// work, and the history rows landing beside those fabrications
		// duplicate every block (found by fuzz:quick). A document that is
		// non-empty after the burst must discard the buffer.
		const { manager, transport } = await loadManagedEntity();

		// Pre-init: the editor hands over its parsed saved content (one
		// paragraph, with its persisted identity) plus early typing.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'saved marker',
							metadata: { syncId: 'h1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		// The join response: empty genesis, then history replays the
		// same block — one synchronous burst.
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'hist-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_block',
				payload: {
					block: {
						syncId: 'h1',
						blockType: 'core/paragraph',
						text: 'saved marker',
					},
					parentId: null,
					afterSiblingId: null,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		jest.advanceTimersByTime( 1 );

		// The buffer was discarded: nothing was re-authored.
		expect(
			transport.captured.sent.filter(
				( update ) => 'insert_block' === JSON.parse( update.data ).type
			)
		).toHaveLength( 0 );
	} );

	it( 'REGRESSION: stale-base voids re-capture the editor tree instead of silently losing the edit', async () => {
		// A2's retry-free e2e runs found this as real data loss: a client
		// whose own earlier burst pushed the room past the checkpoint trim
		// authors its next edits at a now-trimmed seq; the server voids
		// them ALL as stale-base without planning, and (because the
		// client's cursor is current) no snapshot reset ever arrives. The
		// replica's replan then dropped the optimistic effect and the next
		// editor sync pushed the REVERTED document over the canvas — the
		// user watched their typing vanish. The manager must instead
		// re-capture the current editor tree at the current seq.
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Hello world',
				},
			] )
		);

		const editedTree = [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello world!!',
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
			},
		];
		manager.update(
			'postType/post',
			'1',
			{ blocks: editedTree },
			'gutenberg'
		);
		expect( transport.captured.sent ).toHaveLength( 1 );
		const first = JSON.parse( transport.captured.sent[ 0 ].data );

		// The server compacted past the authoring seq: the whole ladder
		// voids as stale-base, with no snapshot reset (cursor is current).
		transport.captured.session!.receiveDispositions!( [
			{
				intentId: first.intentId,
				status: 'voided',
				reason: 'stale-base',
			} as never,
		] );

		// The recovery is deferred past the settle/replan.
		await jest.advanceTimersByTimeAsync( 1 );

		// The edit was re-authored — not silently lost.
		expect( transport.captured.sent.length ).toBeGreaterThan( 1 );
		const reauthored = JSON.parse( transport.captured.sent.at( -1 )!.data );
		expect( reauthored.intentId ).not.toBe( first.intentId );
		expect( JSON.stringify( reauthored.payload ) ).toContain( '!!' );
	} );

	it( 'pushes the snapshot document into the editor, captures edits as intents, and suppresses the echo', async () => {
		const { manager, handlers, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Hello world',
				},
			] )
		);

		// Snapshot arrival dispatches the shared document to the editor.
		expect( handlers.edits ).toHaveLength( 1 );
		const pushed = handlers.edits[ 0 ] as {
			blocks: Array< { attributes: Record< string, unknown > } >;
		};
		expect( pushed.blocks[ 0 ].attributes.content ).toBe( 'Hello world' );
		expect( pushed.blocks[ 0 ].attributes.metadata ).toEqual( {
			syncId: 'p1',
		} );

		// The editor echoes the same tree back (as editors do): no intents.
		manager.update(
			'postType/post',
			'1',
			{ blocks: pushed.blocks },
			'gutenberg'
		);
		expect( transport.captured.sent ).toHaveLength( 0 );

		// A real edit derives exactly one intent and does not bounce back.
		const editsBefore = handlers.edits.length;
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Hello brave world',
							metadata: { syncId: 'p1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		expect( transport.captured.sent ).toHaveLength( 1 );
		const sentIntent = JSON.parse( transport.captured.sent[ 0 ].data );
		expect( sentIntent.type ).toBe( 'insert_text' );
		expect( handlers.edits ).toHaveLength( editsBefore );
	} );

	it( 'REGRESSION: a wholesale FIRST edit (select-all paste) deletes the genesis blocks', async () => {
		// The genesis blocks never appear in any captured tree when the
		// user's first action replaces the whole document, but they came
		// from the saved content this editor itself rendered — their
		// absence is a deletion, not staleness. Without seq-0 seeding the
		// removals were dropped and the originals resurrected everywhere.
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'g1',
					blockType: 'core/paragraph',
					text: 'Original one',
				},
				{
					syncId: 'g2',
					blockType: 'core/paragraph',
					text: 'Original two',
				},
			] )
		);

		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/heading',
						attributes: { content: 'Pasted heading' },
						innerBlocks: [],
					},
					{
						name: 'core/paragraph',
						attributes: { content: 'Pasted paragraph' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const intents = transport.captured.sent.map( ( row ) =>
			JSON.parse( row.data )
		);
		const removed = intents
			.filter( ( intent ) => 'remove_block' === intent.type )
			.map( ( intent ) => intent.payload.syncId )
			.sort();
		expect( removed ).toEqual( [ 'g1', 'g2' ] );
		expect(
			intents.filter( ( intent ) => 'insert_block' === intent.type )
		).toHaveLength( 2 );
	} );

	it( 'a checkpoint bootstrap (seq > 0) does NOT make never-displayed blocks removable', async () => {
		// A compaction checkpoint may carry blocks a late joiner's editor
		// has never rendered; their absence from its first capture must
		// still read as staleness (retention), never deletion.
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				seq: 7,
				doc: createDocument( [
					{
						syncId: 'c1',
						blockType: 'core/paragraph',
						text: 'Checkpoint-only block',
					},
				] ),
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );

		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Typed locally',
							metadata: { syncId: 'local-new' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const intents = transport.captured.sent.map( ( row ) =>
			JSON.parse( row.data )
		);
		expect(
			intents.some( ( intent ) => 'remove_block' === intent.type )
		).toBe( false );
		expect(
			intents.filter( ( intent ) => 'insert_block' === intent.type )
		).toHaveLength( 1 );
	} );

	it( 'persisted record ids are removable from the first capture even on a checkpoint bootstrap', async () => {
		// The loaded record is the OTHER proof of display: a late joiner
		// bootstrapping from a compaction checkpoint has still parsed and
		// rendered the saved content, so ids persisted in it are deletable
		// by a wholesale first edit — while a checkpoint block that was
		// never saved (another client's live work) stays protected.
		const { manager, transport } = await loadManagedEntity( {
			content: {
				raw:
					'<!-- wp:paragraph {"metadata":{"syncId":"r1"}} -->\n<p>Saved one</p>\n<!-- /wp:paragraph -->\n\n' +
					'<!-- wp:paragraph {"metadata":{"syncId":"r2"}} -->\n<p>Saved two</p>\n<!-- /wp:paragraph -->',
			},
		} );
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				seq: 7,
				doc: createDocument( [
					{
						syncId: 'r1',
						blockType: 'core/paragraph',
						text: 'Saved one',
					},
					{
						syncId: 'r2',
						blockType: 'core/paragraph',
						text: 'Saved two',
					},
					{
						syncId: 'c3',
						blockType: 'core/paragraph',
						text: 'Live unsaved block',
					},
				] ),
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );

		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Pasted replacement',
							metadata: { syncId: 'local-new' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const intents = transport.captured.sent.map( ( row ) =>
			JSON.parse( row.data )
		);
		const removed = intents
			.filter( ( intent ) => 'remove_block' === intent.type )
			.map( ( intent ) => intent.payload.syncId )
			.sort();
		expect( removed ).toEqual( [ 'r1', 'r2' ] );
		expect(
			intents.filter( ( intent ) => 'insert_block' === intent.type )
		).toHaveLength( 1 );
	} );

	it( 'applies remote intents to the editor through editRecord', async () => {
		const { handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Hello world',
				},
			] )
		);

		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'Remote: ',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );

		const last = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: Record< string, unknown > } >;
		};
		expect( last.blocks[ 0 ].attributes.content ).toBe(
			'Remote: Hello world'
		);
	} );

	it( 'REGRESSION: id-less editor blocks keep a stable identity across updates (no insert/remove churn)', async () => {
		// The editor parses post content without metadata.syncId. Repeated
		// update() calls with id-less blocks must adopt the document's
		// existing identities — never mint fresh ids per call, which turns
		// every keystroke into remove_block + insert_block and makes blocks
		// flicker out of existence on peers.
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'genesis-p1',
					blockType: 'core/paragraph',
					text: 'Hello world',
				},
			] )
		);

		const editorBlocks = ( content: string ) => [
			{
				name: 'core/paragraph',
				// No metadata.syncId — exactly what a fresh editor holds.
				attributes: { content },
				innerBlocks: [],
			},
		];

		manager.update(
			'postType/post',
			'1',
			{ blocks: editorBlocks( 'Hello world!' ) },
			'gutenberg'
		);
		manager.update(
			'postType/post',
			'1',
			{ blocks: editorBlocks( 'Hello world!!' ) },
			'gutenberg'
		);

		const sentTypes = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( sentTypes ).toEqual( [ 'insert_text', 'insert_text' ] );
		// Both edits target the genesis identity.
		for ( const update of transport.captured.sent ) {
			expect( JSON.parse( update.data ).payload.syncId ).toBe(
				'genesis-p1'
			);
		}
		// The editor was handed the adopted identity so its next tree
		// carries it (the write-back half of the fix).
		flushEditorSync();
		const lastPush = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: { metadata?: { syncId?: string } } } >;
		};
		expect( lastPush.blocks[ 0 ].attributes.metadata?.syncId ).toBe(
			'genesis-p1'
		);
	} );

	it( 'REGRESSION: a genuinely new id-less block is inserted once and stays stable', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'genesis-p1',
					blockType: 'core/paragraph',
					text: 'Hello',
				},
			] )
		);

		const withNewBlock = ( content: string ) => [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello',
					metadata: { syncId: 'genesis-p1' },
				},
				innerBlocks: [],
			},
			{
				name: 'core/paragraph',
				attributes: { content },
				innerBlocks: [],
			},
		];

		manager.update(
			'postType/post',
			'1',
			{ blocks: withNewBlock( 'typed' ) },
			'gutenberg'
		);
		manager.update(
			'postType/post',
			'1',
			{ blocks: withNewBlock( 'typed more' ) },
			'gutenberg'
		);

		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.map( ( intent ) => intent.type ) ).toEqual( [
			'insert_block',
			'insert_text',
		] );
		// The second edit addresses the SAME identity the insert created.
		expect( sent[ 1 ].payload.syncId ).toBe(
			sent[ 0 ].payload.block.syncId
		);
	} );

	it( 'REGRESSION: a stale editor tree does not delete an unseen remote block', async () => {
		// Two clients seed an empty post concurrently. The remote client's
		// paragraph lands in the shared document while the local editor tree
		// (mid-typing) does not contain it yet. Capture must NOT interpret
		// that absence as a user deletion — it must retain the block and
		// push the merged view to the editor.
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		// The local user types a paragraph of their own (id-less tree).
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: { content: 'mine' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		const ownInsert = JSON.parse( transport.captured.sent[ 0 ].data );
		expect( ownInsert.type ).toBe( 'insert_block' );

		// A remote client's paragraph arrives.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_block',
				payload: {
					block: {
						syncId: 'remote-block',
						blockType: 'core/paragraph',
						text: 'theirs',
					},
					parentId: null,
					afterSiblingId: null,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );

		// The local editor, still on its stale tree, types more BEFORE
		// rendering the push (the tree lacks the remote block).
		transport.captured.sent.length = 0;
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'mine!',
							metadata: {
								syncId: ownInsert.payload.block.syncId,
							},
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const sentTypes = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( sentTypes ).not.toContain( 'remove_block' );
		// The merged view (both blocks) reached the editor.
		flushEditorSync();
		const lastPush = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: { metadata?: { syncId?: string } } } >;
		};
		const pushedIds = lastPush.blocks.map(
			( block ) => block.attributes.metadata?.syncId
		);
		expect( pushedIds ).toContain( 'remote-block' );
		expect( pushedIds ).toContain( ownInsert.payload.block.syncId );
	} );

	it( 'REGRESSION: deleting a just-arrived remote block before testifying it re-pushes (no silent editor/doc split), and the repeat deletion is captured', async () => {
		/*
		 * The fuzzer's leave/re-join lane found this: a peer's block is
		 * pushed to the editor, and the user deletes it BEFORE any edit
		 * echoed it back through update() — so it never became removable.
		 * Retention correctly refuses the deletion, but the restore push
		 * used to be suppressed because the doc still matched
		 * lastPushedState (set by the block's own arrival push), leaving
		 * this editor silently behind the shared document forever.
		 */
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'genesis-1',
					blockType: 'core/paragraph',
					text: 'Seed',
				},
			] )
		);

		// A remote peer (e.g. a rejoiner) inserts a block; it is pushed.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-rejoin-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_block',
				payload: {
					block: {
						syncId: 'rejoin-block',
						blockType: 'core/paragraph',
						text: 'theirs',
					},
					parentId: null,
					afterSiblingId: null,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		const arrivalPush = handlers.edits.at( -1 ) as {
			blocks: Array< {
				attributes: { metadata?: { syncId?: string } };
			} >;
		};
		expect(
			arrivalPush.blocks.map(
				( block ) => block.attributes.metadata?.syncId
			)
		).toContain( 'rejoin-block' );

		// The user deletes it as their FIRST interaction — the testimony
		// never contained it, so it must be retained, and the editor must
		// be caught back up (visible resurrection), not left behind.
		transport.captured.sent.length = 0;
		const editsBeforeDelete = handlers.edits.length;
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Seed',
							metadata: { syncId: 'genesis-1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		expect(
			transport.captured.sent.map(
				( update ) => JSON.parse( update.data ).type
			)
		).not.toContain( 'remove_block' );
		// A NEW push must be dispatched — the previous one (the arrival
		// push) proves nothing about what the editor now displays.
		flushEditorSync();
		expect( handlers.edits.length ).toBeGreaterThan( editsBeforeDelete );
		const restorePush = handlers.edits.at( -1 ) as {
			blocks: Array< {
				attributes: { metadata?: { syncId?: string } };
			} >;
		};
		expect(
			restorePush.blocks.map(
				( block ) => block.attributes.metadata?.syncId
			)
		).toContain( 'rejoin-block' );

		// The editor renders the restore (echo testifies the block)…
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Seed',
							metadata: { syncId: 'genesis-1' },
						},
						innerBlocks: [],
					},
					{
						name: 'core/paragraph',
						attributes: {
							content: 'theirs',
							metadata: { syncId: 'rejoin-block' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		// …so deleting it AGAIN is now a real, captured deletion.
		transport.captured.sent.length = 0;
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Seed',
							metadata: { syncId: 'genesis-1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		const repeatTypes = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( repeatTypes ).toContain( 'remove_block' );
	} );

	describe( 'the echo race (capture against the OBSERVED document)', () => {
		/**
		 * Loads a room holding one paragraph the editor has testified to.
		 *
		 * @return The managed entity plus its handles.
		 */
		async function loadTypedRoom() {
			const loaded = await loadManagedEntity();
			loaded.transport.captured.session!.receiveUpdate(
				snapshotRow( [
					{
						syncId: 'p1',
						blockType: 'core/paragraph',
						text: 'Hello',
					},
				] )
			);
			// The editor renders the snapshot and hands the tree back.
			loaded.manager.update(
				'postType/post',
				'1',
				{ blocks: paragraphTree( 'Hello' ) },
				'gutenberg'
			);
			return loaded;
		}

		const paragraphTree = ( content: string ) => [
			{
				name: 'core/paragraph',
				attributes: { content, metadata: { syncId: 'p1' } },
				innerBlocks: [],
			},
		];

		const remoteAppend = ( text: string, baseSeq = 0 ) => ( {
			data: JSON.stringify( {
				intentId: `remote-${ text }`,
				actorId: 'u9c9',
				baseSeq,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 'Hello'.length,
					text,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );

		const lastPushedContent = ( handlers: { edits: unknown[] } ) =>
			(
				handlers.edits.at( -1 ) as {
					blocks: Array< { attributes: { content: string } } >;
				}
			 ).blocks[ 0 ].attributes.content;

		const documentContent = ( session: EngineSessionCodec ) =>
			( session as IntentLogSession ).getDocument()!.root[ 0 ].fields
				.content.text;

		it( 'REGRESSION: remote work arriving mid-burst defers its push past the typing-quiet window', async () => {
			// A push landing while the user types remounts the caret block
			// and the next keystrokes die in a detached node (seen on the
			// real-websocket lane, where rows arrive per keystroke). While
			// the editor is typing-hot, remote application must ride the
			// settled editor sync; a quiet editor still gets it pushed.
			const { handlers, transport } = await loadTypedRoom();
			const editsBefore = handlers.edits.length;
			transport.captured.session!.receiveUpdate(
				remoteAppend( ' there' )
			);
			// Hot: no immediate push.
			expect( handlers.edits.length ).toBe( editsBefore );
			// The burst settles: the deferred sync pushes the merged view.
			flushEditorSync();
			expect( lastPushedContent( handlers ) ).toBe( 'Hello there' );
		} );

		it( 'REGRESSION: a keystroke racing a push does not clobber the remote text', async () => {
			/*
			 * The push (remote text → editor) and a live keystroke cross: the
			 * editor's tree still shows the PRE-push text plus the new
			 * character. Diffing that tree against the current head read the
			 * remote text as deleted and authored a replace_text destroying
			 * it — the corruption seen under load, worst over websocket's
			 * per-keystroke cadence. Captured against the state the tree
			 * actually reflects, the same tree derives one insert, stamped at
			 * that state's seq for the transform to merge.
			 */
			const { manager, handlers, transport } = await loadTypedRoom();
			transport.captured.session!.receiveUpdate(
				remoteAppend( ' there' )
			);
			// The typed room is still hot, so the push waits out the
			// typing-quiet gate before dispatching (the websocket-lane
			// keystroke-eating fix); flush it to set up the race.
			flushEditorSync();
			expect( lastPushedContent( handlers ) ).toBe( 'Hello there' );

			// The editor never rendered that push: its tree is the old text
			// plus the keystroke.
			transport.captured.sent.length = 0;
			manager.update(
				'postType/post',
				'1',
				{ blocks: paragraphTree( 'Hello!' ) },
				'gutenberg'
			);

			const sent = transport.captured.sent.map( ( update ) =>
				JSON.parse( update.data )
			);
			expect( sent.map( ( intent ) => intent.type ) ).toEqual( [
				'insert_text',
			] );
			expect( sent[ 0 ].payload ).toMatchObject( {
				syncId: 'p1',
				offset: 'Hello'.length,
				text: '!',
			} );
			// Authored against the observed state, not the head.
			expect( sent[ 0 ].baseSeq ).toBe( 0 );
			// Locally merged exactly as the server will merge it, and the
			// merged text goes back to the editor.
			flushEditorSync();
			expect( lastPushedContent( handlers ) ).toBe( 'Hello there!' );
		} );

		it( 'a keystroke on top of a RENDERED push does not duplicate the remote text', async () => {
			// The mirror image: when the tree does carry the pushed text, the
			// baseline must follow it, or the diff would re-author the remote
			// insert as local content.
			const { manager, handlers, transport } = await loadTypedRoom();
			transport.captured.session!.receiveUpdate(
				remoteAppend( ' there' )
			);
			// Flush the typing-quiet-deferred push (see the sibling test).
			flushEditorSync();

			transport.captured.sent.length = 0;
			manager.update(
				'postType/post',
				'1',
				{ blocks: paragraphTree( 'Hello there!' ) },
				'gutenberg'
			);

			const sent = transport.captured.sent.map( ( update ) =>
				JSON.parse( update.data )
			);
			expect( sent.map( ( intent ) => intent.type ) ).toEqual( [
				'insert_text',
			] );
			expect( sent[ 0 ].payload ).toMatchObject( {
				offset: 'Hello there'.length,
				text: '!',
			} );
			expect( sent[ 0 ].baseSeq ).toBe( 1 );
			// Nothing to push back: the editor typed this state itself.
			expect( documentContent( transport.captured.session! ) ).toBe(
				'Hello there!'
			);
			expect( handlers.edits.at( -1 ) ).toBeDefined();
		} );

		it( 'a whole burst of stale keystrokes stays disjoint from the remote text', async () => {
			/*
			 * The race is not a single event: while the editor keeps handing
			 * over trees built on the pre-push state, every capture keeps
			 * authoring against it. Later keystrokes of such a burst may be
			 * ESCALATED rather than merged — the engine's rule 5, since their
			 * offsets sit in a frame that both an earlier own edit and a
			 * remote edit have written — but nothing is ever authored that
			 * destroys the remote text.
			 */
			const { manager, transport } = await loadTypedRoom();
			transport.captured.session!.receiveUpdate(
				remoteAppend( ' there' )
			);

			transport.captured.sent.length = 0;
			for ( const content of [ 'Hello!', 'Hello!!', 'Hello!!!' ] ) {
				manager.update(
					'postType/post',
					'1',
					{ blocks: paragraphTree( content ) },
					'gutenberg'
				);
			}

			const sent = transport.captured.sent.map( ( update ) =>
				JSON.parse( update.data )
			);
			expect(
				sent.map( ( intent ) => intent.type as string )
			).not.toContain( 'replace_text' );
			expect(
				sent.map( ( intent ) => intent.type as string )
			).not.toContain( 'delete_text' );
			expect(
				documentContent( transport.captured.session! ).startsWith(
					'Hello there'
				)
			).toBe( true );
		} );

		it( 'REGRESSION: a capture-driven push is dispatched AFTER the capture, not during it', async () => {
			/*
			 * core-data hands the sync manager the edits before it commits
			 * them, and every editor edit carries the editor's block tree —
			 * so an editRecord dispatched from inside update() is
			 * immediately overwritten and the editor never renders it. The
			 * fuzzer found this as new blocks whose syncId never reached the
			 * canvas. Capture-driven pushes must wait for the burst.
			 */
			const { manager, handlers } = await loadTypedRoom();

			const editsBefore = handlers.edits.length;
			manager.update(
				'postType/post',
				'1',
				{
					blocks: [
						...paragraphTree( 'Hello' ),
						{
							name: 'core/paragraph',
							// Freshly typed: no identity yet.
							attributes: { content: 'brand new' },
							innerBlocks: [],
						},
					],
				},
				'gutenberg'
			);
			expect( handlers.edits ).toHaveLength( editsBefore );

			flushEditorSync();
			const pushed = handlers.edits.at( -1 ) as {
				blocks: Array< {
					attributes: { metadata?: { syncId?: string } };
				} >;
			};
			expect( pushed.blocks ).toHaveLength( 2 );
			expect( pushed.blocks[ 1 ].attributes.metadata?.syncId ).toEqual(
				expect.any( String )
			);
		} );

		it( 'a quiet editor confirms the push, so later captures author at the new seq', async () => {
			const { manager, transport } = await loadTypedRoom();
			transport.captured.session!.receiveUpdate(
				remoteAppend( ' there' )
			);
			// Nothing contradicts the push while the editor is idle.
			jest.advanceTimersByTime( 5000 );

			transport.captured.sent.length = 0;
			manager.update(
				'postType/post',
				'1',
				{ blocks: paragraphTree( 'Hello there!' ) },
				'gutenberg'
			);
			const sent = JSON.parse( transport.captured.sent[ 0 ].data );
			expect( sent.baseSeq ).toBe( 1 );
		} );
	} );

	it( 'REGRESSION: a remotely removed block is not resurrected by a stale editor tree', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'a1', blockType: 'core/paragraph', text: 'Alpha' },
				{ syncId: 'b1', blockType: 'core/paragraph', text: 'Beta' },
			] )
		);

		// A remote client removes Beta.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-rm',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'remove_block',
				payload: { syncId: 'b1' },
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );

		// The local editor, on a stale tree that still shows Beta, edits
		// Alpha. Beta must not be re-inserted.
		transport.captured.sent.length = 0;
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Alpha!',
							metadata: { syncId: 'a1' },
						},
						innerBlocks: [],
					},
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Beta',
							metadata: { syncId: 'b1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.map( ( intent ) => intent.type ) ).toEqual( [
			'insert_text',
		] );
		expect( sent[ 0 ].payload.syncId ).toBe( 'a1' );
	} );

	it( 'a block the editor KNEW and dropped is still removed', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'a1', blockType: 'core/paragraph', text: 'Alpha' },
				{ syncId: 'b1', blockType: 'core/paragraph', text: 'Beta' },
			] )
		);

		// The editor renders the snapshot push and echoes the full tree —
		// its testimony that it displays both blocks.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Alpha',
							metadata: { syncId: 'a1' },
						},
						innerBlocks: [],
					},
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Beta',
							metadata: { syncId: 'b1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		// The user deletes Beta.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Alpha',
							metadata: { syncId: 'a1' },
						},
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.map( ( intent ) => intent.type ) ).toEqual( [
			'remove_block',
		] );
		expect( sent[ 0 ].payload.syncId ).toBe( 'b1' );
	} );

	it( 'REGRESSION: pushed blocks carry their block-type attribute defaults', async () => {
		/*
		 * Engine-document attrs mirror serialized comment JSON, which omits
		 * defaults. core/group save() dereferences tagName (default 'div');
		 * pushing the block without it made save() throw and the serializer
		 * silently emitted a VOID group — children and wrapper dropped from
		 * saved content (fuzzer: post-reload invalid recovery blocks).
		 */
		const { handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'group-1',
					blockType: 'core/group',
					attrs: { layout: { type: 'constrained' } },
					children: [
						{
							syncId: 'child-1',
							blockType: 'core/paragraph',
							text: 'Inside',
						},
					],
				},
			] )
		);

		const push = handlers.edits.at( -1 ) as {
			blocks: Array< {
				attributes: Record< string, unknown >;
			} >;
		};
		expect( push.blocks[ 0 ].attributes.tagName ).toBe( 'div' );
		// Non-defaulted attrs pass through untouched.
		expect( push.blocks[ 0 ].attributes.layout ).toEqual( {
			type: 'constrained',
		} );
	} );

	it( 'REGRESSION: pushed blocks carry stable clientIds so the block editor accepts them', async () => {
		// The block-editor store keys blocks by clientId. Pushing blocks
		// without one makes the canvas silently drop the tree (dev bundles)
		// or remount every block per push. Ids must also be STABLE across
		// pushes for the same syncId so React reconciles in place.
		const { handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);

		const firstPush = handlers.edits.at( -1 ) as {
			blocks: Array< { clientId?: string; isValid?: boolean } >;
		};
		expect( firstPush.blocks[ 0 ].clientId ).toBeTruthy();
		expect( firstPush.blocks[ 0 ].isValid ).toBe( true );

		// A remote edit triggers another push: same syncId → same clientId.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'x',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		const secondPush = handlers.edits.at( -1 ) as {
			blocks: Array< { clientId?: string } >;
		};
		expect( secondPush.blocks[ 0 ].clientId ).toBe(
			firstPush.blocks[ 0 ].clientId
		);
	} );

	it( 'REGRESSION: a just-created block keeps the EDITOR clientId on its first identity write-back (no remount)', async () => {
		// Creating a block gives it an editor-chosen clientId; capture
		// mints its collaboration identity and the deferred sync pushes
		// the tree back. That push must reuse the editor's clientId: a
		// fresh one remounts the block and destroys component-local UI
		// state, visibly closing the Custom HTML block's just-opened
		// "Edit HTML" modal about a second after the block is added.
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		const bootstrapPush = handlers.edits.at( -1 ) as {
			blocks: Array< {
				clientId: string;
				attributes: { metadata?: { syncId?: string } };
			} >;
		};
		const existing = bootstrapPush.blocks[ 0 ];
		expect( existing.attributes.metadata?.syncId ).toBe( 'p1' );

		// The user adds a block: the tree carries the pushed block
		// unchanged plus the new block with its own editor clientId and
		// no collaboration identity yet.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						clientId: existing.clientId,
						attributes: {
							content: 'Hello',
							metadata: { syncId: 'p1' },
						},
						innerBlocks: [],
					},
					{
						name: 'core/paragraph',
						clientId: 'editor-made-this',
						attributes: { content: 'brand new' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);
		flushEditorSync();

		const push = handlers.edits.at( -1 ) as {
			blocks: Array< {
				clientId?: string;
				attributes: { metadata?: { syncId?: string } };
			} >;
		};
		expect( push.blocks ).toHaveLength( 2 );
		// The write-back carries the minted identity for the new block…
		expect( push.blocks[ 1 ].attributes.metadata?.syncId ).toBeTruthy();
		// …on the editor's OWN clientIds, so nothing remounts.
		expect( push.blocks[ 0 ].clientId ).toBe( existing.clientId );
		expect( push.blocks[ 1 ].clientId ).toBe( 'editor-made-this' );
	} );

	it( 'title: genesis matching the loaded record is NOT re-pushed as an edit', async () => {
		const { handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Same title' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { title: 'Same title' } )
		);
		expect(
			handlers.edits.filter(
				( edit ) => 'title' in ( edit as Record< string, unknown > )
			)
		).toHaveLength( 0 );
	} );

	it( 'title: a room value newer than the loaded record pushes on snapshot', async () => {
		const { handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Stale title' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { title: 'Fresh title' } )
		);
		expect( handlers.edits.at( -1 ) ).toEqual( { title: 'Fresh title' } );
	} );

	it( 'syncs undo-ignored edits without making them undo steps', async () => {
		const { manager, transport } = await loadManagedEntity( {
			title: { raw: 'Original' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow(
				[
					{
						syncId: 'p1',
						blockType: 'core/paragraph',
						text: 'Hello',
					},
				],
				{ title: 'Original' }
			)
		);
		flushEditorSync();

		// core-data tags `undoIgnore` edits (and save responses) with the
		// ignored origin: they reach the wire but not the undo stack.
		manager.update(
			'postType/post',
			'1',
			{ title: 'Set by code' },
			LOCAL_UNDO_IGNORED_ORIGIN
		);
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'Hello world',
							metadata: { syncId: 'p1' },
						},
						innerBlocks: [],
					},
				],
			},
			LOCAL_UNDO_IGNORED_ORIGIN
		);
		const sent = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( sent ).toEqual( [ 'set_property', 'insert_text' ] );
		expect( manager.undoManager!.hasUndo() ).toBe( false );

		// An ordinary editor edit still becomes an undo step.
		manager.update(
			'postType/post',
			'1',
			{ title: 'Typed by the user' },
			LOCAL_EDITOR_ORIGIN
		);
		expect( manager.undoManager!.hasUndo() ).toBe( true );
	} );

	it( 'title: a remote set_property pushes into the editor; a local edit authors one and suppresses the echo', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Original' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { title: 'Original' } )
		);

		// Local edit: authors a set_property on the wire…
		manager.update( 'postType/post', '1', { title: 'Locally typed' }, 'e' );
		const sent = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect( sent ).toContain( 'set_property' );
		// …and the session change events it produced do not bounce the
		// value back into the editor.
		expect(
			handlers.edits.filter(
				( edit ) => 'title' in ( edit as Record< string, unknown > )
			)
		).toHaveLength( 0 );

		// Remote title change (sequential: observed our version) pushes.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-title-1',
				actorId: 'u9c9',
				baseSeq: 1,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'title',
					value: 'Remote title',
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( { title: 'Remote title' } );

		// The push's echo (editor reports the same value back) is inert.
		const editsBefore = handlers.edits.length;
		manager.update( 'postType/post', '1', { title: 'Remote title' }, 'e' );
		const sentAfter = transport.captured.sent.map(
			( update ) => JSON.parse( update.data ).type
		);
		expect(
			sentAfter.filter( ( t ) => 'set_property' === t )
		).toHaveLength( 1 );
		expect( handlers.edits ).toHaveLength( editsBefore );
	} );

	it( 'properties: non-string scalars (sticky, featured_media, author) round-trip with their types', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			sticky: false,
			featured_media: 0,
			author: 1,
		} );
		// Genesis matching the loaded record pushes nothing (typed echo
		// suppression).
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { sticky: false, featured_media: 0, author: 1 } )
		);
		expect( handlers.edits ).toHaveLength( 0 );

		// Local edits author typed set_property intents.
		manager.update(
			'postType/post',
			'1',
			{ sticky: true, featured_media: 42 },
			'e'
		);
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		const byName = Object.fromEntries(
			sent
				.filter( ( intent ) => 'set_property' === intent.type )
				.map( ( intent ) => [
					intent.payload.name,
					intent.payload.value,
				] )
		);
		expect( byName ).toEqual( { sticky: true, featured_media: 42 } );

		// A remote value pushes with its type preserved.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-author-1',
				actorId: 'u9c9',
				baseSeq: 3,
				txnId: null,
				type: 'set_property',
				payload: { name: 'author', value: 7, observedVersion: 1 },
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( { author: 7 } );
	} );

	it( 'properties: an auto-draft status neither captures nor pushes; a real status syncs', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			status: 'draft',
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { status: 'draft' } )
		);

		// Capture guard: the invalid status never becomes an intent.
		manager.update( 'postType/post', '1', { status: 'auto-draft' }, 'e' );
		expect( transport.captured.sent ).toHaveLength( 0 );

		// A genuine workflow change authors an intent…
		manager.update( 'postType/post', '1', { status: 'pending' }, 'e' );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.at( -1 ).payload ).toMatchObject( {
			name: 'status',
			value: 'pending',
		} );

		// …and a remote auto-draft register value never reaches the editor.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-status-1',
				actorId: 'u9c9',
				baseSeq: 3,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'status',
					value: 'auto-draft',
					observedVersion: 2,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect(
			handlers.edits.filter(
				( edit ) => 'status' in ( edit as Record< string, unknown > )
			)
		).toHaveLength( 0 );
	} );

	it( 'properties: an empty slug (auto-generated default) is not captured; a real slug is', async () => {
		const { manager, transport } = await loadManagedEntity( {
			slug: '',
		} );
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		manager.update( 'postType/post', '1', { slug: '' }, 'e' );
		expect( transport.captured.sent ).toHaveLength( 0 );

		manager.update( 'postType/post', '1', { slug: 'hello-world' }, 'e' );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.at( -1 ).payload ).toMatchObject( {
			name: 'slug',
			value: 'hello-world',
		} );
	} );

	it( 'properties: the "Auto Draft" placeholder title is inert against a blanked genesis', async () => {
		// A fresh auto-draft: the record carries the stored placeholder,
		// the server genesis seeds the blanked title. Neither joining nor
		// the editor reporting the placeholder may author or push an edit.
		const { manager, handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Auto Draft' },
			status: 'auto-draft',
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { title: '' } )
		);
		expect(
			handlers.edits.filter(
				( edit ) => 'title' in ( edit as Record< string, unknown > )
			)
		).toHaveLength( 0 );

		manager.update( 'postType/post', '1', { title: 'Auto Draft' }, 'e' );
		expect( transport.captured.sent ).toHaveLength( 0 );
	} );

	it( 'properties: a remote date lands immediately, floating local date or not', async () => {
		// A register only ever carries a DELIBERATE date change (sidebar
		// edit or post-save mutation feed) — genesis parity keeps floating
		// dates out of the room — so the peer applies it unconditionally.
		// The old floating-date receive guard made propagation depend on
		// the peer's stale `modified` value and save history.
		const { handlers, transport } = await loadManagedEntity( {
			date: '2026-08-01T10:00:00',
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { date: '2026-08-01T10:00:00' } )
		);
		// Genesis matching the record is not a change.
		expect( handlers.edits ).toHaveLength( 0 );

		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-date-1',
				actorId: 'u9c9',
				baseSeq: 1,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'date',
					value: '2026-09-01T09:00:00',
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( {
			date: '2026-09-01T09:00:00',
		} );
	} );

	it( 'taxonomies: term-ID arrays round-trip as whole-array registers with value-based echo suppression', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			categories: [ 1 ],
			tags: [ 4, 7 ],
		} );
		// Genesis carrying equal (but fresh) arrays pushes nothing.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { categories: [ 1 ], tags: [ 4, 7 ] } )
		);
		expect( handlers.edits ).toHaveLength( 0 );

		// A local term change authors one whole-array set_property…
		manager.update( 'postType/post', '1', { tags: [ 4, 7, 9 ] }, 'e' );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.at( -1 ).payload ).toMatchObject( {
			name: 'tags',
			value: [ 4, 7, 9 ],
		} );

		// …and the editor echoing the same terms (a NEW array instance)
		// authors nothing further.
		manager.update( 'postType/post', '1', { tags: [ 4, 7, 9 ] }, 'e' );
		expect(
			transport.captured.sent.map(
				( update ) => JSON.parse( update.data ).type
			)
		).toHaveLength( 1 );

		// A remote term change pushes the whole array into the editor.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-cats-1',
				actorId: 'u9c9',
				baseSeq: 2,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'categories',
					value: [ 5, 6 ],
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( { categories: [ 5, 6 ] } );
	} );

	it( 'taxonomies: term order never reads as a change, and captures author canonical order', async () => {
		// The editor appends term IDs in click order while REST serializes
		// name order; the same SET in a different order must neither push
		// nor author (it used to escalate spurious property conflicts via
		// the post-save mutation feed).
		const { manager, handlers, transport } = await loadManagedEntity( {
			tags: [ 4, 7 ],
		} );
		// A register holding the same set in another order (e.g. written
		// by an older client) is not a change.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { tags: [ 7, 4 ] } )
		);
		expect( handlers.edits ).toHaveLength( 0 );

		// The save feed reporting the same set reordered authors nothing.
		manager.update( 'postType/post', '1', { tags: [ 7, 4 ] }, 'e' );
		expect( transport.captured.sent ).toHaveLength( 0 );

		// A genuine change authors in canonical (numeric) order regardless
		// of the editor's click order.
		manager.update( 'postType/post', '1', { tags: [ 9, 7, 4 ] }, 'e' );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent.at( -1 ).payload ).toMatchObject( {
			name: 'tags',
			value: [ 4, 7, 9 ],
		} );
	} );

	it( 'taxonomies: a non-numeric array is not capturable', async () => {
		const { manager, transport } = await loadManagedEntity( {
			tags: [],
		} );
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		manager.update(
			'postType/post',
			'1',
			{ tags: [ 'not-a-term-id' ] },
			'e'
		);
		expect( transport.captured.sent ).toHaveLength( 0 );
	} );

	it( 'meta: registers round-trip per key, merge over sibling keys, and suppress deep echoes', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			meta: { footnotes: '', color: 'blue', obj: { x: 1 } },
		} );
		// Genesis matching the record's meta (fresh instances, nested
		// object included) pushes nothing.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], {
				'meta.footnotes': '',
				'meta.color': 'blue',
				'meta.obj': { x: 1 },
			} )
		);
		expect( handlers.edits ).toHaveLength( 0 );

		// A local meta edit arrives as the FULL merged object; only the
		// changed key authors an intent.
		manager.update(
			'postType/post',
			'1',
			{ meta: { footnotes: '[1]', color: 'blue', obj: { x: 1 } } },
			'e'
		);
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ].payload ).toMatchObject( {
			name: 'meta.footnotes',
			value: '[1]',
		} );

		// A remote register change pushes ONE whole meta object, merged
		// over the locally-known values of the sibling keys.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-meta-1',
				actorId: 'u9c9',
				baseSeq: 2,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'meta.color',
					value: 'red',
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( {
			meta: { footnotes: '[1]', color: 'red', obj: { x: 1 } },
		} );

		// The editor's echo of the pushed state is inert.
		const editsBefore = handlers.edits.length;
		manager.update(
			'postType/post',
			'1',
			{ meta: { footnotes: '[1]', color: 'red', obj: { x: 1 } } },
			'e'
		);
		expect( transport.captured.sent ).toHaveLength( 1 );
		expect( handlers.edits ).toHaveLength( editsBefore );
	} );

	it( 'meta: the persisted-CRDT key never captures, and an orphaned register never pushes', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			meta: { known: 'a' },
		} );
		// The room carries a register for a key this post does not have
		// registered (absent from its record meta): pushing it would mark
		// the post permanently dirty.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], {
				'meta.known': 'a',
				'meta.unknown_key': 'x',
			} )
		);
		expect( handlers.edits ).toHaveLength( 0 );

		// The persisted-CRDT snapshot key is transport state, not content.
		manager.update(
			'postType/post',
			'1',
			{ meta: { known: 'a', _crdt_document: 'blob' } },
			'e'
		);
		expect( transport.captured.sent ).toHaveLength( 0 );
	} );

	it( 'meta: a partial save-feed meta object merges instead of replacing the known meta', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			meta: { a: '1', b: '2' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { 'meta.a': '1', 'meta.b': '2' } )
		);

		// The post-save server-mutation feed sends only mutated subkeys.
		manager.update( 'postType/post', '1', { meta: { a: '9' } }, 'e' );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ].payload ).toMatchObject( {
			name: 'meta.a',
			value: '9',
		} );

		// A remote change to the OTHER key pushes a merge that kept both
		// the partial arrival and the untouched sibling.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-meta-b',
				actorId: 'u9c9',
				baseSeq: 2,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'meta.b',
					value: '3',
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( handlers.edits.at( -1 ) ).toEqual( {
			meta: { a: '9', b: '3' },
		} );
	} );

	it( 'properties: a malformed (non-scalar) remote register value is never pushed', async () => {
		const { handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Original' },
		} );
		transport.captured.session!.receiveUpdate(
			snapshotRow( [], { title: { nested: 'object' } } )
		);
		expect(
			handlers.edits.filter(
				( edit ) => 'title' in ( edit as Record< string, unknown > )
			)
		).toHaveLength( 0 );
	} );

	async function loadManagedCollection() {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );

		const manager = createIntentLogManager();
		const refetchRecords = jest.fn( async () => {} );
		await manager.loadCollection( {} as never, 'taxonomy/category', {
			onStatusChange: jest.fn() as never,
			refetchRecords: refetchRecords as never,
		} );
		return { manager, refetchRecords, transport };
	}

	it( 'collections: a peer save signal triggers a refetch; own saves announce without refetching', async () => {
		const { manager, refetchRecords, transport } =
			await loadManagedCollection();

		// Bootstrap (empty collection genesis) sets the baseline silently.
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );
		expect( refetchRecords ).not.toHaveBeenCalled();

		// A peer's save register write means "a term changed; refetch".
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'peer-save-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'savedAt:u9c9',
					value: 1,
					observedVersion: 0,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( refetchRecords ).toHaveBeenCalledTimes( 1 );

		// A record save on this object type announces via THIS client's
		// register (one wire intent) and does not refetch locally.
		manager.update( 'taxonomy/category', '77', {}, 'o', {
			isSave: true,
		} );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ].type ).toBe( 'set_property' );
		expect( sent[ 0 ].payload.name ).toMatch( /^savedAt:/ );
		expect( sent[ 0 ].payload.name ).not.toBe( 'savedAt:u9c9' );
		expect( refetchRecords ).toHaveBeenCalledTimes( 1 );

		// A further peer bump refetches again.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'peer-save-2',
				actorId: 'u9c9',
				baseSeq: 2,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'savedAt:u9c9',
					value: 2,
					observedVersion: 1,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		expect( refetchRecords ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'collections: a save announced before the bootstrap replays once the room initializes', async () => {
		const { manager, refetchRecords, transport } =
			await loadManagedCollection();

		// The term was created while the collection room was still
		// connecting: nothing can be sent yet…
		manager.update( 'taxonomy/category', '78', {}, 'o', {
			isSave: true,
		} );
		expect( transport.captured.sent ).toHaveLength( 0 );

		// …but the signal replays on bootstrap so peers still refetch.
		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );
		const sent = transport.captured.sent.map( ( update ) =>
			JSON.parse( update.data )
		);
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ].payload.name ).toMatch( /^savedAt:/ );
		expect( refetchRecords ).not.toHaveBeenCalled();
	} );

	it( 'publishes parked proposals as conflict records with kind and author', async () => {
		const { manager, transport } = await loadManagedEntity();
		const changed = jest.fn();
		const unsubscribe = manager.conflicts.subscribe(
			'postType/post',
			'1',
			changed
		);

		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		const proposalRow = ( actorId: string, reason: string ) => ( {
			data: JSON.stringify( {
				intent: {
					intentId: `i-${ reason }`,
					txnId: null,
					type: 'insert_text',
					payload: { text: 'lost words' },
				},
				actorId,
				reason,
				context: { excerpt: 'Around here' },
			} ),
			type: INTENT_LOG_UPDATE_TYPES.PARKED,
		} );

		transport.captured.session!.receiveUpdate(
			proposalRow( 'u999c999', 'frame-conflict' )
		);
		// Listeners hear about the settled open list one microtask later.
		await Promise.resolve();
		expect( changed ).toHaveBeenCalledTimes( 1 );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'i-frame-conflict',
				kind: 'merge',
				authorId: 999,
			} ),
		] );

		// A security hold is a sequestration record.
		transport.captured.session!.receiveUpdate(
			proposalRow( 'u5c5', 'requires-approval' )
		);
		await Promise.resolve();
		expect( changed ).toHaveBeenCalledTimes( 2 );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( { id: 'i-frame-conflict' } ),
			expect.objectContaining( {
				id: 'i-requires-approval',
				kind: 'sequestration',
				authorId: 5,
			} ),
		] );
		unsubscribe();
	} );

	it( 'conflict records carry the target block identity and position when the intent addresses one', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'block-0', blockType: 'core/paragraph', text: 'A' },
				{ syncId: 'block-a', blockType: 'core/paragraph', text: 'B' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-anchored',
					txnId: null,
					type: 'insert_text',
					payload: { syncId: 'block-a', text: 'lost' },
				},
				'u9c9'
			)
		);
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'p-anchored',
				target: {
					type: 'blocks',
					ids: [ 'block-a' ],
					parentId: undefined,
					index: 1,
					count: 1,
				},
			} ),
		] );

		// Document-level intents (entity properties) target the property.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-property',
					txnId: null,
					type: 'set_property',
					payload: { name: 'title', value: 'Lost title' },
				},
				'u9c9',
				'property-conflict'
			)
		);
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( { id: 'p-anchored' } ),
			expect.objectContaining( {
				id: 'p-property',
				target: { type: 'property', name: 'title' },
			} ),
		] );
	} );

	it( 'a parked insert_block proposal targets the position after its anchor sibling', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Anchor',
				},
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'ins-1',
					txnId: null,
					type: 'insert_block',
					payload: {
						block: {
							syncId: 'nb',
							blockType: 'core/html',
							fields: {
								content: {
									text: '￼',
									formats: [
										{
											start: 0,
											end: 1,
											format: 'obj|{"html":"<script>x</script>"}',
										},
									],
								},
							},
						},
						parentId: null,
						afterSiblingId: 'p1',
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await Promise.resolve();

		// An insertion targets the slot after 'p1' with a count of 0 (no
		// block exists yet), and its summary carries the DECODED markup
		// (not the object-replacement char).
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'ins-1',
				kind: 'sequestration',
				target: {
					type: 'blocks',
					parentId: undefined,
					index: 1,
					count: 0,
				},
				proposed: expect.stringContaining( '<script>x</script>' ),
			} ),
		] );
	} );

	it( 'a proposal resolved within the same delivery batch never opens, and a decision round-trips', async () => {
		const { manager, transport } = await loadManagedEntity();
		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );

		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		// Bootstrap replay shape: parked row immediately followed by its
		// resolution row (a long-resolved conflict).
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'old-1',
					txnId: null,
					type: 'insert_text',
					payload: { text: 'ancient' },
				},
				'u9c9'
			)
		);
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				proposalId: 'old-1',
				resolution: 'dismissed',
			} ),
			type: INTENT_LOG_UPDATE_TYPES.RESOLVED,
		} );
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );

		// A live open proposal opens a record. Dismissing it emits the
		// wire row and empties the list.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'live-1',
					txnId: null,
					type: 'insert_text',
					payload: { text: 'fresh' },
				},
				'u9c9'
			)
		);
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );

		manager.conflicts.resolveConflict( 'postType/post', '1', 'live-1', {
			action: 'dismiss',
		} );
		const resolvedRows = transport.captured.sent.filter(
			( update ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === update.type
		);
		expect( resolvedRows ).toHaveLength( 1 );
		expect( JSON.parse( resolvedRows[ 0 ].data ) ).toEqual( {
			proposalId: 'live-1',
			resolution: 'dismissed',
		} );
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a parked text edit carries its base, proposed, and current sides', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		// A collaborator's edit landed first...
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 5,
					text: ' there',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		// ...and another author's edit against the same base parked.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await Promise.resolve();

		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( conflict ).toMatchObject( {
			id: 'parked-1',
			kind: 'merge',
			authorId: 8,
			target: { type: 'blocks', ids: [ 'p1' ], index: 0, count: 1 },
		} );
		expect( textOf( conflict.base ) ).toEqual( [ 'Hello' ] );
		expect( textOf( conflict.proposed ) ).toEqual( [ 'Hello friend' ] );
		expect( textOf( conflict.current ) ).toEqual( [ 'Hello there' ] );
	} );

	it( "publishes a record again when a collaborator's edit changes its current side, and refuses a decision made against the older one", async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await Promise.resolve();

		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );
		// The reviewer opens the dialog on this record.
		const [ seen ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( textOf( seen.current ) ).toEqual( [ 'Hello' ] );

		// A collaborator edits the block while the dialog is open. No
		// proposal opens or closes.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 5,
					text: ' there',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		await Promise.resolve();

		// The listeners hear about it, and the record shows the edit.
		expect( changed ).toHaveBeenCalledTimes( 1 );
		const [ fresh ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( textOf( fresh.current ) ).toEqual( [ 'Hello there' ] );

		// A decision made against the older current side is refused:
		// nothing is sent, and the record stays open.
		transport.captured.sent.length = 0;
		const replacement = JSON.stringify( [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello friend',
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
			},
		] );
		// The refusal is the conflict registry's, against the record the
		// engine publishes; the engine is never asked.
		registerConflictSource( manager.conflicts );
		await expect(
			registryResolveConflict( 'postType/post', '1', seen.id, {
				action: 'accept',
				content: replacement,
				current: seen.current,
			} )
		).resolves.toBe( 'stale' );
		expect( transport.captured.sent ).toEqual( [] );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );

		// The same decision against the current side as it is now goes
		// through.
		expect(
			manager.conflicts.resolveConflict( 'postType/post', '1', fresh.id, {
				action: 'accept',
				content: replacement,
				current: fresh.current,
			} )
		).toBe( 'resolved' );
		expect(
			transport.captured.sent.some(
				( update ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === update.type
			)
		).toBe( true );
	} );

	it( 'says nothing when a document change leaves every record as it was', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Other' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await Promise.resolve();
		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );
		manager.conflicts.getOpenConflicts( 'postType/post', '1' );

		// An edit to ANOTHER block: the record reads the same.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p2',
					field: 'content',
					offset: 5,
					text: ' words',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		await Promise.resolve();

		expect( changed ).not.toHaveBeenCalled();
	} );

	it( 'accept authors the replacement as ordinary intents, then closes every member, in that order', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		// Two parked keystrokes on the same block: one record.
		for ( const [ intentId, offset, text ] of [
			[ 'k1', 5, '!' ],
			[ 'k2', 6, '?' ],
		] as Array< [ string, number, string ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: null,
						type: 'insert_text',
						payload: {
							syncId: 'p1',
							field: 'content',
							offset,
							text,
						},
					},
					'u8c8'
				)
			);
		}
		await Promise.resolve();
		const open = manager.conflicts.getOpenConflicts( 'postType/post', '1' );
		expect( open ).toHaveLength( 1 );
		transport.captured.sent.length = 0;

		// The reviewer's merged result keeps the block's identity.
		const replacement = JSON.stringify( [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello, merged',
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
			},
		] );
		manager.conflicts.resolveConflict( 'postType/post', '1', open[ 0 ].id, {
			action: 'accept',
			content: replacement,
		} );

		const sent = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const firstResolution = sent.findIndex(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		const intents = sent.filter(
			( row ) => INTENT_LOG_UPDATE_TYPES.INTENT === row.type
		);
		// The replacement is an ordinary edit of the SAME block, under one
		// txn, and every intent precedes every resolution.
		expect( intents.length ).toBeGreaterThan( 0 );
		expect(
			intents.every( ( row ) => 'p1' === row.decoded.payload.syncId )
		).toBe( true );
		expect(
			new Set( intents.map( ( row ) => row.decoded.txnId ) ).size
		).toBe( 1 );
		expect( intents[ 0 ].decoded.txnId ).toEqual( expect.any( String ) );
		expect( firstResolution ).toBe( intents.length );
		expect(
			sent.slice( firstResolution ).map( ( row ) => row.decoded )
		).toEqual( [
			{ proposalId: 'k1', resolution: 'dismissed' },
			{ proposalId: 'k2', resolution: 'dismissed' },
		] );

		// The document holds the merged text, and the record is closed.
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root[ 0 ].fields.content.text ).toBe( 'Hello, merged' );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a record over two blocks that are not neighbours shows the block between them, and accept keeps the order', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
				{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
			] )
		);
		// One edit by another author changed the first and the third
		// paragraph, and was set aside.
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await Promise.resolve();

		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		// This record's sides hold several serialized runs.
		const textOfRuns = ( side: string | null ) =>
			JSON.parse( `[${ ( side ?? '' ).split( '\n\n' ).join( ',' ) }]` )
				.flat()
				.map(
					( block: { attributes: { content: string } } ) =>
						block.attributes.content
				);
		expect( conflict.target ).toMatchObject( {
			type: 'blocks',
			ids: [ 'p1', 'p2', 'p3' ],
			index: 0,
			count: 3,
		} );
		expect( textOfRuns( conflict.current ) ).toEqual( [
			'One',
			'Two',
			'Three',
		] );
		expect( textOfRuns( conflict.proposed ) ).toEqual( [
			'One!',
			'Two',
			'Three!',
		] );

		// The reviewer accepts a merged result of all three blocks.
		const merged = ( syncId: string, content: string ) => ( {
			name: 'core/paragraph',
			attributes: { content, metadata: { syncId } },
			innerBlocks: [],
		} );
		const outcome = manager.conflicts.resolveConflict(
			'postType/post',
			'1',
			conflict.id,
			{
				action: 'accept',
				content: JSON.stringify( [
					merged( 'p1', 'One, merged' ),
					merged( 'p2', 'Two' ),
					merged( 'p3', 'Three, merged' ),
				] ),
				current: conflict.current,
			}
		);
		expect( outcome ).toBe( 'resolved' );

		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect(
			doc.root.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p1:One, merged', 'p2:Two', 'p3:Three, merged' ] );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a record over a block and a block inside a group covers the group, and accept keeps the inner block in it', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{
					syncId: 'g',
					blockType: 'core/group',
					children: [
						{
							syncId: 'p3',
							blockType: 'core/paragraph',
							text: 'Three',
						},
					],
				},
			] )
		);
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await Promise.resolve();
		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( conflict.target ).toMatchObject( {
			ids: [ 'p1', 'g' ],
			index: 0,
			count: 2,
		} );

		// The reviewer takes the proposed side as it is. (The stand-in
		// parser reads one JSON list, the sides are one list per block.)
		const proposed = JSON.stringify(
			conflict.proposed
				.split( '\n\n' )
				.flatMap( ( block ) => JSON.parse( block ) )
		);
		manager.conflicts.resolveConflict( 'postType/post', '1', conflict.id, {
			action: 'accept',
			content: proposed,
		} );

		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root.map( ( block ) => block.syncId ) ).toEqual( [
			'p1',
			'g',
		] );
		expect( doc.root[ 0 ].fields.content.text ).toBe( 'One!' );
		expect(
			doc.root[ 1 ].children.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p3:Three!' ] );
	} );

	it( 'an accepted result may leave out a block from between the two blocks, because the reviewer saw it', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
				{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
				{ syncId: 'p4', blockType: 'core/paragraph', text: 'Four' },
			] )
		);
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await Promise.resolve();
		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);

		manager.conflicts.resolveConflict( 'postType/post', '1', conflict.id, {
			action: 'accept',
			content: JSON.stringify( [
				{
					name: 'core/paragraph',
					attributes: {
						content: 'One and three',
						metadata: { syncId: 'p1' },
					},
					innerBlocks: [],
				},
			] ),
		} );

		// The run is replaced as one piece. The block after it stays.
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect(
			doc.root.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p1:One and three', 'p4:Four' ] );
	} );

	it( "accept with empty content removes the record's block", async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Keep' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Drop' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p2',
						field: 'content',
						offset: 4,
						text: '!',
					},
				},
				'u8c8'
			)
		);
		await Promise.resolve();

		manager.conflicts.resolveConflict( 'postType/post', '1', 'parked-1', {
			action: 'accept',
			content: '',
		} );
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root.map( ( block ) => block.syncId ) ).toEqual( [ 'p1' ] );
	} );

	it( 'accept of a post-field record authors one set_property at the observed version, then closes the record', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Original' },
		} );
		const session = transport.captured.session as IntentLogSession;
		session.receiveUpdate( snapshotRow( [], { title: 'Original' } ) );
		// A collaborator's title landed first...
		session.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-title-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'title',
					value: 'Winning title',
					observedVersion: 0,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		// ...and another author's title against the same base parked.
		session.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-title',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'set_property',
					payload: {
						name: 'title',
						value: 'Set-aside title',
						observedVersion: 0,
					},
				},
				'u8c8',
				'property-conflict'
			)
		);
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'p-title',
				target: { type: 'property', name: 'title' },
			} ),
		] );
		const observedVersion = session.getDocument()!.propVersions!.title;
		expect( observedVersion ).toBeGreaterThan( 0 );
		transport.captured.sent.length = 0;

		manager.conflicts.resolveConflict( 'postType/post', '1', 'p-title', {
			action: 'accept',
			content: 'Merged title',
		} );

		// One property write that has seen the current title, then the
		// closure behind it.
		const sent = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		expect( sent ).toEqual( [
			{
				type: INTENT_LOG_UPDATE_TYPES.INTENT,
				decoded: expect.objectContaining( {
					type: 'set_property',
					payload: {
						name: 'title',
						value: 'Merged title',
						observedVersion,
					},
				} ),
			},
			{
				type: INTENT_LOG_UPDATE_TYPES.RESOLVED,
				decoded: { proposalId: 'p-title', resolution: 'dismissed' },
			},
		] );

		// The document and the reviewer's editor hold the accepted title,
		// and the record is closed.
		expect( session.getDocument()!.props!.title ).toBe( 'Merged title' );
		expect( handlers.edits.at( -1 ) ).toEqual( { title: 'Merged title' } );
		await Promise.resolve();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'restoreProposal re-authors lost text at the current head, then resolves', async () => {
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Existing text',
				},
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'lost-1',
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 4,
						text: ' recovered',
					},
				},
				'u9c9'
			)
		);
		await Promise.resolve();

		manager.restoreProposal!( 'postType/post', '1', 'lost-1' );

		// The recovered text was authored as an ORDINARY intent at the end
		// of the target field, and the proposal closed as restored.
		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'insert_text' === row.decoded.type
		);
		expect( authored!.decoded.payload ).toMatchObject( {
			syncId: 'p1',
			field: 'content',
			offset: 'Existing text'.length,
			text: ' recovered',
		} );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'lost-1',
			resolution: 'restored',
		} );
		// The restored content reached the editor push path.
		const lastBlocks = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: { content: string } } >;
		};
		expect( lastBlocks.blocks[ 0 ].attributes.content ).toBe(
			'Existing text recovered'
		);
	} );

	it( 'restoreProposal re-inserts a parked block under fresh identity, then resolves', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Existing text',
				},
			] )
		);
		// A requires-approval park of a raw-attr block (core/html shape).
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-html',
					txnId: null,
					type: 'insert_block',
					payload: {
						block: {
							syncId: 'nb-original',
							blockType: 'core/html',
							attrs: { content: '<script>x</script>' },
						},
						parentId: null,
						afterSiblingId: 'gone-sibling',
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await Promise.resolve();

		manager.restoreProposal!( 'postType/post', '1', 'parked-html' );

		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'insert_block' === row.decoded.type
		);
		// Re-authored under a FRESH identity (the original never applied),
		// same spec content, degraded anchor (vanished sibling → end).
		expect( authored ).toBeDefined();
		expect( authored!.decoded.payload.block.blockType ).toBe( 'core/html' );
		expect( authored!.decoded.payload.block.attrs ).toEqual( {
			content: '<script>x</script>',
		} );
		expect( authored!.decoded.payload.block.syncId ).not.toBe(
			'nb-original'
		);
		expect( authored!.decoded.payload.afterSiblingId ).toBe( 'p1' );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'parked-html',
			resolution: 'restored',
		} );
	} );

	it( 'restoreProposal re-authors a parked format application, then resolves', async () => {
		const { manager, transport } = await loadManagedEntity();
		// The kses lane's shape for a custom HTML block content change: the
		// placeholder character landed as safe plain text, and only the
		// format carrying the markup parked.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'h1',
					blockType: 'core/html',
					text: '￼',
				},
			] )
		);
		const format = 'obj|{"html":"<script>alert(0);</script>"}';
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-format',
					txnId: null,
					type: 'format_text',
					payload: {
						syncId: 'h1',
						field: 'content',
						start: 0,
						end: 1,
						format,
						on: true,
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await Promise.resolve();

		manager.restoreProposal!( 'postType/post', '1', 'parked-format' );

		// The format re-applies over the surviving placeholder as an
		// ORDINARY intent (carrying the restorer's capability), and the
		// proposal closes as restored.
		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'format_text' === row.decoded.type
		);
		expect( authored ).toBeDefined();
		expect( authored!.decoded.payload ).toMatchObject( {
			syncId: 'h1',
			field: 'content',
			start: 0,
			end: 1,
			format,
			on: true,
		} );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'parked-format',
			resolution: 'restored',
		} );
	} );

	it( 'attr-lane blocks (core/html) never author a wire-inexpressible undefined set_attr', async () => {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );
		const manager = createIntentLogManager();
		const handlers = makeHandlers();
		// Live resolver shape: core/html has no html/rich-text-source
		// attributes, so its content rides the ATTR lane.
		await manager.load(
			{
				richTextFields: ( name: string ) =>
					'core/html' === name ? [] : [ 'content' ],
			} as never,
			'postType/post',
			'1',
			{},
			handlers
		);
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Shared',
				},
			] )
		);
		const pushed = ( handlers.edits.at( -1 ) as { blocks: unknown[] } )
			.blocks;

		// The user adds a Custom HTML block carrying a script tag.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					...pushed,
					{
						name: 'core/html',
						attributes: { content: '<script>alert(1)</script>' },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		/*
		 * REGRESSION: a later capture pass presents the block with content
		 * normalized to an explicit undefined (role:"local" attribute
		 * artifact) and no id write-back yet. This used to derive
		 * `set_attr { value: undefined }` — JSON.stringify drops the key,
		 * the server 400s the batch, and the room's outbox wedges forever.
		 */
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					...pushed,
					{
						name: 'core/html',
						attributes: { content: undefined },
						innerBlocks: [],
					},
				],
			},
			'gutenberg'
		);

		const decoded = transport.captured.sent
			.filter(
				( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
			)
			.map( ( update ) => JSON.parse( update.data ) );
		const insert = decoded.find(
			( intent ) => 'insert_block' === intent.type
		);
		expect( insert.payload.block.blockType ).toBe( 'core/html' );
		expect( insert.payload.block.attrs.content ).toBe(
			'<script>alert(1)</script>'
		);
		// Every attr write must be expressible on the wire, and the
		// undefined artifact must not read as a removal either.
		const setAttrsMissingValue = decoded.filter(
			( intent ) =>
				'set_attr' === intent.type && ! ( 'value' in intent.payload )
		);
		expect( setAttrsMissingValue ).toEqual( [] );
		expect(
			decoded.filter( ( intent ) => 'remove_attr' === intent.type )
		).toEqual( [] );
	} );

	it( 'raw-content blocks (core/html) sync through the content field in both directions', async () => {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );
		const manager = createIntentLogManager();
		const handlers = makeHandlers();
		await manager.load(
			{
				richTextFields: ( name: string ) =>
					'core/html' === name ? [] : [ 'content' ],
				isRawContentBlock: ( name: string ) => 'core/html' === name,
				serializeRawContent: ( block: {
					innerContent?: Array< string | null >;
				} ) =>
					( block.innerContent ?? [] )
						.filter( ( f ): f is string => 'string' === typeof f )
						.join( '' ),
			} as never,
			'postType/post',
			'1',
			{},
			handlers
		);

		// INBOUND: a server-genesis-form core/html block (innerHTML in the
		// content field, the codec's obj-span form) reaches the editor as
		// innerContent.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Shared',
				},
				{
					syncId: 'h1',
					blockType: 'core/html',
					fields: {
						content: {
							text: '￼',
							formats: [
								{
									start: 0,
									end: 1,
									format: 'obj|{"html":"<marquee>hi</marquee>"}',
								},
							],
						},
					},
				},
			] )
		);
		const pushed = ( handlers.edits.at( -1 ) as { blocks: unknown[] } )
			.blocks as Array< {
			name: string;
			attributes: Record< string, unknown >;
			innerContent?: Array< string | null >;
		} >;
		expect( pushed[ 1 ].name ).toBe( 'core/html' );
		expect( pushed[ 1 ].innerContent ).toEqual( [
			'<marquee>hi</marquee>',
		] );

		// OUTBOUND: the user adds a new Custom HTML block; its innerContent
		// derives an insert_block whose spec carries the content FIELD
		// (obj-span form — the kses lane judges these spans).
		manager.update(
			'postType/post',
			'1',
			{
				blocks: [
					...pushed,
					{
						name: 'core/html',
						attributes: {},
						innerBlocks: [],
						innerContent: [ '<div class="note">new</div>' ],
					},
				],
			},
			'gutenberg'
		);
		const decoded = transport.captured.sent
			.filter(
				( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
			)
			.map( ( update ) => JSON.parse( update.data ) );
		const insert = decoded.find(
			( intent ) => 'insert_block' === intent.type
		);
		expect( insert ).toBeDefined();
		expect( insert.payload.block.blockType ).toBe( 'core/html' );
		expect( insert.payload.block.fields.content.formats[ 0 ].format ).toBe(
			'obj|{"html":"<div class=\\"note\\">new</div>"}'
		);
	} );

	it( 'classic (core/freeform) blocks hydrate to a raw content attribute', async () => {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );
		const manager = createIntentLogManager();
		const handlers = makeHandlers();
		await manager.load(
			{
				richTextFields: ( name: string ) =>
					name.startsWith( 'core/f' ) || 'core/html' === name
						? []
						: [ 'content' ],
				isRawContentBlock: ( name: string ) =>
					'core/html' === name || 'core/freeform' === name,
				serializeRawContent: ( block: {
					attributes: Record< string, unknown >;
					innerContent?: Array< string | null >;
				} ) =>
					( block.innerContent ?? [] )
						.filter( ( f ): f is string => 'string' === typeof f )
						.join( '' ) ||
					( ( block.attributes.content as string ) ?? '' ),
				hydrateRawContent: ( name: string, html: string ) =>
					'core/freeform' === name
						? { attributes: { content: html } }
						: { innerContent: [ html ] },
			} as never,
			'postType/post',
			'1',
			{},
			handlers
		);

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'f1',
					blockType: 'core/freeform',
					fields: {
						content: {
							text: '￼',
							formats: [
								{
									start: 0,
									end: 1,
									format: 'obj|{"html":"<div>classic run</div>"}',
								},
							],
						},
					},
				},
			] )
		);
		const pushed = ( handlers.edits.at( -1 ) as { blocks: unknown[] } )
			.blocks as Array< {
			name: string;
			attributes: Record< string, unknown >;
			innerContent?: Array< string | null >;
		} >;
		// Classic content re-enters through the raw content ATTRIBUTE (its
		// parser source), not innerContent.
		expect( pushed[ 0 ].name ).toBe( 'core/freeform' );
		expect( pushed[ 0 ].attributes.content ).toBe(
			'<div>classic run</div>'
		);
		expect( pushed[ 0 ].innerContent ).toBeUndefined();

		// The echo (editor handing the same tree back) derives nothing.
		manager.update(
			'postType/post',
			'1',
			{
				blocks: pushed.map( ( block ) => ( {
					...block,
					innerBlocks: [],
				} ) ),
			},
			'gutenberg'
		);
		expect( transport.captured.sent ).toHaveLength( 0 );
	} );

	it( 'unload destroys providers and the session', async () => {
		const { manager, transport } = await loadManagedEntity();
		manager.unload( 'postType/post', '1' );
		expect( transport.captured.destroyed ).toBe( true );
	} );

	it( 'REGRESSION: concurrent same-paragraph typing converges both canvases to the server document (fuzzer one-keystroke divergence)', async () => {
		/*
		 * The fuzzer's highest-frequency intent-log failure (2026-08-17,
		 * concurrency profile, 7/8 seeds): two editors type at the end of
		 * the SAME paragraph concurrently. The later burst escalates
		 * (engine rule 5 — parked for review, correct), but the loser's
		 * canvas permanently kept its first escalated keystroke while the
		 * winner's canvas never showed it: a one-character divergence that
		 * no amount of polling healed. This test drives two real managers
		 * against the frozen core's real server and requires both canvases
		 * to settle on exactly the server's materialized text.
		 */
		const paragraph = {
			blockType: 'core/paragraph',
			syncId: 'p1',
			text: 'Alpha paragraph',
		};
		const server = rebaseCreateServer(
			createDocument( [ paragraph ] )
		) as unknown as {
			log: Array< Record< string, unknown > >;
			proposals: Array< Record< string, unknown > >;
		};

		const clientA = await loadManagedEntity();
		// The framework caches provider creators module-wide; without a
		// reset the second manager would reuse client A's transport.
		resetProviderCreatorsForTesting();
		const clientB = await loadManagedEntity();
		for ( const client of [ clientA, clientB ] ) {
			client.transport.captured.session!.receiveUpdate(
				snapshotRow( [ paragraph ] )
			);
		}

		const deliveredProposals = new WeakMap< object, number >();
		/*
		 * One HTTP poll: flush the client's queued intents into the server,
		 * then deliver new accepted rows, new proposals, and the
		 * dispositions ack — the same order the polling transport uses.
		 */
		const pollCycle = ( client: typeof clientA ) => {
			const session = client.transport.captured
				.session! as IntentLogSession;
			const batch = client.transport.captured.sent
				.splice( 0 )
				.filter(
					( update ) => update.type === INTENT_LOG_UPDATE_TYPES.INTENT
				)
				.map( ( update ) => JSON.parse( update.data ) );
			const dispositions = batch.length
				? ( serverIngestBatch( server as never, batch ) as Array< {
						status: string;
						reason?: string;
				  } > )
				: [];
			const cursor = session.getSeq();
			for ( const row of server.log.slice( cursor ) ) {
				session.receiveUpdate( {
					data: JSON.stringify( row ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				} );
			}
			const seenProposals = deliveredProposals.get( session ) ?? 0;
			for ( const proposal of server.proposals.slice( seenProposals ) ) {
				session.receiveUpdate( {
					data: JSON.stringify( proposal ),
					type: INTENT_LOG_UPDATE_TYPES.PARKED,
				} );
			}
			deliveredProposals.set( session, server.proposals.length );
			if ( dispositions.length ) {
				session.receiveDispositions!(
					dispositions.map( ( disposition, index ) => ( {
						...disposition,
						intentId: batch[ index ].intentId as string,
					} ) ) as never
				);
			}
		};

		const editorTree = ( content: string ) => [
			{
				attributes: {
					content,
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
				name: 'core/paragraph',
			},
		];
		/*
		 * A typing burst: one update() per keystroke, each tree the
		 * editor's own testimony (the genesis paragraph plus what THIS
		 * user typed — pushes during a burst are superseded before they
		 * render, so peer text never appears in these trees).
		 */
		const typeBurst = ( client: typeof clientA, text: string ) => {
			for ( let i = 1; i <= text.length; i++ ) {
				client.manager.update(
					'postType/post',
					'1',
					{
						blocks: editorTree(
							`Alpha paragraph${ text.slice( 0, i ) }`
						),
					},
					'gutenberg'
				);
				jest.advanceTimersByTime( 80 );
			}
		};

		// Both users type concurrently: neither has polled since genesis.
		typeBurst( clientA, ' from-A' );
		typeBurst( clientB, ' from-B' );

		// A's poll lands first: its whole burst is accepted. B's poll then
		// ingests B's burst against A's rows — the escalation zone.
		pollCycle( clientA );
		pollCycle( clientB );

		// Let deferred capture-driven syncs run, then settle a few more
		// poll rounds so any corrective work flushes both ways.
		for ( let round = 0; round < 4; round++ ) {
			flushEditorSync();
			pollCycle( clientA );
			pollCycle( clientB );
		}
		flushEditorSync();

		const canvasText = ( client: typeof clientA ) => {
			const last = client.handlers.edits.at( -1 ) as {
				blocks: Array< { attributes: { content?: unknown } } >;
			};
			return String( last.blocks[ 0 ].attributes.content );
		};
		expect( server.log.length ).toBeGreaterThan( 0 );
		const serverHead = serverDocAtForTest(
			server as never,
			server.log.length
		);
		const serverText = (
			getBlock( serverHead, 'p1' ) as {
				fields: Record< string, { text: string } >;
			} | null
		 )?.fields.content.text;

		// Flush the manager's microtask-scheduled proposal notifications.
		await Promise.resolve();
		await Promise.resolve();

		// The losing burst (B's) escalated, the scenario's premise: a
		// parked proposal is open for review on B's side.
		expect(
			clientB.manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).not.toHaveLength( 0 );

		// Both canvases must show the server's canonical text — the
		// escalated remainder is parked for review, not on the canvas.
		expect( canvasText( clientA ) ).toBe( serverText );
		expect( canvasText( clientB ) ).toBe( serverText );
	} );
} );

describe( 'intent-log manager awareness', () => {
	afterEach( () => {
		removeFilter( FILTER, HOOK );
		resetEngineAdaptersForTesting();
		resetProviderCreatorsForTesting();
		delete window.__experimentalEnableRealTimeCollaboration;
		delete window._wpCollaborationSync;
	} );

	it( 'constructs the syncConfig awareness over a stub doc and bridges it to the wire', async () => {
		const transport = makeFakeTransport();
		window.__experimentalEnableRealTimeCollaboration = true;
		addFilter( FILTER, HOOK, () => [ transport.creator ] );

		const created: Awareness[] = [];
		const syncConfig = {
			createAwareness: ( doc: never ) => {
				const awareness = new Awareness( doc );
				created.push( awareness );
				return awareness;
			},
		} as never;

		const manager = createIntentLogManager();
		await manager.load(
			syncConfig,
			'postType/post',
			'1',
			{},
			makeHandlers()
		);

		// The typed awareness is constructed and exposed.
		expect( created ).toHaveLength( 1 );
		const awareness = manager.getAwareness( 'postType/post', '1' );
		expect( awareness ).toBe( created[ 0 ] );

		// Local presence flows to the wire payload…
		awareness!.setLocalStateField( 'collaboratorInfo', { id: 7 } );
		expect( transport.captured.session!.getLocalAwareness() ).toEqual( {
			collaboratorInfo: { id: 7 },
		} );

		// …and server states flow into the instance with a change event.
		const changes: unknown[] = [];
		awareness!.on( 'change', ( change: unknown ) =>
			changes.push( change )
		);
		transport.captured.session!.applyRemoteAwareness( {
			999: { collaboratorInfo: { id: 42 } },
		} );
		expect( awareness!.getStates().get( 999 ) ).toEqual( {
			collaboratorInfo: { id: 42 },
		} );
		expect( changes.length ).toBeGreaterThan( 0 );

		// Teardown clears the outdated-pruning interval.
		manager.unload( 'postType/post', '1' );
	} );
} );
