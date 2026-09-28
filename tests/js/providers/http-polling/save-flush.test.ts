/**
 * External dependencies
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Flush-before-save: an entity save waits for the held queue to go out
 * through the room first; autosaves and the sync route itself do not.
 */

type Middleware = (
	options: { path?: string; method?: string; data?: unknown },
	next: ( options: unknown ) => Promise< unknown >
) => Promise< unknown >;
let mockMiddleware: Middleware | null = null;

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: {
		use: jest.fn( ( middleware: Middleware ) => {
			mockMiddleware = middleware;
		} ),
	},
} ) );

describe( 'save-flush', () => {
	let saveFlush: typeof import('../../../../src/providers/http-polling/save-flush');

	beforeEach( () => {
		mockMiddleware = null;
		jest.isolateModules( () => {
			saveFlush = require( '../../../../src/providers/http-polling/save-flush' );
		} );
	} );

	it( 'recognizes entity saves and nothing else', () => {
		const is = saveFlush.isEntitySaveForTesting;
		expect( is( { path: '/wp/v2/posts/12', method: 'POST' } ) ).toBe(
			true
		);
		expect(
			is( { path: '/wp/v2/pages/3?_locale=user', method: 'PUT' } )
		).toBe( true );
		expect(
			is( { path: '/wp/v2/posts/12/autosaves', method: 'POST' } )
		).toBe( false );
		expect( is( { path: '/wp-sync/v1/updates', method: 'POST' } ) ).toBe(
			false
		);
		expect( is( { path: '/wp/v2/posts/12', method: 'GET' } ) ).toBe(
			false
		);
		expect( is( { path: '/wp/v2/posts', method: 'POST' } ) ).toBe( false );
	} );

	it( 'awaits the flush before an entity save and passes everything else straight through', async () => {
		const order: string[] = [];
		saveFlush.registerSaveFlush( async () => {
			order.push( 'flush' );
		} );
		expect( mockMiddleware ).not.toBeNull();
		const next = jest.fn( async () => {
			order.push( 'save' );
			return 'ok';
		} );

		await mockMiddleware!(
			{ path: '/wp/v2/posts/12', method: 'POST' },
			next
		);
		expect( order ).toEqual( [ 'flush', 'save' ] );

		order.length = 0;
		await mockMiddleware!(
			{ path: '/wp/v2/posts/12/autosaves', method: 'POST' },
			next
		);
		expect( order ).toEqual( [ 'save' ] );
	} );

	it( 'never blocks the save on a failing flush', async () => {
		saveFlush.registerSaveFlush( async () => {
			throw new Error( 'boom' );
		} );
		const next = jest.fn( async () => 'ok' );
		await expect(
			mockMiddleware!( { path: '/wp/v2/posts/12', method: 'POST' }, next )
		).resolves.toBe( 'ok' );
	} );
} );
