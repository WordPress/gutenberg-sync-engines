import { describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../registry';
import createReduxStore from '../redux-store';
import { observeStoreActions } from '../action-observers';

describe( 'store action observers', () => {
	it( 'observes internal thunk dispatch after the reducer and unsubscribes', async () => {
		const registry = createRegistry();
		const listener = vi.fn();
		const stop = observeStoreActions( 'test/capture', listener );
		registry.register(
			createReduxStore( 'test/capture', {
				reducer: ( state = 0, action: { type: string } ) =>
					action.type === 'ADD' ? state + 1 : state,
				actions: {
					add:
						() =>
						( {
							dispatch,
						}: {
							dispatch: ( action: { type: string } ) => void;
						} ) =>
							dispatch( { type: 'ADD' } ),
				},
				selectors: { value: ( state: number ) => state },
			} )
		);
		try {
			await registry.dispatch( 'test/capture' ).add();
			expect( listener ).toHaveBeenCalledWith(
				expect.objectContaining( {
					action: { type: 'ADD' },
					before: 0,
					after: 1,
				} )
			);
			expect( registry.select( 'test/capture' ).value() ).toBe( 1 );
			stop();
			listener.mockClear();
			await registry.dispatch( 'test/capture' ).add();
			expect( listener ).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	} );

	it( 'keeps child registries separate and survives an observer error', async () => {
		const parent = createRegistry();
		const child = createRegistry( {}, parent );
		const listener = vi.fn();
		const stop = observeStoreActions( 'test/context', listener );
		const stopBroken = observeStoreActions( 'test/context', () => {
			throw new Error( 'observer' );
		} );
		const descriptor = createReduxStore( 'test/context', {
			reducer: ( state = 0, action: { type: string } ) =>
				action.type === 'ADD' ? state + 1 : state,
			actions: { add: () => ( { type: 'ADD' } ) },
			selectors: { value: ( state: number ) => state },
		} );
		parent.register( descriptor );
		child.register( descriptor );
		try {
			await child.dispatch( descriptor ).add();
			expect( child.select( descriptor ).value() ).toBe( 1 );
			expect( parent.select( descriptor ).value() ).toBe( 0 );
			expect(
				listener.mock.calls
					.at( -1 )?.[ 0 ]
					.registry.select( descriptor )
					.value()
			).toBe( 1 );
			expect( console ).toHaveErroredWith(
				'Store action observer failed',
				expect.any( Error )
			);
		} finally {
			stop();
			stopBroken();
		}
	} );
} );
