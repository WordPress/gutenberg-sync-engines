import assert from 'node:assert/strict';

import {
	cloneDocument,
	createDocument,
	getBlock,
} from '../../../../src/engines/intent-log/document.js';

/*
 * cloneDocument is a hand-rolled plain-JSON walk (NOT structuredClone —
 * wp-admin replaces the native one with a slow polyfill; issue #37). These
 * tests pin the properties the engine relies on: a faithful deep copy of
 * every document shape, with no sharing between clone and original.
 */

const richDoc = () =>
	createDocument(
		[
			{
				syncId: 't1',
				blockType: 'core/table',
				// Nested arrays-of-objects, the table shape that made
				// per-intent clones expensive.
				attrs: {
					caption: 'A table',
					body: [
						{
							cells: [
								{ content: 'Cell 1', tag: 'td' },
								{ content: 'Cell 2', tag: 'td' },
							],
						},
					],
				},
				fields: {
					content: {
						text: 'Cell 1Cell 2',
						formats: [ { start: 0, end: 6, format: 'core/bold' } ],
					},
					caption: { text: 'A table', formats: [] },
				},
			},
			{
				syncId: 'g1',
				blockType: 'core/group',
				children: [
					{
						syncId: 'p1',
						blockType: 'core/paragraph',
						text: 'Nested paragraph',
					},
				],
			},
		],
		{
			title: 'Post title',
			tags: [ 3, 5 ],
			'meta.count': { nested: { value: 7 } },
		}
	);

describe( 'cloneDocument', () => {
	it( 'produces a deep-equal copy of every document shape', () => {
		const doc = richDoc();
		doc.propVersions.title = 2;
		const clone = cloneDocument( doc );
		assert.deepEqual( clone, doc );
	} );

	it( 'shares nothing with the original', () => {
		const doc = richDoc();
		const clone = cloneDocument( doc );

		// Mutate the clone at every level of nesting…
		const table = getBlock( clone, 't1' );
		table.attrs.body[ 0 ].cells[ 0 ].content = 'Changed';
		table.attrs.body.push( { cells: [] } );
		table.fields.content.text = 'Changed';
		table.fields.content.formats[ 0 ].end = 99;
		table.fields.content.formats.push( {
			start: 1,
			end: 2,
			format: 'core/italic',
		} );
		getBlock( clone, 'p1' ).fields.content.text = 'Changed';
		clone.root.pop();
		clone.props.tags.push( 9 );
		clone.props[ 'meta.count' ].nested.value = 8;
		clone.propVersions.title = 5;

		// …and the original still equals a fresh build.
		const pristine = richDoc();
		assert.deepEqual( doc, pristine );
	} );

	it( 'preserves scalar leaves exactly, including null and empty shapes', () => {
		const doc = createDocument(
			[
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					attrs: {
						flag: false,
						count: 0,
						label: '',
						nothing: null,
						list: [],
						map: {},
					},
				},
			],
			{ sticky: false, featured_media: 0 }
		);
		const clone = cloneDocument( doc );
		assert.deepEqual( clone, doc );
		const attrs = getBlock( clone, 'p1' ).attrs;
		assert.equal( attrs.flag, false );
		assert.equal( attrs.count, 0 );
		assert.equal( attrs.label, '' );
		assert.equal( attrs.nothing, null );
		assert.deepEqual( attrs.list, [] );
		assert.deepEqual( attrs.map, {} );
	} );

	it( 'never calls the global structuredClone (wp-admin swaps it for a slow polyfill)', () => {
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			'structuredClone'
		);
		Object.defineProperty( globalThis, 'structuredClone', {
			value: () => {
				throw new Error(
					'cloneDocument must not call structuredClone'
				);
			},
			configurable: true,
			writable: true,
		} );
		try {
			const clone = cloneDocument( richDoc() );
			assert.equal(
				getBlock( clone, 'p1' ).fields.content.text,
				'Nested paragraph'
			);
		} finally {
			if ( original ) {
				Object.defineProperty(
					globalThis,
					'structuredClone',
					original
				);
			} else {
				delete globalThis.structuredClone;
			}
		}
	} );
} );
