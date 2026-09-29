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
} from '../../../../src/shared/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

/**
 * A minimal sync config: changes are applied as record-map keys, and editor
 * changes are the record map's JSON.
 */
function makeSyncConfig(): jest.MockedObject< SyncConfig > {
	return {
		applyChangesToCRDTDoc: jest.fn( ( doc: Y.Doc, changes: any ) => {
			const map = doc.getMap( CRDT_RECORD_MAP_KEY );
			Object.entries( changes ).forEach( ( [ key, value ] ) => {
				map.set( key, value );
			} );
		} ),
		getChangesFromCRDTDoc: jest.fn( ( doc: Y.Doc ) =>
			doc.getMap( CRDT_RECORD_MAP_KEY ).toJSON()
		),
	} as unknown as jest.MockedObject< SyncConfig >;
}

/**
 * The genesis snapshot row a yjs-server room emits: server-authored state
 * with the schema version stamped.
 * @param title
 */
function genesisRow( title = 'Server genesis' ) {
	const serverDoc = new Y.Doc();
	serverDoc.getMap( CRDT_RECORD_MAP_KEY ).set( 'title', title );
	serverDoc.getMap( CRDT_STATE_MAP_KEY ).set( VERSION_KEY, 1 );
	return {
		type: YJS_SERVER_SNAPSHOT_TYPE,
		data: JSON.stringify( {
			doc: buffer.toBase64( Y.encodeStateAsUpdateV2( serverDoc ) ),
		} ),
	};
}

describe( 'createYjsServerEngine › createEntity', () => {
	let syncConfig: jest.MockedObject< SyncConfig >;

	beforeEach( () => {
		syncConfig = makeSyncConfig();
	} );

	function makeEntity() {
		return createYjsServerEngine().createEntity( {
			syncConfig,
			objectType: 'postType/post',
			objectId: '1',
		} as any );
	}

	it( 'does NOT seed the document from the loaded record on hydrate', () => {
		const entity = makeEntity();
		const persist = jest.fn();

		entity.hydrate( { title: 'Loaded from REST' } as any, persist );

		// No seeding, no persistence request: the server owns genesis.
		expect( syncConfig.applyChangesToCRDTDoc ).not.toHaveBeenCalled();
		expect( persist ).not.toHaveBeenCalled();
	} );

	it( 'reports no editor changes before the server snapshot arrives', () => {
		const entity = makeEntity();
		entity.hydrate( {} as any, jest.fn() );

		// An empty pre-bootstrap doc must never be dispatched into the
		// editor (it would read as a mass deletion).
		expect( entity.getEditorChanges( { title: 'Loaded' } as any ) ).toEqual(
			{}
		);
		expect( syncConfig.getChangesFromCRDTDoc ).not.toHaveBeenCalled();
	} );

	it( 'buffers pre-bootstrap local changes and merges them once the snapshot lands', () => {
		const entity = makeEntity();
		entity.hydrate( {} as any, jest.fn() );
		const session = entity.createSession();

		// Typed before the first poll answered:
		entity.applyLocalChanges( { subtitle: 'Early edit' } as any, 'editor', {
			isSave: false,
		} as any );
		expect( syncConfig.applyChangesToCRDTDoc ).not.toHaveBeenCalled();

		// The genesis snapshot arrives.
		session.receiveUpdate( genesisRow() );

		// The buffered edit merged AFTER the server state.
		expect( syncConfig.applyChangesToCRDTDoc ).toHaveBeenCalledTimes( 1 );
		const changes = entity.getEditorChanges( {} as any ) as any;
		expect( changes.title ).toBe( 'Server genesis' );
		expect( changes.subtitle ).toBe( 'Early edit' );
	} );

	it( 'applies local changes immediately once bootstrapped', () => {
		const entity = makeEntity();
		entity.hydrate( {} as any, jest.fn() );
		entity.createSession().receiveUpdate( genesisRow() );

		entity.applyLocalChanges( { subtitle: 'Live edit' } as any, 'editor', {
			isSave: false,
		} as any );

		expect( syncConfig.applyChangesToCRDTDoc ).toHaveBeenCalledTimes( 1 );
		expect( ( entity.getEditorChanges( {} as any ) as any ).subtitle ).toBe(
			'Live edit'
		);
	} );

	it( 'surfaces remote changes through observers after bootstrap', () => {
		const entity = makeEntity();
		entity.hydrate( {} as any, jest.fn() );
		const session = entity.createSession();

		const onRemoteChange = jest.fn();
		entity.observe( {
			onRemoteChange,
			onPeerSave: jest.fn(),
		} as any );

		session.receiveUpdate( genesisRow() );

		expect( onRemoteChange ).toHaveBeenCalled();
	} );

	describe( 'bootstrap dirty guard', () => {
		const BLOCK_MARKUP =
			'<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->';

		function makeBootstrappedEntity() {
			const entity = makeEntity();
			entity.hydrate( {} as any, jest.fn() );
			entity.createSession().receiveUpdate( genesisRow() );
			return entity;
		}

		/**
		 * The change shape the framework's post sync config reports for a
		 * live-document remote change: doc blocks plus an injected lazy
		 * content serializer capturing them.
		 *
		 * @param serialized The string the injected serializer returns.
		 */
		function postShapedChanges( serialized: string ) {
			return {
				blocks: [ { name: 'core/paragraph' } ],
				content: () => serialized,
			};
		}

		it( 'withholds the injected content edit when doc blocks serialize identically to the record content', () => {
			const entity = makeBootstrappedEntity();
			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( BLOCK_MARKUP )
			);

			const changes = entity.getEditorChanges( {
				content: { raw: BLOCK_MARKUP },
			} as any );

			// The blocks still dispatch (transient; the editor adopts the
			// document's block identities), but the dirtying content edit
			// does not.
			expect( changes.blocks ).toBeDefined();
			expect( changes ).not.toHaveProperty( 'content' );
		} );

		it( 'accepts plain-string record content and tolerates trailing whitespace in the serialization', () => {
			const entity = makeBootstrappedEntity();
			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( `${ BLOCK_MARKUP }\n` )
			);

			const changes = entity.getEditorChanges( {
				content: BLOCK_MARKUP,
			} as any );

			expect( changes ).not.toHaveProperty( 'content' );
		} );

		it( 'keeps withholding across repeated redundant dispatches and empty change sets', () => {
			const entity = makeBootstrappedEntity();
			const editedRecord = { content: { raw: BLOCK_MARKUP } } as any;

			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( BLOCK_MARKUP )
			);
			expect(
				entity.getEditorChanges( editedRecord )
			).not.toHaveProperty( 'content' );

			// An empty change set must not disarm the guard.
			syncConfig.getChangesFromCRDTDoc.mockReturnValue( {} );
			expect( entity.getEditorChanges( editedRecord ) ).toEqual( {} );

			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( BLOCK_MARKUP )
			);
			expect(
				entity.getEditorChanges( editedRecord )
			).not.toHaveProperty( 'content' );
		} );

		it( 'passes genuine divergence through and disarms the guard permanently', () => {
			const entity = makeBootstrappedEntity();
			const editedRecord = { content: { raw: BLOCK_MARKUP } } as any;

			// A remote edit produced content the record does not have.
			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( `${ BLOCK_MARKUP }\n<!-- wp:more -->` )
			);
			const diverged = entity.getEditorChanges( editedRecord );
			expect( typeof diverged.content ).toBe( 'function' );

			// Even a later identical-looking dispatch is no longer filtered:
			// steady-state behavior is restored for the rest of the session.
			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( BLOCK_MARKUP )
			);
			const settled = entity.getEditorChanges( editedRecord );
			expect( typeof settled.content ).toBe( 'function' );
		} );

		it( 'does not withhold when the edited record already carries its own content edit', () => {
			const entity = makeBootstrappedEntity();
			syncConfig.getChangesFromCRDTDoc.mockReturnValue(
				postShapedChanges( BLOCK_MARKUP )
			);

			// Once the user edits, the record's content is a lazy serializer
			// function, not a raw string; the guard must stand aside.
			const changes = entity.getEditorChanges( {
				content: () => BLOCK_MARKUP,
			} as any );

			expect( typeof changes.content ).toBe( 'function' );
		} );

		it( 'does not withhold when other properties changed alongside blocks', () => {
			const entity = makeBootstrappedEntity();
			syncConfig.getChangesFromCRDTDoc.mockReturnValue( {
				...postShapedChanges( BLOCK_MARKUP ),
				title: 'Remote title',
			} );

			const changes = entity.getEditorChanges( {
				content: { raw: BLOCK_MARKUP },
			} as any );

			expect( typeof changes.content ).toBe( 'function' );
			expect( changes.title ).toBe( 'Remote title' );
		} );

		it( 'preserves a shifted selection when withholding the content edit', () => {
			const entity = makeBootstrappedEntity();
			const selection = { selectionStart: {}, selectionEnd: {} };
			syncConfig.getChangesFromCRDTDoc.mockReturnValue( {
				...postShapedChanges( BLOCK_MARKUP ),
				selection,
			} );

			const changes = entity.getEditorChanges( {
				content: { raw: BLOCK_MARKUP },
			} as any );

			expect( changes.selection ).toBe( selection );
			expect( changes ).not.toHaveProperty( 'content' );
		} );
	} );
} );
