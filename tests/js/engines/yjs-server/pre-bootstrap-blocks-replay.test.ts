/**
 * External dependencies
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as Y from 'yjs';
import * as buffer from 'lib0/buffer';

/**
 * Internal dependencies
 */
import { createYjsServerEngine } from '../../../../src/engines/yjs-server/engine';
import { YJS_SERVER_SNAPSHOT_TYPE } from '../../../../src/engines/yjs-server/session';
import {
	CRDT_RECORD_MAP_KEY,
	CRDT_STATE_MAP_KEY,
	CRDT_STATE_MAP_VERSION_KEY as VERSION_KEY,
} from '../../../../src/engines/yjs/constants';
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
 * buffered by the yjs-server client adapter and replayed verbatim once the
 * snapshot lands. A `blocks` edit always carries the WHOLE block tree as
 * the editor holds it — parsed from the SAVED post, with fresh clientIds —
 * so the replay merges that tree over whatever the first snapshot row
 * holds, and every difference between the two counts as the joiner's own
 * edit.
 *
 * These tests run that lane through the framework's REAL post merge
 * (`applyPostChangesToCRDTDoc` / `mergeCrdtBlocks`) and pin the current
 * behavior: a buffered tree that predates the snapshot's text deletes that
 * text and re-identifies the block. The browser-level reproduction is
 * `tests/e2e/specs/collaboration-yjs-server-late-join.spec.ts`, which also
 * shows that the editor dispatches no such edit on its own — only a person
 * typing before the snapshot lands puts one in the buffer.
 */

// A minimal block library: one paragraph type whose `content` is rich text
// (so the doc stores a Y.Text and merges by diff, as it does for real
// paragraphs) and a save() that produces the `_save` mirror.
// The subtree's `uuid` ships ESM only; the merge mints ids through it.
jest.mock( '../../../../gutenberg/node_modules/uuid/dist/index.js', () => {
	let next = 0;
	return { v4: () => `minted-${ ++next }` };
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
	return {
		getBlockType: ( name: string ) =>
			'core/paragraph' === name ? paragraphType : undefined,
		getBlockTypes: () => [ paragraphType ],
		getSaveContent: ( _type: unknown, attributes: { content: string } ) =>
			`<p>${ attributes.content }</p>`,
		parse: () => [],
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
 * The room's snapshot as a joiner receives it: the server's genesis (built
 * from the saved content) plus a peer's later edit that is NOT saved yet.
 *
 * @param genesisBlocks The blocks the server built genesis from.
 * @param liveBlocks    The blocks after the peer's unsaved edit.
 */
function roomSnapshot(
	genesisBlocks: ReturnType< typeof paragraph >[],
	liveBlocks: ReturnType< typeof paragraph >[]
) {
	const serverDoc = new Y.Doc();
	serverDoc.transact( () => {
		applyPostChangesToCRDTDoc(
			serverDoc,
			{ blocks: genesisBlocks } as any,
			SYNCED_PROPERTIES
		);
		serverDoc.getMap( CRDT_STATE_MAP_KEY ).set( VERSION_KEY, 1 );
	} );
	// The peer's unsaved edit, merged into the room after genesis.
	applyPostChangesToCRDTDoc(
		serverDoc,
		{ blocks: liveBlocks } as any,
		SYNCED_PROPERTIES
	);
	return {
		type: YJS_SERVER_SNAPSHOT_TYPE,
		data: JSON.stringify( {
			doc: buffer.toBase64( Y.encodeStateAsUpdateV2( serverDoc ) ),
		} ),
	};
}

const SAVED_CONTENT =
	'<!-- wp:paragraph -->\n<p>Existing content</p>\n<!-- /wp:paragraph -->';

describe( 'yjs-server › pre-bootstrap blocks replay (issue #57)', () => {
	let syncConfig: SyncConfig;

	beforeEach( () => {
		syncConfig = makePostSyncConfig();
	} );

	function makeEntity() {
		return createYjsServerEngine().createEntity( {
			syncConfig,
			objectType: 'postType/post',
			objectId: '1',
		} as any );
	}

	function blocksOf( entity: ReturnType< typeof makeEntity > ) {
		return (
			entity.getEditorChanges( { content: SAVED_CONTENT } as any ) as any
		 ).blocks;
	}

	it( 'a buffered parse of the SAVED content reverts a peer’s newer text and replaces block ids', () => {
		const entity = makeEntity();
		entity.hydrate( { content: SAVED_CONTENT } as any, jest.fn() );
		const session = entity.createSession();
		const sent: unknown[] = [];
		session.onLocalUpdate( ( update ) => sent.push( update ) );

		// Before the first poll answers, the editor dispatches a `blocks`
		// edit that is just the saved content parsed: fresh clientId, the
		// keys parse() attaches, none of the peer's live text.
		entity.applyLocalChanges(
			{
				blocks: [
					{
						...paragraph( 'Existing content', 'fresh-uuid-1' ),
						originalContent: '<p>Existing content</p>',
						validationIssues: [],
					},
				],
			} as any,
			'editor',
			{ isSave: false } as any
		);
		expect( sent ).toHaveLength( 0 );

		// The room snapshot lands: genesis + the peer's unsaved edit.
		const snapshot = roomSnapshot(
			[ paragraph( 'Existing content', 'server-1' ) ],
			[ paragraph( 'Existing content plus user one', 'server-1' ) ]
		);
		const roomSnapshotData = JSON.parse( snapshot.data ).doc as string;
		session.receiveUpdate( snapshot as any );

		const blocks = blocksOf( entity );
		expect( blocks ).toHaveLength( 1 );

		// The replayed stale parse won: the peer's " plus user one" is gone
		// from the document this window shows AND the document it will send.
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content'
		);
		expect( blocks[ 0 ].clientId ).toBe( 'fresh-uuid-1' );

		// And the overwrite goes on the wire: the room, after merging what
		// this window sent, carries the reverted text for everyone.
		expect( sent ).toHaveLength( 1 );
		const room = new Y.Doc();
		Y.applyUpdateV2( room, buffer.fromBase64( roomSnapshotData ) );
		Y.applyUpdateV2(
			room,
			buffer.fromBase64( ( sent[ 0 ] as { data: string } ).data )
		);
		const roomBlocks = room.getMap( CRDT_RECORD_MAP_KEY ).toJSON().blocks;
		expect( String( roomBlocks[ 0 ].attributes.content ) ).toBe(
			'Existing content'
		);
		expect( roomBlocks[ 0 ].clientId ).toBe( 'fresh-uuid-1' );
	} );

	it( 'a buffered stale tree that also carries a keystroke (no selection) still drops the peer’s text', () => {
		const entity = makeEntity();
		entity.hydrate( { content: SAVED_CONTENT } as any, jest.fn() );
		const session = entity.createSession();
		entity.applyLocalChanges(
			{
				blocks: [ paragraph( 'Existing content B', 'fresh-uuid-1' ) ],
			} as any,
			'editor',
			{ isSave: false } as any
		);
		session.receiveUpdate(
			roomSnapshot(
				[ paragraph( 'Existing content', 'server-1' ) ],
				[ paragraph( 'Existing content plus user one', 'server-1' ) ]
			) as any
		);
		const blocks = blocksOf( entity );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content B'
		);
	} );

	it( 'control: with NO buffered blocks edit, the joiner shows the peer’s newer text', () => {
		const entity = makeEntity();
		entity.hydrate( { content: SAVED_CONTENT } as any, jest.fn() );
		const session = entity.createSession();
		const sent: unknown[] = [];
		session.onLocalUpdate( ( update ) => sent.push( update ) );

		session.receiveUpdate(
			roomSnapshot(
				[ paragraph( 'Existing content', 'server-1' ) ],
				[ paragraph( 'Existing content plus user one', 'server-1' ) ]
			) as any
		);

		const blocks = blocksOf( entity );
		expect( String( blocks[ 0 ].attributes.content ) ).toBe(
			'Existing content plus user one'
		);
		expect( blocks[ 0 ].clientId ).toBe( 'server-1' );
		expect( sent ).toHaveLength( 0 );
	} );
} );
