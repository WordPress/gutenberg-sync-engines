/**
 * How a card's decision reaches the engine: an accepted decision names the
 * current version the reviewer saw, and a decision the engine refuses as
 * stale raises a notice.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dispatch, select } from '@wordpress/data';
import { store as editorStore } from '@wordpress/editor';
import { store as noticesStore } from '@wordpress/notices';
import {
	registerConflictSource,
	resetConflictSourcesForTesting,
} from '../../../src/review/conflicts';
import { createConflictFanOut } from '../../../src/review/fan-out';
import {
	useDecideConflict,
	withSeenCurrent,
} from '../../../src/review/components/review-data';
import { PARAGRAPH_CONFLICT } from './fixtures';

const ACCEPT = { action: 'accept', content: 'merged' };

/**
 * Registers an engine that holds one open record and answers every
 * decision with the given outcome.
 *
 * @param {*} outcome What the engine's resolveConflict returns.
 * @return {Function} The engine's resolveConflict, as a mock.
 */
function registerEngine( outcome ) {
	const resolveConflict = jest.fn( () => outcome );
	registerConflictSource( {
		getOpenConflicts: () => [ PARAGRAPH_CONFLICT ],
		subscribe: () => () => {},
		resolveConflict,
	} );

	return resolveConflict;
}

function DecideButton( { decision } ) {
	const decide = useDecideConflict();

	return (
		<button onClick={ () => decide( PARAGRAPH_CONFLICT, decision ) }>
			Decide
		</button>
	);
}

const notices = () =>
	select( noticesStore )
		.getNotices()
		.map( ( notice ) => notice.content );

afterEach( () => {
	resetConflictSourcesForTesting();
	select( noticesStore )
		.getNotices()
		.forEach( ( notice ) =>
			dispatch( noticesStore ).removeNotice( notice.id )
		);
} );

describe( 'withSeenCurrent', () => {
	it( 'adds the current version the reviewer saw to an accepted decision', () => {
		expect( withSeenCurrent( PARAGRAPH_CONFLICT, ACCEPT ) ).toEqual( {
			...ACCEPT,
			current: PARAGRAPH_CONFLICT.current,
		} );
	} );

	it( 'keeps a current version the dialog named itself', () => {
		const decision = { ...ACCEPT, current: 'what the view showed' };
		expect( withSeenCurrent( PARAGRAPH_CONFLICT, decision ) ).toBe(
			decision
		);
	} );

	it( 'leaves a dismissal alone', () => {
		const decision = { action: 'dismiss' };
		expect( withSeenCurrent( PARAGRAPH_CONFLICT, decision ) ).toBe(
			decision
		);
	} );
} );

describe( 'useDecideConflict', () => {
	const click = async () => {
		const user = userEvent.setup();
		await user.click( screen.getByRole( 'button', { name: 'Decide' } ) );
		// Let the engine's answer settle.
		await act( async () => {} );
	};

	it( 'sends the decision to the engine with the current version the reviewer saw', async () => {
		const resolveConflict = registerEngine( 'resolved' );
		dispatch( editorStore ).setEditedPost( 'post', 1 );
		render( <DecideButton decision={ ACCEPT } /> );

		await click();

		expect( resolveConflict ).toHaveBeenCalledWith(
			'postType/post',
			'1',
			PARAGRAPH_CONFLICT.id,
			{ ...ACCEPT, current: PARAGRAPH_CONFLICT.current }
		);
		expect( notices() ).toEqual( [] );
	} );

	it( 'tells the reviewer when the engine refused the decision as stale', async () => {
		// The engine answers once the server has: a promise.
		registerEngine( Promise.resolve( 'stale' ) );
		dispatch( editorStore ).setEditedPost( 'post', 1 );
		render( <DecideButton decision={ ACCEPT } /> );

		await click();

		expect( notices() ).toEqual( [
			expect.stringMatching( /changed before your decision arrived/ ),
		] );
	} );

	it( 'tells the reviewer when an engine behind the fan-out refused the decision as stale', async () => {
		// de-rtc and yjs-server register through a fan-out over their
		// per-session instances. The instance's answer must come through.
		const fanOut = createConflictFanOut();
		fanOut.add( {
			getOpenConflicts: () => [ PARAGRAPH_CONFLICT ],
			subscribe: () => () => {},
			resolveConflict: () => Promise.resolve( 'stale' ),
		} );
		registerConflictSource( fanOut.source );
		dispatch( editorStore ).setEditedPost( 'post', 1 );
		render( <DecideButton decision={ ACCEPT } /> );

		await click();

		expect( notices() ).toEqual( [
			expect.stringMatching( /changed before your decision arrived/ ),
		] );
	} );

	it( 'says nothing when an engine returns nothing, which reads as resolved', async () => {
		registerEngine( undefined );
		dispatch( editorStore ).setEditedPost( 'post', 1 );
		render( <DecideButton decision={ { action: 'dismiss' } } /> );

		await click();

		expect( notices() ).toEqual( [] );
	} );
} );
