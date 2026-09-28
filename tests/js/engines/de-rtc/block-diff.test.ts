/**
 * The positional block diff shared by incorporation, revert undo, and
 * authorship: compares blocks by serialized form, so the clientId every
 * parse mints never counts as a change.
 */
import { describe, expect, it, jest } from '@jest/globals';

import {
	changedBlockIndexes,
	parseCanonicalBlocks,
	serializeBlock,
} from '../../../../src/engines/de-rtc/doc-bridge';

// Like the real parser, every parse mints a fresh clientId per block;
// like the real serializer, the id never reaches the serialized form.
jest.mock( '@wordpress/blocks', () => {
	let nextClientId = 0;
	return {
		parse: ( content: string ) =>
			( content ? JSON.parse( content ) : [] ).map(
				( block: object ) => ( {
					...block,
					clientId: `client-${ ++nextClientId }`,
				} )
			),
		__unstableSerializeAndClean: (
			blocks: Array< { clientId?: string } >
		) =>
			JSON.stringify(
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				blocks.map( ( { clientId, ...block } ) => block )
			),
	};
} );

const A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const A2 = { name: 'core/paragraph', attributes: { content: 'Alpha edited' } };
const B = { name: 'core/paragraph', attributes: { content: 'Beta' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

describe( 'de-rtc positional block diff', () => {
	it( 'ignores parser-minted client ids', () => {
		const first = parseCanonicalBlocks( contentOf( A, B ) );
		const second = parseCanonicalBlocks( contentOf( A, B ) );
		expect( first[ 0 ].clientId ).not.toEqual( second[ 0 ].clientId );
		expect( serializeBlock( first[ 0 ] ) ).toEqual(
			serializeBlock( second[ 0 ] )
		);
		expect( changedBlockIndexes( first, second ) ).toEqual( [] );
	} );

	it( 'reports only the positions whose content changed', () => {
		expect(
			changedBlockIndexes(
				parseCanonicalBlocks( contentOf( A, B ) ),
				parseCanonicalBlocks( contentOf( A2, B ) )
			)
		).toEqual( [ 0 ] );
	} );

	it( 'refuses a structural difference instead of aligning by position', () => {
		expect(
			changedBlockIndexes(
				parseCanonicalBlocks( contentOf( A, B ) ),
				parseCanonicalBlocks( contentOf( B ) )
			)
		).toBeNull();
	} );
} );
