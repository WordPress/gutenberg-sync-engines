/**
 * The conflict registry: a source registered after a post is already
 * being watched is read at once, and a decision reaches the source that
 * holds the record, with that source's outcome handed back.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
	getOpenConflicts,
	registerConflictSource,
	resetConflictSourcesForTesting,
	resolveConflict,
	subscribeConflicts,
} from '../../../src/review/conflicts';
import type {
	SyncConflictOutcome,
	SyncConflictSource,
} from '../../../src/review/types';
import { PARAGRAPH_CONFLICT } from './fixtures';

const POST = [ 'postType/post', '1' ] as const;
const DISMISS = { action: 'dismiss' } as const;

/**
 * A source that holds the given records and answers every decision with
 * the given outcome.
 *
 * @param ids     The ids of the records it holds.
 * @param outcome What its resolveConflict returns.
 * @return The source, with its resolveConflict as a mock.
 */
function source(
	ids: string[],
	outcome: void | SyncConflictOutcome | Promise< SyncConflictOutcome >
) {
	const resolve = jest.fn( () => outcome );
	const conflictSource: SyncConflictSource = {
		getOpenConflicts: () =>
			ids.map( ( id ) => ( { ...PARAGRAPH_CONFLICT, id } ) ),
		subscribe: () => () => {},
		resolveConflict: resolve,
	};

	return { source: conflictSource, resolve };
}

afterEach( () => {
	resetConflictSourcesForTesting();
} );

describe( 'registerConflictSource', () => {
	it( 'reads a source registered while the post is already being watched, and tells the watcher', () => {
		const listener = jest.fn();
		subscribeConflicts( ...POST, listener );
		expect( getOpenConflicts( ...POST ) ).toEqual( [] );

		registerConflictSource( source( [ 'c1' ], 'resolved' ).source );

		expect( listener ).toHaveBeenCalled();
		expect( getOpenConflicts( ...POST ).map( ( c ) => c.id ) ).toEqual( [
			'c1',
		] );
	} );
} );

describe( 'resolveConflict', () => {
	it( 'hands the decision to the source that holds the record and returns its outcome', async () => {
		const first = source( [ 'c1' ], 'resolved' );
		const second = source( [ 'c2' ], 'stale' );
		registerConflictSource( first.source );
		registerConflictSource( second.source );

		await expect( resolveConflict( ...POST, 'c2', DISMISS ) ).resolves.toBe(
			'stale'
		);
		expect( first.resolve ).not.toHaveBeenCalled();
		expect( second.resolve ).toHaveBeenCalledWith( ...POST, 'c2', DISMISS );
	} );

	it( 'waits for a source that answers once the server has', async () => {
		registerConflictSource(
			source( [ 'c1' ], Promise.resolve( 'failed' ) ).source
		);

		await expect( resolveConflict( ...POST, 'c1', DISMISS ) ).resolves.toBe(
			'failed'
		);
	} );

	it( 'refuses an accepted decision made against a current side the record no longer shows, without asking the source', async () => {
		const only = source( [ 'c1' ], 'resolved' );
		registerConflictSource( only.source );

		await expect(
			resolveConflict( ...POST, 'c1', {
				action: 'accept',
				content: 'merged',
				current: 'what the reviewer saw, since changed',
			} )
		).resolves.toBe( 'stale' );
		expect( only.resolve ).not.toHaveBeenCalled();

		await expect(
			resolveConflict( ...POST, 'c1', {
				action: 'accept',
				content: 'merged',
				current: PARAGRAPH_CONFLICT.current,
			} )
		).resolves.toBe( 'resolved' );
		expect( only.resolve ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'reads a record no source holds as resolved elsewhere', async () => {
		const only = source( [ 'c1' ], 'stale' );
		registerConflictSource( only.source );

		await expect(
			resolveConflict( ...POST, 'gone', DISMISS )
		).resolves.toBe( 'resolved' );
		expect( only.resolve ).not.toHaveBeenCalled();
	} );
} );
