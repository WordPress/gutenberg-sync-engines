/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { createEngineAdapter } from './engine-fixture';
import { createIntentLogManager } from '../../../src/engines/intent-log-manager';
import { flushHeldUpdates } from '../../../src/providers/http-polling/polling-manager';
import { createDocument } from '../../../src/engines/intent-log/document';
import { INTENT_LOG_UPDATE_TYPES as TYPES } from '../../../src/engines/intent-log-session';

jest.mock( '../../../src/framework', () => ( {
	...jest.requireActual( '../../../gutenberg/packages/sync/src/errors' ),
	getProviderCreators: () => [
		jest
			.requireActual(
				'../../../src/providers/http-polling/http-polling-provider'
			)
			.createHttpPollingProvider(),
	],
} ) );
jest.mock( '@wordpress/blocks', () => ( { getBlockType: () => undefined } ) );
jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: Object.assign( jest.fn(), { use: jest.fn() } ),
} ) );

describe( 'local adapter with its HTTP provider', () => {
	let cleanup;
	beforeEach( () => {
		jest.useFakeTimers();
		window.__experimentalEnableRealTimeCollaboration = true;
		window._wpCollaborationSync = {
			engine: 'intent-log',
			engineProtocol: 2,
			transports: [ 'http-polling' ],
			transportProtocol: 1,
		};
	} );
	afterEach( () => {
		cleanup?.();
		cleanup = undefined;
		delete window._wpCollaborationSync;
		delete window.__experimentalEnableRealTimeCollaboration;
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	it( 'receives a snapshot and sends edits through the real HTTP request code', async () => {
		const doc = createDocument( [], { title: 'Server title' } );
		let received = false;
		apiFetch.mockImplementation( async ( request ) => {
			if ( request.path !== '/wp-sync/v1/updates' ) {
				return {};
			}
			const rows = received
				? []
				: [ { type: TYPES.SNAPSHOT, data: JSON.stringify( { doc } ) } ];
			received = true;
			return {
				rooms: request.data.rooms.map( ( { room } ) => ( {
					room,
					awareness: {},
					end_cursor: 1,
					updates: rows,
				} ) ),
			};
		} );
		const adapter = createEngineAdapter( {
			manager: createIntentLogManager(),
			getSyncConfig: () => ( {} ),
			flushBeforeSave: flushHeldUpdates,
		} );
		cleanup = () => adapter.unloadAll();
		let record = { id: 1, title: 'Initial' };
		await adapter.load( 'postType', 'post', 1, record, {
			editRecord: ( edits ) => {
				record = { ...record, ...edits };
			},
			getEditedRecord: async () => record,
			refetchRecord: async () => {},
			onUndoStackChange: () => {},
		} );
		await jest.advanceTimersByTimeAsync( 2000 );
		expect( record.title ).toBe( 'Server title' );
		record = { ...record, title: 'Local title' };
		adapter.update(
			'postType',
			'post',
			1,
			{ title: 'Local title' },
			{ isCached: false, undoIgnore: false }
		);
		const preparation = adapter.beforeSave(
			'postType',
			'post',
			1,
			{ title: 'Local title' },
			{
				persistedRecord: { id: 1, title: 'Server title' },
				isAutosave: false,
			}
		);
		await jest.advanceTimersByTimeAsync( 100 );
		await preparation;
		expect( apiFetch.use ).not.toHaveBeenCalled();
		const rooms = apiFetch.mock.calls.flatMap(
			( [ request ] ) => request.data?.rooms ?? []
		);
		expect( rooms ).toContainEqual(
			expect.objectContaining( {
				room: 'postType/post:1',
				engine: 'intent-log',
				engine_protocol: 2,
				updates: expect.arrayContaining( [
					expect.objectContaining( { type: TYPES.INTENT } ),
				] ),
			} )
		);
	} );
} );
