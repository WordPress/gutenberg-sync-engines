/**
 * The fan-out source hands a decision to the engine instance that holds
 * the record, and hands that instance's outcome back unchanged.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { createConflictFanOut } from '../../../src/review/fan-out';
import type {
	SyncConflictOutcome,
	SyncConflictSource,
} from '../../../src/review/types';
import { PARAGRAPH_CONFLICT } from './fixtures';

const DISMISS = { action: 'dismiss' } as const;

/**
 * An engine instance that holds the given records and answers every
 * decision with the given outcome.
 *
 * @param ids     The ids of the records it holds.
 * @param outcome What its resolveConflict returns.
 * @return The instance, with its resolveConflict as a mock.
 */
function instance(
	ids: string[],
	outcome: void | SyncConflictOutcome | Promise< SyncConflictOutcome >
) {
	const resolveConflict = jest.fn( () => outcome );
	const source: SyncConflictSource = {
		getOpenConflicts: () =>
			ids.map( ( id ) => ( { ...PARAGRAPH_CONFLICT, id } ) ),
		subscribe: () => () => {},
		resolveConflict,
	};

	return { source, resolveConflict };
}

describe( 'createConflictFanOut', () => {
	it( 'returns the outcome the instance answered with', () => {
		const fanOut = createConflictFanOut();
		fanOut.add( instance( [ 'c1' ], 'stale' ).source );

		expect(
			fanOut.source.resolveConflict( 'postType/post', '1', 'c1', DISMISS )
		).toBe( 'stale' );
	} );

	it( 'returns the promise an instance answers with once the server has', async () => {
		const fanOut = createConflictFanOut();
		fanOut.add( instance( [ 'c1' ], Promise.resolve( 'failed' ) ).source );

		await expect(
			fanOut.source.resolveConflict( 'postType/post', '1', 'c1', DISMISS )
		).resolves.toBe( 'failed' );
	} );

	it( 'hands the decision to the instance that holds the record', () => {
		const fanOut = createConflictFanOut();
		const first = instance( [ 'c1' ], 'resolved' );
		const second = instance( [ 'c2' ], 'stale' );
		fanOut.add( first.source );
		fanOut.add( second.source );

		expect(
			fanOut.source.resolveConflict( 'postType/post', '1', 'c2', DISMISS )
		).toBe( 'stale' );
		expect( first.resolveConflict ).not.toHaveBeenCalled();
		expect( second.resolveConflict ).toHaveBeenCalledWith(
			'postType/post',
			'1',
			'c2',
			DISMISS
		);
	} );

	it( 'returns nothing when no instance holds the record', () => {
		const fanOut = createConflictFanOut();
		const only = instance( [ 'c1' ], 'stale' );
		fanOut.add( only.source );

		expect(
			fanOut.source.resolveConflict(
				'postType/post',
				'1',
				'gone',
				DISMISS
			)
		).toBeUndefined();
		expect( only.resolveConflict ).not.toHaveBeenCalled();
	} );
} );
