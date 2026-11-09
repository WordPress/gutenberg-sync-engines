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
import * as Y from 'yjs';
import * as buffer from 'lib0/buffer';

/**
 * Internal dependencies
 */
import { createYjsServerEngine } from '../../../../src/engines/yjs-server/engine';
import { YJS_SERVER_SNAPSHOT_TYPE } from '../../../../src/engines/yjs-server/session';
import { SyncUpdateType } from '../../../../src/providers/http-polling/types';
import {
	CRDT_RECORD_MAP_KEY,
	CRDT_STATE_MAP_KEY,
	CRDT_STATE_MAP_VERSION_KEY as VERSION_KEY,
} from '../../../../src/engines/yjs-server/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

// The framework's real post merge, loaded from the subtree source so the
// test runs the merge the editor runs. Loaded loosely typed: a typed import
// would pull the subtree's sources into the plugin's type-check program.
const {
	applyPostChangesToCRDTDoc,
	getPostChangesFromCRDTDoc,
	// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require( '../../../../gutenberg/packages/core-data/src/utils/crdt' ) as {
	applyPostChangesToCRDTDoc: (
		doc: Y.Doc,
		changes: any,
		syncedProperties: Set< string >
	) => void;
	getPostChangesFromCRDTDoc: (
		doc: Y.Doc,
		editedRecord: any,
		syncedProperties: Set< string >
	) => any;
};

/**
 * Issue #57 — what the pre-bootstrap buffer does with a `blocks` edit.
 *
 * A window that opens a post mid-session receives the server's document
 * only after its first poll answers. Every local edit made before that is
 * buffered by the yjs-server client adapter and replayed once the snapshot
 * lands. A `blocks` edit always carries the WHOLE block tree as the editor
 * holds it — parsed from the SAVED post, with fresh clientIds — so a
 * verbatim replay would merge that tree over whatever the first snapshot
 * row holds, and every difference between the two would count as the
 * joiner's own edit: a peer's saved text inserted twice, a peer's unsaved
 * text deleted, and the block re-identified for everyone.
 *
 * The engine now applies the edit to the version of the room that shows
 * the saved post (issue #100): it rebuilds the document at each row of the
 * first response, finds the newest state whose blocks match the saved post
 * as parsed, applies the person's changes over the saved post there, and
 * adds only the result to the document, so the CRDT merges it with what
 * landed since. When no row matches (a checkpoint newer than the save),
 * only the TEXT the person typed carries over, at the same block position
 * (#57). These tests run both lanes through the framework's REAL post
 * merge (`applyPostChangesToCRDTDoc` builds the room, `mergeCrdtBlocks`
 * is what the old replay ran). The browser-level reproduction is
 * `tests/e2e/specs/collaboration-yjs-server-late-join.spec.ts`, which also
 * shows that the editor dispatches no such edit on its own — only a person
 * typing before the snapshot lands puts one in the buffer.
 */

// A minimal block library: one paragraph type whose `content` is rich text
// (so the doc stores a Y.Text and merges by diff, as it does for real
// paragraphs), a save() that produces the `_save` mirror, and a parse()
// that reads the paragraph fixture the way the editor's parser would
// (fresh clientIds, `originalContent` and `isValid` attached).
// The subtree's `uuid` ships ESM only; the merge mints ids through it.
jest.mock( '../../../../gutenberg/node_modules/uuid/dist/index.js', () => {
	let next = 0;
	return { v4: () => `minted-${ ++next }` };
} );

// The merge modules take three names from core-data's sync module, which
// otherwise loads the entity registry and, through it, the whole block
// editor (whose store cannot start under Jest). Serve those names from
// the plugin's own copies.
jest.mock( '../../../../gutenberg/packages/core-data/src/sync', () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { privateApis } = require( '@wordpress/sync' );
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { unlock } = require( '../../../../src/lock-unlock' );
	const { Delta } = unlock( privateApis );
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const constants = require( '../../../../src/engines/yjs-server/constants' );
	return {
		Delta,
		CRDT_DOC_META_PERSISTENCE_KEY: constants.CRDT_DOC_META_PERSISTENCE_KEY,
		CRDT_RECORD_MAP_KEY: constants.CRDT_RECORD_MAP_KEY,
	};
} );

// Selection history reaches into the block-editor store (editor state,
// not merge logic); stub it so the merge runs without an editor.
jest.mock(
	'../../../../gutenberg/packages/core-data/src/utils/crdt-selection',
	() => ( {
		getSelectionHistory: () => undefined,
		getShiftedSelection: ( selection: unknown ) => selection,
		updateSelectionHistory: () => {},
	} )
);

jest.mock( '@wordpress/blocks', () => {
	const paragraphType = {
		name: 'core/paragraph',
		attributes: {
			content: { type: 'rich-text', source: 'rich-text', selector: 'p' },
		},
	};
	const groupType = { name: 'core/group', attributes: {} };
	let parsed = 0;
	return {
		getBlockType: ( name: string ) =>
			(
				( {
					'core/paragraph': paragraphType,
					'core/group': groupType,
				} ) as any
			 )[ name ],
		getBlockTypes: () => [ paragraphType, groupType ],
		getSaveContent: ( _type: unknown, attributes: { content: string } ) =>
			`<p>${ attributes.content }</p>`,
		parse: ( content: string ) => {
			const paragraphs = ( html: string ) =>
				Array.from(
					html.matchAll(
						/<!-- wp:paragraph -->\n<p>(.*?)<\/p>\n<!-- \/wp:paragraph -->/g
					),
					( match ) => ( {
						clientId: `parsed-${ ++parsed }`,
						name: 'core/paragraph',
						isValid: true,
						attributes: { content: match[ 1 ] },
						innerBlocks: [],
						originalContent: `<p>${ match[ 1 ] }</p>`,
						validationIssues: [],
					} )
				);
			const group = content.match(
				/^<!-- wp:group -->\n([\s\S]*)\n<!-- \/wp:group -->$/
			);
			if ( group ) {
				return [
					{
						clientId: `parsed-${ ++parsed }`,
						name: 'core/group',
						isValid: true,
						attributes: {},
						innerBlocks: paragraphs( group[ 1 ] ),
					},
				];
			}
			return paragraphs( content );
		},
		__unstableSerializeAndClean: ( blocks: any[] ) =>
			blocks
				.map(
					( b ) =>
						`<!-- wp:paragraph -->\n<p>${ b.attributes.content }</p>\n<!-- /wp:paragraph -->`
				)
				.join( '\n\n' ),
	};
} );

const SYNCED_PROPERTIES = new Set( [ 'blocks', 'content', 'title' ] );

function paragraph( content: string, clientId: string ) {
	return {
		clientId,
		name: 'core/paragraph',
		isValid: true,
		attributes: { content },
		innerBlocks: [],
	};
}

/**
 * A paragraph as the editor holds it after parsing the saved post.
 *
 * @param content         The paragraph text the editor shows.
 * @param clientId        The editor's fresh block id.
 * @param originalContent The text the saved post held (the parse records it).
 */
function editorParagraph(
	content: string,
	clientId: string,
	originalContent = content
) {
	return {
		...paragraph( content, clientId ),
		originalContent: `<p>${ originalContent }</p>`,
		validationIssues: [],
	};
}

function savedPost( content: string ) {
	return `<!-- wp:paragraph -->\n<p>${ content }</p>\n<!-- /wp:paragraph -->`;
}

/**
 * The two outcomes of a joiner typing " B" at the end of "Existing content"
 * while a peer's " plus user one" sits in a later row: the typed text goes
 * into the snapshot row's text at that offset, the peer's row lands after,
 * and the merge orders the two concurrent insertions by client id.
 */
const CONCURRENT_ORDERS = [
	'Existing content B plus user one',
	'Existing content plus user one B',
];

/** The post entity's real sync config, minus awareness. */
function makePostSyncConfig(): SyncConfig {
	return {
		applyChangesToCRDTDoc: ( doc: Y.Doc, changes: any ) =>
			applyPostChangesToCRDTDoc( doc, changes, SYNCED_PROPERTIES ),
		getChangesFromCRDTDoc: ( doc: Y.Doc, editedRecord: any ) =>
			getPostChangesFromCRDTDoc( doc, editedRecord, SYNCED_PROPERTIES ),
	} as unknown as SyncConfig;
}

/**
 * A room as a joiner reads it: the first snapshot row (the server's
 * genesis, or a later compaction checkpoint) plus one update row holding
 * a peer's edits after that snapshot.
 *
 * @param snapshotBlocks The blocks the snapshot row holds.
 * @param liveBlocks     The blocks after the peer's later edit.
 */
function room( snapshotBlocks: any[], liveBlocks: any[] ) {
	const serverDoc = new Y.Doc();
	serverDoc.transact( () => {
		applyPostChangesToCRDTDoc(
			serverDoc,
			{ blocks: snapshotBlocks } as any,
			SYNCED_PROPERTIES
		);
		serverDoc.getMap( CRDT_STATE_MAP_KEY ).set( VERSION_KEY, 1 );
	} );
	const snapshotState = Y.encodeStateAsUpdateV2( serverDoc );
	const snapshotVector = Y.encodeStateVector( serverDoc );
	applyPostChangesToCRDTDoc(
		serverDoc,
		{ blocks: liveBlocks } as any,
		SYNCED_PROPERTIES
	);
	const tailState = Y.encodeStateAsUpdateV2( serverDoc, snapshotVector );
	return {
		snapshot: {
			type: YJS_SERVER_SNAPSHOT_TYPE,
			data: JSON.stringify( { doc: buffer.toBase64( snapshotState ) } ),
		},
		tail: {
			type: SyncUpdateType.UPDATE,
			data: buffer.toBase64( tailState ),
		},
		/**
		 * The room's blocks after the given client updates merge in.
		 *
		 * @param sent The updates the joiner's session sent.
		 */
		blocksAfter( sent: Array< { data: string } > ) {
			const merged = new Y.Doc();
			Y.applyUpdateV2( merged, Y.encodeStateAsUpdateV2( serverDoc ) );
			for ( const update of sent ) {
				Y.applyUpdateV2( merged, buffer.fromBase64( update.data ) );
			}
			return merged.getMap( CRDT_RECORD_MAP_KEY ).toJSON().blocks;
		},
	};
}

describe( 'yjs-server › pre-bootstrap blocks replay (issue #57)', () => {
	let syncConfig: SyncConfig;

	beforeEach( () => {
		jest.useFakeTimers();
		syncConfig = makePostSyncConfig();
	} );

	afterEach( () => {
		jest.useRealTimers();
	} );

	function makeEntity() {
		return createYjsServerEngine().createEntity( {
			syncConfig,
			objectType: 'postType/post',
			objectId: '1',
		} as any );
	}

	function blocksOf(
		entity: ReturnType< typeof makeEntity >,
		content: string
	) {
		return ( entity.getEditorChanges( { content } as any ) as any ).blocks;
	}

	/**
	 * Opens a session on a saved post, with the person typing before the
	 * room answers.
	 *
	 * @param saved       The saved post's paragraph text.
	 * @param typedBlocks The editor's tree after the person typed, or null
	 *                    for a buffered tree that is just the parse.
	 */
	function joinAndType(
		saved: string,
		typedBlocks: ReturnType< typeof editorParagraph >[] | null
	) {
		const entity = makeEntity();
		const content = savedPost( saved );
		entity.hydrate( { content } as any, jest.fn() );
		const session = entity.createSession();
		const sent: Array< { data: string } > = [];
		session.onLocalUpdate( ( update ) => sent.push( update as any ) );
		const onRemoteChange = jest.fn();
		entity.observe( { onRemoteChange, onPeerSave: jest.fn() } as any );

		entity.applyLocalChanges(
			{
				blocks: typedBlocks ?? [
					editorParagraph( saved, 'fresh-uuid-1' ),
				],
				content: () => '',
				selection: typedBlocks
					? {
							selectionStart: {
								clientId: 'fresh-uuid-1',
								attributeKey: 'content',
								offset: String(
									typedBlocks[ 0 ].attributes.content
								).length,
							},
							selectionEnd: {
								clientId: 'fresh-uuid-1',
								attributeKey: 'content',
								offset: String(
									typedBlocks[ 0 ].attributes.content
								).length,
							},
					  }
					: undefined,
			} as any,
			'editor',
			{ isSave: false } as any
		);
		expect( sent ).toHaveLength( 0 );
		return { entity, session, sent, content, onRemoteChange };
	}

	it( 'a buffered parse of the SAVED content changes nothing: the peer’s newer text and the block’s identity survive', () => {
		const { entity, session, sent, content } = joinAndType(
			'Existing content',
			null
		);
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const blocks = blocksOf( entity, content );
		expect( blocks ).toHaveLength( 1 );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content plus user one'
		);
		expect( blocks[ 0 ].clientId ).toBe( 'server-1' );
		// Nothing to send: the person changed nothing.
		expect( sent ).toHaveLength( 0 );
	} );

	it( 'a keystroke typed before the snapshot lands as that keystroke only, on the peer’s newer text', () => {
		const { entity, session, sent, content } = joinAndType(
			'Existing content',
			[
				editorParagraph(
					'Existing content B',
					'fresh-uuid-1',
					'Existing content'
				),
			]
		);
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		// The keystroke went into the snapshot row's text at the offset
		// the person typed it, concurrently with the peer's row, so the
		// order of the two insertions is the merge's call.
		const blocks = blocksOf( entity, content );
		const text = String( blocks[ 0 ].attributes.content );
		expect( CONCURRENT_ORDERS ).toContain( text );
		// The joiner's edit does not re-identify the block for everyone.
		expect( blocks[ 0 ].clientId ).toBe( 'server-1' );

		expect( sent ).toHaveLength( 1 );
		const roomBlocks = theRoom.blocksAfter( sent );
		expect( String( roomBlocks[ 0 ].attributes.content ) ).toBe( text );
		expect( roomBlocks[ 0 ].clientId ).toBe( 'server-1' );
	} );

	it( 'after a save mid-session (genesis older than the saved post), the saved text is not inserted a second time', () => {
		// The peer typed " plus user one" and saved; the room's genesis
		// still holds the pre-save text, the tail row holds the typing.
		const saved = 'Existing content plus user one';
		const { entity, session, sent, content } = joinAndType( saved, [
			editorParagraph( `${ saved } B`, 'fresh-uuid-1', saved ),
		] );
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( saved, 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		// What matters is that nothing is doubled; the order is the
		// merge's call, as above.
		const text = String(
			blocksOf( entity, content )[ 0 ].attributes.content
		);
		expect( CONCURRENT_ORDERS ).toContain( text );
		expect( theRoom.blocksAfter( sent )[ 0 ].attributes.content ).toBe(
			text
		);
	} );

	it( 'after the server compacted the room (first row newer than the saved post), the peer’s unsaved text is not deleted', () => {
		// The first row is a checkpoint holding two of the peer's three
		// unsaved bursts; the tail row holds the third. Nothing was saved.
		const { entity, session, sent, content } = joinAndType(
			'Existing content',
			[
				editorParagraph(
					'Existing content B',
					'fresh-uuid-1',
					'Existing content'
				),
			]
		);
		const theRoom = room(
			[ paragraph( 'Existing content plus user ', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one!!', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const blocks = blocksOf( entity, content );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content B plus user one!!'
		);
		expect( theRoom.blocksAfter( sent )[ 0 ].attributes.content ).toBe(
			'Existing content B plus user one!!'
		);
	} );

	it( 'drops the buffered tree when the loaded record has no content to compare against', () => {
		const entity = makeEntity();
		entity.hydrate( {} as any, jest.fn() );
		const session = entity.createSession();
		const sent: unknown[] = [];
		session.onLocalUpdate( ( update ) => sent.push( update ) );
		entity.applyLocalChanges(
			{
				blocks: [ paragraph( 'Existing content B', 'fresh-uuid-1' ) ],
			} as any,
			'editor',
			{ isSave: false } as any
		);
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		// Nothing to compare the tree against: the keystroke is dropped
		// rather than the tree merged, and the peer's text is intact.
		const blocks = blocksOf( entity, savedPost( 'Existing content' ) );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content plus user one'
		);
		expect( sent ).toHaveLength( 0 );
	} );

	it( 'keeps the first paragraph typed into an EMPTY post, beside a peer’s own first paragraph', () => {
		// The saved post parses to no blocks and the document holds none
		// at the first snapshot row: nothing to collide with, so the
		// buffered edit is merged as it is. A peer's paragraph in a later
		// row then lands beside it.
		const entity = makeEntity();
		entity.hydrate( { content: '' } as any, jest.fn() );
		const session = entity.createSession();
		const sent: Array< { data: string } > = [];
		session.onLocalUpdate( ( update ) => sent.push( update as any ) );
		entity.applyLocalChanges(
			{ blocks: [ paragraph( 'Hi', 'fresh-uuid-1' ) ] } as any,
			'editor',
			{ isSave: false } as any
		);
		const theRoom = room( [], [ paragraph( 'Peer', 'server-1' ) ] );
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const contents = ( blocks: any[] ) =>
			blocks
				.map( ( block ) => String( block.attributes.content ) )
				.sort();
		expect( contents( blocksOf( entity, '' ) ) ).toEqual( [
			'Hi',
			'Peer',
		] );
		expect( sent ).toHaveLength( 1 );
		expect( contents( theRoom.blocksAfter( sent ) ) ).toEqual( [
			'Hi',
			'Peer',
		] );
	} );

	it( 'keeps a paragraph split made before the snapshot, against the saved version', () => {
		const { entity, session, sent, content } = joinAndType(
			'Existing content',
			[
				editorParagraph(
					'Existing',
					'fresh-uuid-1',
					'Existing content'
				),
				editorParagraph(
					' content',
					'fresh-uuid-2',
					'Existing content'
				),
			]
		);
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		// The split is applied to the genesis (the saved version): the
		// first paragraph loses " content", which moves to a new block.
		// The peer's text was typed after "content" in the first block,
		// so the merge keeps it there; nothing is lost or doubled.
		const texts = ( blocks: any[] ) =>
			blocks.map( ( block ) => String( block.attributes.content ) );
		const blocks = blocksOf( entity, content );
		expect( texts( blocks ) ).toEqual( [
			'Existing plus user one',
			' content',
		] );
		expect( blocks[ 0 ].clientId ).toBe( 'server-1' );
		expect( texts( theRoom.blocksAfter( sent ) ) ).toEqual(
			texts( blocks )
		);
	} );

	it( 'keeps a paragraph added after the saved one, beside the peer’s newer text', () => {
		const { entity, session, sent, content } = joinAndType(
			'Existing content',
			[
				editorParagraph(
					'Existing content B',
					'fresh-uuid-1',
					'Existing content'
				),
				editorParagraph( 'New paragraph', 'fresh-uuid-2', '' ),
			]
		);
		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const blocks = blocksOf( entity, content );
		expect( blocks ).toHaveLength( 2 );
		expect( CONCURRENT_ORDERS ).toContain(
			String( blocks[ 0 ].attributes.content )
		);
		expect( String( blocks[ 1 ].attributes.content ) ).toBe(
			'New paragraph'
		);
		expect(
			theRoom
				.blocksAfter( sent )
				.map( ( block: any ) => String( block.attributes.content ) )
		).toEqual(
			blocks.map( ( block: any ) => String( block.attributes.content ) )
		);
	} );

	it( 'applies a keystroke typed inside a nested block', () => {
		const entity = makeEntity();
		const inner = ( text: string, id: string ) =>
			editorParagraph( text, id, 'Existing content' );
		const groupOf = (
			child: ReturnType< typeof paragraph >,
			id: string
		) => ( {
			clientId: id,
			name: 'core/group',
			isValid: true,
			attributes: {},
			innerBlocks: [ child ],
		} );
		const saved = `<!-- wp:group -->\n${ savedPost(
			'Existing content'
		) }\n<!-- /wp:group -->`;
		entity.hydrate( { content: saved } as any, jest.fn() );
		const session = entity.createSession();
		const sent: Array< { data: string } > = [];
		session.onLocalUpdate( ( update ) => sent.push( update as any ) );
		entity.applyLocalChanges(
			{
				blocks: [
					groupOf(
						inner( 'Existing content B', 'fresh-uuid-2' ),
						'fresh-uuid-1'
					),
				],
			} as any,
			'editor',
			{ isSave: false } as any
		);
		const theRoom = room(
			[
				groupOf(
					paragraph( 'Existing content', 'server-2' ),
					'server-1'
				),
			],
			[
				groupOf(
					paragraph( 'Existing content plus user one', 'server-2' ),
					'server-1'
				),
			]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const blocks = blocksOf( entity, saved );
		const text = String( blocks[ 0 ].innerBlocks[ 0 ].attributes.content );
		expect( CONCURRENT_ORDERS ).toContain( text );
		expect( blocks[ 0 ].innerBlocks[ 0 ].clientId ).toBe( 'server-2' );
		expect(
			theRoom.blocksAfter( sent )[ 0 ].innerBlocks[ 0 ].attributes.content
		).toBe( text );
	} );

	it( 'control: with NO buffered blocks edit, the joiner shows the peer’s newer text', () => {
		const entity = makeEntity();
		const content = savedPost( 'Existing content' );
		entity.hydrate( { content } as any, jest.fn() );
		const session = entity.createSession();
		const sent: unknown[] = [];
		session.onLocalUpdate( ( update ) => sent.push( update ) );

		const theRoom = room(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		session.receiveUpdate( theRoom.snapshot as any );
		session.receiveUpdate( theRoom.tail as any );
		// The replay waits for the rest of the first response.
		jest.runOnlyPendingTimers();

		const blocks = blocksOf( entity, content );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content plus user one'
		);
		expect( blocks[ 0 ].clientId ).toBe( 'server-1' );
		expect( sent ).toHaveLength( 0 );
	} );
} );
