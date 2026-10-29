import { afterAll, beforeAll } from '@jest/globals';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';

/**
 * Registers the core blocks for the tests of one file, and unregisters
 * every block type after them. The dialogs parse and render real blocks.
 */
export function withCoreBlocks() {
	beforeAll( () => {
		registerCoreBlocks();
	} );

	afterAll( () => {
		getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
	} );
}
