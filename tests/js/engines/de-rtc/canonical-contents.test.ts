/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createDeRtcCanonicalContents } from '../../../../src/engines/de-rtc/canonical-contents';

describe( 'de-rtc canonical contents', () => {
	it( 'holds nothing at first', () => {
		const contents = createDeRtcCanonicalContents();

		expect( contents.latest() ).toBeNull();
		expect( contents.get( 'v1' ) ).toBeUndefined();
	} );

	it( 'returns the newest version, also when an older one arrives later', () => {
		const contents = createDeRtcCanonicalContents();
		contents.record( 'v9', 'nine' );
		contents.record( 'v10', 'ten' );
		// A replayed genesis.
		contents.record( 'v1', 'one' );

		expect( contents.latest() ).toEqual( {
			version: 'v10',
			content: 'ten',
		} );
		expect( contents.get( 'v1' ) ).toBe( 'one' );
	} );

	it( 'keeps the last eight versions', () => {
		const contents = createDeRtcCanonicalContents();
		for ( let seq = 1; seq <= 10; seq++ ) {
			contents.record( `v${ seq }`, `content ${ seq }` );
		}

		expect( contents.get( 'v2' ) ).toBeUndefined();
		expect( contents.get( 'v3' ) ).toBe( 'content 3' );
		expect( contents.latest()?.version ).toBe( 'v10' );
	} );

	it( 'tells its listeners about a new version and about a reset', () => {
		const contents = createDeRtcCanonicalContents();
		const changed = jest.fn();
		const unsubscribe = contents.onChange( changed );

		contents.record( 'v1', 'one' );
		expect( changed ).toHaveBeenCalledTimes( 1 );

		contents.clear();
		expect( changed ).toHaveBeenCalledTimes( 2 );
		expect( contents.latest() ).toBeNull();

		// Nothing is held, so a second reset changes nothing.
		contents.clear();
		expect( changed ).toHaveBeenCalledTimes( 2 );

		unsubscribe();
		contents.record( 'v2', 'two' );
		expect( changed ).toHaveBeenCalledTimes( 2 );
	} );
} );
