/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { createEngineAdapter as createEntitySyncAdapter } from './engine-fixture';
import { createIntentLogManager } from '../../../src/engines/intent-log-manager';
import { INTENT_LOG_UPDATE_TYPES as TYPES } from '../../../src/engines/intent-log-session';
import { createDocument } from '../../../src/engines/intent-log/document';
import {
	createServer,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase';
import { getProviderCreators } from '../../../src/framework';

jest.mock( '../../../src/framework', () => ( {
	getProviderCreators: jest.fn(),
} ) );
jest.mock( '@wordpress/blocks', () => ( { getBlockType: () => undefined } ) );
jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn( async () => ( {} ) ),
} ) );

describe( 'entity sync adapter with real intent-log replicas', () => {
	const clients = [];
	beforeEach( () => {
		jest.useFakeTimers();
		window.__experimentalEnableRealTimeCollaboration = true;
		apiFetch.mockResolvedValue( {} );
	} );

	it.each( [ 'record', 'all' ] )(
		'does not open a connection after unloading %s during metadata fetch',
		async ( scope ) => {
			let release;
			apiFetch.mockReturnValue(
				new Promise( ( resolve ) => {
					release = resolve;
				} )
			);
			const destroy = jest.fn();
			const createProvider = jest.fn( async () => ( {
				destroy,
				on: () => {},
			} ) );
			getProviderCreators.mockReturnValue( [ createProvider ] );
			const adapter = createEntitySyncAdapter( {
				manager: createIntentLogManager(),
				getSyncConfig: () => ( {} ),
				flushBeforeSave: async () => {},
			} );
			clients.push( { adapter } );
			const handlers = {
				editRecord: jest.fn(),
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoStackChange: () => {},
			};
			const loading = adapter.load( 'postType', 'post', 1, {}, handlers );
			if ( scope === 'record' ) {
				adapter.unload( 'postType', 'post', 1 );
			} else {
				adapter.unloadAll();
			}
			release( {} );
			await loading;
			expect( createProvider ).not.toHaveBeenCalled();
			await adapter.load( 'postType', 'post', 1, {}, handlers );
			expect( createProvider ).toHaveBeenCalledTimes( 1 );
			adapter.unloadAll();
			expect( destroy ).toHaveBeenCalledTimes( 1 );
		}
	);
	afterEach( () => {
		clients.splice( 0 ).forEach( ( client ) => client.adapter.unloadAll() );
		jest.clearAllTimers();
		jest.useRealTimers();
		delete window.__experimentalEnableRealTimeCollaboration;
	} );

	it( 'merges two editors and undoes only the local editor change', async () => {
		const initial = { title: 'Initial', excerpt: 'Initial excerpt' };
		const document = createDocument( [], initial );
		const server = createServer( document );
		async function client() {
			const pending = [];
			let session;
			let record = { ...initial };
			const destroy = jest.fn();
			getProviderCreators.mockReturnValue( [
				async ( options ) => {
					session = options.session;
					session.onLocalUpdate( ( row ) => pending.push( row ) );
					return { destroy, on: () => {} };
				},
			] );
			const adapter = createEntitySyncAdapter( {
				manager: createIntentLogManager(),
				getSyncConfig: () => ( {} ),
				flushBeforeSave: async () => {},
			} );
			await adapter.load( 'postType', 'post', 1, record, {
				editRecord: ( changes ) => {
					record = { ...record, ...changes };
				},
				getEditedRecord: async () => record,
				refetchRecord: async () => {},
				onUndoStackChange: () => {},
			} );
			session.receiveUpdate( {
				type: TYPES.SNAPSHOT,
				data: JSON.stringify( { doc: document } ),
			} );
			const result = {
				adapter,
				session,
				pending,
				destroy,
				getRecord: () => record,
				edit: ( edits ) => {
					record = { ...record, ...edits };
					adapter.update( 'postType', 'post', 1, edits, {
						isCached: false,
						undoIgnore: false,
					} );
				},
			};
			clients.push( result );
			return result;
		}
		const a = await client();
		const b = await client();
		function exchange( peer ) {
			const batch = peer.pending
				.splice( 0 )
				.filter( ( row ) => row.type === TYPES.INTENT )
				.map( ( row ) => JSON.parse( row.data ) );
			const verdicts = batch.length
				? serverIngestBatch( server, batch )
				: [];
			for ( const row of server.log.slice( peer.session.getSeq() ) ) {
				peer.session.receiveUpdate( {
					type: TYPES.INTENT,
					data: JSON.stringify( row ),
				} );
			}
			if ( batch.length ) {
				peer.session.receiveDispositions(
					verdicts.map( ( verdict, index ) => ( {
						...verdict,
						intentId: batch[ index ].intentId,
					} ) )
				);
			}
		}
		async function settle() {
			for ( let round = 0; round < 3; round++ ) {
				exchange( a );
				exchange( b );
				await jest.advanceTimersByTimeAsync( 1500 );
			}
		}
		a.edit( { title: 'Editor A' } );
		b.edit( { excerpt: 'Editor B' } );
		await settle();
		for ( const peer of clients ) {
			expect( peer.getRecord() ).toEqual(
				expect.objectContaining( {
					title: 'Editor A',
					excerpt: 'Editor B',
				} )
			);
		}
		a.adapter.undoManager.undo();
		await settle();
		for ( const peer of clients ) {
			expect( peer.getRecord() ).toEqual(
				expect.objectContaining( {
					title: 'Initial',
					excerpt: 'Editor B',
				} )
			);
		}
		a.adapter.undoManager.redo();
		await settle();
		expect( b.getRecord().title ).toBe( 'Editor A' );
		a.adapter.unloadAll();
		expect( a.destroy ).toHaveBeenCalledTimes( 1 );
	} );
} );
