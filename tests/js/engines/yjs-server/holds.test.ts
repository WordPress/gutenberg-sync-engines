/**
 * yjs-server security holds on the client: the server's `held` rows become
 * sequestration records in the conflict review lane, and the reviewer's
 * decision travels over the REST review route.
 */

/**
 * External dependencies
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { createYjsServerEngine } from '../../../../src/engines/yjs-server/engine';
import {
	YJS_SERVER_HELD_RESOLVED_TYPE,
	YJS_SERVER_HELD_TYPE,
} from '../../../../src/engines/yjs-server/session';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: Object.assign( jest.fn(), { use: jest.fn() } ),
} ) );
// eslint-disable-next-line import/first, import/order -- After the mock.
import apiFetch from '@wordpress/api-fetch';
const apiFetchMock = apiFetch as jest.MockedFunction< any >;

function makeSyncConfig(): SyncConfig {
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
	} as unknown as SyncConfig;
}

const HELD =
	'<!-- wp:paragraph -->\n<p>Hello <script>alert(1)</script></p>\n<!-- /wp:paragraph -->';
const SANITIZED =
	'<!-- wp:paragraph -->\n<p>Hello alert(1)</p>\n<!-- /wp:paragraph -->';
const BASE = '<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->';

const heldRow = ( overrides: Record< string, unknown > = {} ) => ( {
	type: YJS_SERVER_HELD_TYPE,
	data: JSON.stringify( {
		holdId: 'h-1',
		blockId: 'kses-abcd1234-0',
		index: 0,
		held: HELD,
		sanitized: SANITIZED,
		base: BASE,
		author: 3,
		authorClientId: 101,
		at: 1000,
		...overrides,
	} ),
} );

describe( 'yjs-server security holds (client)', () => {
	let engine: ReturnType< typeof createYjsServerEngine >;

	beforeEach( () => {
		engine = createYjsServerEngine();
		apiFetchMock.mockReset();
		apiFetchMock.mockResolvedValue( {
			disposition: { status: 'resolved' },
		} );
	} );

	function makeSession() {
		const entity = engine.createEntity( {
			syncConfig: makeSyncConfig(),
			objectType: 'postType/post',
			objectId: '1',
		} as any );
		return entity.createSession();
	}

	it( 'publishes a held row as a sequestration record with its three sides', () => {
		const changed = jest.fn();
		engine.conflicts.subscribe( 'postType/post', '1', changed );
		const session = makeSession();

		session.receiveUpdate( heldRow() );

		expect( changed ).toHaveBeenCalledTimes( 1 );
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			{
				id: 'h-1',
				kind: 'sequestration',
				authorId: 3,
				target: {
					type: 'blocks',
					ids: [ 'kses-abcd1234-0' ],
					index: 0,
					count: 1,
				},
				base: BASE,
				proposed: HELD,
				current: SANITIZED,
			},
		] );
	} );

	it( 'presents a hold that left no block behind as a proposed insertion', () => {
		const session = makeSession();
		session.receiveUpdate(
			heldRow( { blockId: null, index: 2, sanitized: '', base: '' } )
		);
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )[ 0 ]
				.target
		).toEqual( { type: 'blocks', index: 2, count: 0 } );
	} );

	it( 'ignores a repeated announcement and closes on the resolved row', () => {
		const changed = jest.fn();
		engine.conflicts.subscribe( 'postType/post', '1', changed );
		const session = makeSession();

		session.receiveUpdate( heldRow() );
		// The server announces open holds again after it trims its log.
		session.receiveUpdate( heldRow() );
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );
		expect( changed ).toHaveBeenCalledTimes( 1 );

		session.receiveUpdate( {
			type: YJS_SERVER_HELD_RESOLVED_TYPE,
			data: JSON.stringify( {
				holdId: 'h-1',
				resolution: 'superseded',
			} ),
		} );
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );

		// A late repeat of a closed hold does not reopen it.
		session.receiveUpdate( heldRow() );
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'accept sends the reviewed content; dismiss sends dismissed', async () => {
		const session = makeSession();
		session.receiveUpdate( heldRow() );
		session.receiveUpdate( heldRow( { holdId: 'h-2', index: 1 } ) );

		engine.conflicts.resolveConflict( 'postType/post', '1', 'h-1', {
			action: 'accept',
			content: HELD,
		} );
		engine.conflicts.resolveConflict( 'postType/post', '1', 'h-2', {
			action: 'dismiss',
		} );
		await Promise.resolve();

		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
		expect( apiFetchMock ).toHaveBeenCalledWith( {
			method: 'POST',
			path: '/wp-sync/v1/yjs-server/resolve',
			data: {
				holdId: 'h-1',
				resolution: 'accepted',
				content: HELD,
				room: 'postType/post:1',
			},
		} );
		expect( apiFetchMock ).toHaveBeenCalledWith( {
			method: 'POST',
			path: '/wp-sync/v1/yjs-server/resolve',
			data: {
				holdId: 'h-2',
				resolution: 'dismissed',
				room: 'postType/post:1',
			},
		} );
	} );

	it( 'reopens a hold whose decision the server refused', async () => {
		apiFetchMock.mockRejectedValueOnce( new Error( 'forbidden' ) );
		const changed = jest.fn();
		engine.conflicts.subscribe( 'postType/post', '1', changed );
		const session = makeSession();
		session.receiveUpdate( heldRow() );

		engine.conflicts.resolveConflict( 'postType/post', '1', 'h-1', {
			action: 'accept',
			content: HELD,
		} );
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );

		await Promise.resolve();
		await Promise.resolve();
		expect(
			engine.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );
		expect( changed ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'leaves the document alone: review rows carry no content', () => {
		const entity = engine.createEntity( {
			syncConfig: makeSyncConfig(),
			objectType: 'postType/post',
			objectId: '1',
		} as any );
		const session = entity.createSession();
		const sent: unknown[] = [];
		session.onLocalUpdate( ( update: unknown ) => sent.push( update ) );

		session.receiveUpdate( heldRow() );
		expect( sent ).toEqual( [] );
	} );
} );
