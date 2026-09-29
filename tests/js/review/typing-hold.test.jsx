import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { dispatch } from '@wordpress/data';
import {
	createBlock,
	getBlockTypes,
	unregisterBlockType,
} from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import { store as blockEditorStore } from '@wordpress/block-editor';
import {
	TYPING_HOLD_MAX_MS,
	TYPING_QUIET_MS,
	resetTypingTracker,
	startTypingTracker,
	useTypingHold,
} from '../../../src/review/typing-hold';

beforeAll( () => {
	registerCoreBlocks();
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

let paragraph;
let sibling;
let group;

// One keystroke in a block: the caret is in it, the editor reports
// typing, and its content changes.
const typeIn = ( block, content ) =>
	act( () => {
		dispatch( blockEditorStore ).selectBlock( block.clientId );
		dispatch( blockEditorStore ).startTyping();
		dispatch( blockEditorStore ).updateBlockAttributes( block.clientId, {
			content,
		} );
	} );

beforeEach( () => {
	jest.useFakeTimers();
	paragraph = createBlock( 'core/paragraph', { content: 'One' } );
	sibling = createBlock( 'core/paragraph', { content: 'Two' } );
	group = createBlock( 'core/group', {}, [ paragraph ] );
	dispatch( blockEditorStore ).resetBlocks( [ group, sibling ] );
	startTypingTracker();
} );

afterEach( () => {
	resetTypingTracker();
	jest.useRealTimers();
} );

describe( 'useTypingHold', () => {
	it( 'does not hold a card in a block nobody is typing in', () => {
		typeIn( sibling, 'Two and more' );

		const { result } = renderHook( () =>
			useTypingHold( paragraph.clientId, true )
		);
		expect( result.current ).toBe( false );
	} );

	it( 'holds the card while the person types and shows it at the pause', () => {
		typeIn( paragraph, 'One a' );
		const { result, rerender } = renderHook(
			( { hasRecord } ) => useTypingHold( paragraph.clientId, hasRecord ),
			{ initialProps: { hasRecord: false } }
		);
		expect( result.current ).toBe( false );

		rerender( { hasRecord: true } );
		expect( result.current ).toBe( true );

		// Every keystroke inside the quiet window extends the wait.
		act( () => {
			jest.advanceTimersByTime( TYPING_QUIET_MS - 200 );
		} );
		typeIn( paragraph, 'One an' );
		act( () => {
			jest.advanceTimersByTime( TYPING_QUIET_MS - 200 );
		} );
		expect( result.current ).toBe( true );

		act( () => {
			jest.advanceTimersByTime( 400 );
		} );
		expect( result.current ).toBe( false );
	} );

	it( 'holds a card on a container while the person types in a child', () => {
		typeIn( paragraph, 'One a' );

		const { result } = renderHook( () =>
			useTypingHold( group.clientId, true )
		);
		expect( result.current ).toBe( true );
	} );

	it( 'shows the card after the cap for someone who never pauses', () => {
		typeIn( paragraph, 'One a' );
		const { result } = renderHook( () =>
			useTypingHold( paragraph.clientId, true )
		);

		let typed = 'One a';
		for (
			let elapsed = 0;
			elapsed < TYPING_HOLD_MAX_MS - 1000;
			elapsed += 500
		) {
			act( () => {
				jest.advanceTimersByTime( 500 );
			} );
			typed += 'x';
			typeIn( paragraph, typed );
		}
		expect( result.current ).toBe( true );

		for ( let elapsed = 0; elapsed < 1500; elapsed += 500 ) {
			act( () => {
				jest.advanceTimersByTime( 500 );
			} );
			typed += 'x';
			typeIn( paragraph, typed );
		}
		expect( result.current ).toBe( false );
	} );

	it( 'keeps the card once shown, and waits again for the next record', () => {
		const { result, rerender } = renderHook(
			( { hasRecord } ) => useTypingHold( paragraph.clientId, hasRecord ),
			{ initialProps: { hasRecord: true } }
		);
		expect( result.current ).toBe( false );

		// Typing elsewhere in the tree cannot take a shown card away.
		typeIn( paragraph, 'One a' );
		rerender( { hasRecord: true } );
		expect( result.current ).toBe( false );

		rerender( { hasRecord: false } );
		typeIn( paragraph, 'One an' );
		rerender( { hasRecord: true } );
		expect( result.current ).toBe( true );
	} );
} );
