import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { applyFilters } from '@wordpress/hooks';

// A record that keeps up with typing, on a block someone is typing in:
// the hold answers whatever it is asked to consider.
jest.mock( '../../../src/review/components/conflict-block', () => ( {
	__esModule: true,
	default: () => <p>conflict card</p>,
	useBlockConflicts: ( clientId ) => [
		{
			...jest.requireActual( './fixtures' ).PARAGRAPH_CONFLICT,
			followsTyping: 'follows' === clientId,
		},
	],
} ) );
jest.mock( '../../../src/review/components/sequestered-block', () => ( {
	__esModule: true,
	default: () => <p>held card</p>,
	useBlockSequestrations: () => [],
} ) );
jest.mock( '../../../src/review/typing-hold', () => ( {
	__esModule: true,
	useTypingHold: ( clientId, canHold ) => canHold,
} ) );

// eslint-disable-next-line import/first -- After the mocks.
import '../../../src/review/hooks/conflict-block';
// eslint-disable-next-line import/first -- After the mocks.
import '../../../src/review/hooks/sequestered-block';

const BlockEdit = () => <p>block content</p>;

describe( 'the review card filters and typing', () => {
	it( 'keep the block editable while its record follows the typing', () => {
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render( <Filtered clientId="follows" name="core/paragraph" /> );

		expect( screen.getByText( 'block content' ) ).toBeVisible();
		expect( screen.queryByText( 'conflict card' ) ).not.toBeInTheDocument();
	} );

	it( 'show the card at once when the engine does not follow the typing', () => {
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render( <Filtered clientId="plain" name="core/paragraph" /> );

		expect( screen.getByText( 'conflict card' ) ).toBeVisible();
	} );
} );
