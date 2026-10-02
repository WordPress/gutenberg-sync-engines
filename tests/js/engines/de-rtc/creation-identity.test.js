/**
 * The deferred editor stamper and synchronous proposal capture must agree,
 * including when duplication copies a source block's metadata wholesale.
 */
import { afterEach, expect, it, jest } from '@jest/globals';
import {
	createDeRtcRecord,
	recordChangesFromEditor,
} from '../../../../src/engines/de-rtc/record';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content ) => JSON.parse( content ),
	__unstableSerializeAndClean: JSON.stringify,
} ) );

const originalWp = globalThis.wp;
const originalAnnouncement = window._wpCollaborationSync;
afterEach( () => {
	globalThis.wp = originalWp;
	window._wpCollaborationSync = originalAnnouncement;
} );

it.each( [
	[ false, false ],
	[ true, false ],
	[ true, true ],
] )(
	'capture and the later editor stamp agree (duplicate: %s, before source: %s)',
	async ( duplicate, beforeSource ) => {
		const sourceId = beforeSource ? 'source-client' : 'saved-id';
		const source = {
			clientId: 'source-client',
			name: 'core/paragraph',
			attributes: { metadata: { syncId: sourceId } },
			innerBlocks: [],
		};
		const created = {
			clientId: 'created-client',
			name: 'core/heading',
			attributes: {
				metadata: {
					name: 'Label',
					...( duplicate && { syncId: sourceId } ),
				},
			},
			innerBlocks: [],
		};
		const blocks = beforeSource ? [ created, source ] : [ source, created ];
		const sourceIndex = beforeSource ? 1 : 0;
		const createdIndex = beforeSource ? 0 : 1;
		const captured = recordChangesFromEditor(
			{ blocks },
			createDeRtcRecord(),
			'postType/post'
		).blocks;
		let onChange;
		const mark = jest.fn();
		globalThis.wp = {
			data: {
				subscribe: ( callback ) => {
					onChange = callback;
				},
				select: ( name ) =>
					name === 'core/editor'
						? {
								isSavingPost: () => false,
								isAutosavingPost: () => false,
								isEditedPostDirty: () => true,
						  }
						: {
								getBlockCount: () => blocks.length,
								getBlockOrder: ( root ) =>
									root
										? []
										: blocks.map(
												( block ) => block.clientId
										  ),
								getBlockAttributes: ( id ) =>
									blocks.find(
										( block ) => block.clientId === id
									).attributes,
						  },
				dispatch: () => ( {
					__unstableMarkNextChangeAsNotPersistent: mark,
					updateBlockAttributes: ( id, attributes ) => {
						Object.assign(
							blocks.find( ( block ) => block.clientId === id )
								.attributes,
							attributes
						);
					},
				} ),
			},
		};
		window._wpCollaborationSync = { engine: 'de-rtc' };
		jest.isolateModules( () => {
			require( '../../../../includes/shared/sync-id.js' );
		} );
		onChange();
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		expect( captured[ sourceIndex ] ).toBe( source );
		expect(
			captured[ createdIndex ].attributes.metadata.syncId
		).toBeTruthy();
		expect( captured[ createdIndex ].attributes.metadata.syncId ).not.toBe(
			'saved-id'
		);
		expect( blocks ).toEqual( captured );
		expect( mark ).toHaveBeenCalledTimes( 1 );
		// Subsequent captures keep the tree, so bookkeeping settles.
		expect(
			recordChangesFromEditor(
				{ blocks },
				createDeRtcRecord(),
				'postType/post'
			).blocks
		).toBe( blocks );
	}
);

it( 'identifies code-editor blocks without waiting for a block-editor update', () => {
	const blocks = [
		{
			clientId: 'parsed-client',
			name: 'core/paragraph',
			attributes: {},
			innerBlocks: [],
		},
	];
	const captured = recordChangesFromEditor(
		{ blocks: undefined, content: JSON.stringify( blocks ) },
		createDeRtcRecord(),
		'postType/post'
	).blocks;
	expect( captured[ 0 ].attributes.metadata.syncId ).toBeTruthy();
} );
