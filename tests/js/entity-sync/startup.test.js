/**
 * Internal dependencies
 */
import { registerPluginEntitySync } from '../../../src/entity-sync';
import {
	getEntitySyncManager,
	registerEntitySyncManager,
} from '../../../gutenberg/packages/core-data/src/entity-sync';
import { privateApis } from '@wordpress/core-data';
import { privateApis as syncApis } from '@wordpress/sync';
import { flushHeldUpdates } from '../../../src/providers/http-polling/polling-manager';

jest.mock(
	'@wordpress/core-data',
	() => ( {
		privateApis: {
			registerEntitySyncManager: jest.requireActual(
				'../../../gutenberg/packages/core-data/src/entity-sync'
			).registerEntitySyncManager,
			createDefaultEntitySyncManager: jest.fn(),
		},
	} ),
	{ virtual: true }
);
jest.mock( '@wordpress/sync', () => ( {
	privateApis: {
		registerSyncEngine: jest.fn(),
		registerSyncTransport: jest.fn(),
	},
} ) );
jest.mock( '../../../src/lock-unlock', () => ( {
	unlock: ( value ) => value,
} ) );
jest.mock( '../../../src/engines/intent-log-adapter', () => ( {
	createIntentLogEngineAdapter: () => ( { slug: 'intent-log' } ),
} ) );
jest.mock( '../../../src/engines/yjs-server-adapter', () => ( {
	createYjsServerEngineAdapter: () => ( { slug: 'yjs-server' } ),
} ) );
jest.mock( '../../../src/engines/de-rtc-adapter', () => ( {
	createDeRtcEngineAdapter: () => ( { slug: 'de-rtc' } ),
} ) );
jest.mock(
	'../../../src/providers/http-polling/http-polling-provider',
	() => ( { createHttpPollingProvider: jest.fn() } )
);
jest.mock( '../../../src/providers/sse/sse-provider', () => ( {
	createSseProvider: jest.fn(),
} ) );
jest.mock( '../../../src/providers/websocket/websocket-provider', () => ( {
	createWebSocketProvider: jest.fn(),
} ) );
jest.mock( '../../../src/providers/http-polling/polling-manager', () => ( {
	flushHeldUpdates: jest.fn( async () => {} ),
} ) );
jest.mock( '../../../src/awareness', () => ( {
	bootstrapSlowAwareness: jest.fn(),
} ) );

let base;
beforeEach( () => {
	window.__experimentalEnableRealTimeCollaboration = true;
	base = {
		load: jest.fn(),
		update: jest.fn(),
		unload: jest.fn(),
		unloadAll: jest.fn(),
		beforeSave: jest.fn(),
	};
	privateApis.createDefaultEntitySyncManager.mockReturnValue( base );
} );
afterEach( () => {
	const manager = getEntitySyncManager();
	if ( manager ) {
		registerEntitySyncManager( manager )();
		manager.unloadAll();
	}
	delete window.__experimentalEnableRealTimeCollaboration;
	jest.clearAllMocks();
} );

it( 'registers the adapter from normal startup after all engines and transports', async () => {
	require( '../../../src/index' );
	const manager = getEntitySyncManager();
	expect( manager ).toBeDefined();
	expect(
		syncApis.registerSyncEngine.mock.calls.map(
			( [ engine ] ) => engine.slug
		)
	).toEqual( [ 'intent-log', 'yjs-server', 'de-rtc' ] );
	expect(
		syncApis.registerSyncTransport.mock.calls.map(
			( [ transport ] ) => transport.slug
		)
	).toEqual( [ 'http-polling', 'websocket', 'sse' ] );
	expect(
		Math.max( ...syncApis.registerSyncTransport.mock.invocationCallOrder )
	).toBeLessThan(
		privateApis.createDefaultEntitySyncManager.mock.invocationCallOrder[ 0 ]
	);
	await manager.beforeSave(
		'postType',
		'post',
		1,
		{},
		{ isAutosave: false }
	);
	expect( base.beforeSave ).toHaveBeenCalledTimes( 1 );
	expect( flushHeldUpdates ).toHaveBeenCalledTimes( 1 );
} );

it( 'does not register when collaboration is disabled', () => {
	window.__experimentalEnableRealTimeCollaboration = false;
	const cleanup = registerPluginEntitySync();
	expect( getEntitySyncManager() ).toBeUndefined();
	expect( privateApis.createDefaultEntitySyncManager ).not.toHaveBeenCalled();
	cleanup();
} );

it( 'unregisters and releases the engine on cleanup', () => {
	const cleanup = registerPluginEntitySync();
	cleanup();
	expect( getEntitySyncManager() ).toBeUndefined();
	expect( base.unloadAll ).toHaveBeenCalledTimes( 1 );
} );

it( 'rejects a save when its flush does not finish within five seconds', async () => {
	jest.useFakeTimers();
	try {
		flushHeldUpdates.mockImplementationOnce(
			() => new Promise( () => {} )
		);
		registerPluginEntitySync();
		const save = getEntitySyncManager().beforeSave(
			'postType',
			'post',
			1,
			{},
			{ isAutosave: false }
		);
		const result = expect( save ).rejects.toThrow(
			'Collaboration updates could not be sent'
		);
		await jest.advanceTimersByTimeAsync( 5000 );
		await result;
		expect( jest.getTimerCount() ).toBe( 0 );
	} finally {
		jest.useRealTimers();
	}
} );
