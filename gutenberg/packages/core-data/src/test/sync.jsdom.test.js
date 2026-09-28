import { afterEach, describe, expect, it, vi } from 'vitest';
const { mockSyncManager, mockCreateManager, mockResolveEngineAdapter } =
	vi.hoisted( () => {
		const manager = {};
		const createManager = vi.fn( () => manager );
		const resolveEngineAdapter = vi.fn( () => ( { createManager } ) );
		return {
			mockSyncManager: manager,
			mockCreateManager: createManager,
			mockResolveEngineAdapter: resolveEngineAdapter,
		};
	} );

vi.mock( '@wordpress/sync', () => ( {
	privateApis: {
		resolveEngineAdapter: mockResolveEngineAdapter,
	},
} ) );

vi.mock( '../lock-unlock', () => ( {
	unlock: ( privateApis ) => privateApis,
} ) );

async function loadSync() {
	vi.resetModules();
	return import( '../sync' );
}

describe( 'getSyncManager', () => {
	afterEach( () => {
		delete window.__experimentalEnableRealTimeCollaboration;
		mockResolveEngineAdapter.mockClear();
		mockCreateManager.mockClear();
	} );

	it.each( [ undefined, false ] )(
		'does not create a sync manager when the real-time collaboration flag is %s',
		async ( collaborationEnabled ) => {
			window.__experimentalEnableRealTimeCollaboration =
				collaborationEnabled;
			const { getSyncManager } = await loadSync();

			expect( getSyncManager() ).toBeUndefined();
			expect( mockResolveEngineAdapter ).not.toHaveBeenCalled();
		}
	);

	it( 'creates and reuses a sync manager when real-time collaboration is enabled', async () => {
		window.__experimentalEnableRealTimeCollaboration = true;
		const { getSyncManager } = await loadSync();

		expect( getSyncManager() ).toBe( mockSyncManager );
		expect( getSyncManager() ).toBe( mockSyncManager );
		expect( mockCreateManager ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns an existing sync manager after real-time collaboration is disabled', async () => {
		window.__experimentalEnableRealTimeCollaboration = true;
		const { getSyncManager } = await loadSync();
		const existingSyncManager = getSyncManager();

		window.__experimentalEnableRealTimeCollaboration = false;

		expect( getSyncManager() ).toBe( existingSyncManager );
		expect( mockCreateManager ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'creates no sync manager and reports the engine as unavailable when no engine adapter resolves', async () => {
		window.__experimentalEnableRealTimeCollaboration = true;
		mockResolveEngineAdapter.mockReturnValueOnce( undefined );
		const { getSyncManager, isSyncEngineUnavailable } = await loadSync();

		expect( getSyncManager() ).toBeUndefined();
		expect( isSyncEngineUnavailable() ).toBe( true );
		expect( mockCreateManager ).not.toHaveBeenCalled();
		expect( console ).toHaveWarned();
	} );
} );
