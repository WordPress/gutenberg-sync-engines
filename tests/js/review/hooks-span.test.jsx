import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { select } from '@wordpress/data';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { ReviewSurface } from '../../../src/review/components/review-surface';

// The hold answers whatever it is asked to consider, and records which
// block it was asked about.
const mockAskedToHold = jest.fn();

// Blocks named `rest-*` are the rest of a span whose card is on block
// `first`; `rest-follows` continues a record that follows the typing.
jest.mock( '../../../src/review/components/review-data', () => ( {
	__esModule: true,
	useConflictContinuation: ( clientId ) =>
		clientId.startsWith( 'rest-' )
			? {
					conflict: {
						...jest.requireActual( './fixtures' ).SECTION_CONFLICT,
						followsTyping: 'rest-follows' === clientId,
					},
					firstClientId: 'first',
			  }
			: null,
} ) );
jest.mock( '../../../src/review/typing-hold', () => ( {
	__esModule: true,
	useTypingHold: ( clientId, canHold ) => {
		mockAskedToHold( clientId, canHold );
		return canHold;
	},
} ) );

// eslint-disable-next-line import/first -- After the mocks.
import { withSpanBlocksFolded } from '../../../src/review/hooks/span-blocks';

// The plugin's wrapper alone: the block editor package registers its own
// block-list filters, which need a real block.
const BlockListBlock = ( { clientId } ) => <p>block { clientId }</p>;
const Filtered = withSpanBlocksFolded( BlockListBlock );
const modeOf = ( clientId ) =>
	select( blockEditorStore ).getBlockEditingMode( clientId );

describe( 'the span filter', () => {
	afterEach( () => {
		mockAskedToHold.mockClear();
	} );

	it( 'leaves the rest of a span out of the canvas and disables it while the card is up', () => {
		const { unmount } = render( <Filtered clientId="rest-plain" /> );

		expect(
			screen.queryByText( 'block rest-plain' )
		).not.toBeInTheDocument();
		expect( modeOf( 'rest-plain' ) ).toBe( 'disabled' );

		unmount();
		expect( modeOf( 'rest-plain' ) ).toBe( 'default' );
	} );

	it( 'leaves a block outside every span alone', () => {
		render( <Filtered clientId="first" /> );

		expect( screen.getByText( 'block first' ) ).toBeVisible();
		expect( modeOf( 'first' ) ).toBe( 'default' );
	} );

	it( 'keeps the blocks while the card waits for typing, keyed on the card block', () => {
		render( <Filtered clientId="rest-follows" /> );

		expect( screen.getByText( 'block rest-follows' ) ).toBeVisible();
		expect( mockAskedToHold ).toHaveBeenCalledWith( 'first', true );
		expect( modeOf( 'rest-follows' ) ).toBe( 'default' );
	} );

	it( 'stands down inside a review dialog, whose editors show the sides', () => {
		render(
			<ReviewSurface>
				<Filtered clientId="rest-plain" />
			</ReviewSurface>
		);

		expect( screen.getByText( 'block rest-plain' ) ).toBeVisible();
		expect( modeOf( 'rest-plain' ) ).toBe( 'default' );
	} );
} );
