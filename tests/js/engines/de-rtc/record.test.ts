/**
 * DE-RTC's plain record: the editor mirror that replaced the local Y.Doc.
 * Pins the field rules ported from core-data's post mapping, the change
 * detection that decides what reaches the session and the editor, and
 * that no de-rtc module depends on Yjs any more.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, jest } from '@jest/globals';

import {
	createDeRtcRecord,
	editorChangesFromRecord,
	recordChangesFromEditor,
	sameBlocks,
} from '../../../../src/engines/de-rtc/record';
import { replaceBlockBySyncId } from '../../../../src/engines/de-rtc/doc-bridge';
import { createDeRtcEngine } from '../../../../src/engines/de-rtc/engine';
import {
	DE_RTC_SNAPSHOT_TYPE,
	setDeRtcBurstQuietMsForTesting,
} from '../../../../src/engines/de-rtc/session';

// Same stand-in as the other de-rtc suites: content is opaque JSON.
jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

const A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const B = { name: 'core/paragraph', attributes: { content: 'Beta' } };
const POST = 'postType/post';

describe( 'de-rtc record', () => {
	it( 'notifies once per change, with the origin, and not for equal values', () => {
		const record = createDeRtcRecord();
		const origins: unknown[] = [];
		record.subscribe( ( origin ) => origins.push( origin ) );

		expect( record.apply( { title: 'One', status: 'draft' }, 'a' ) ).toBe(
			true
		);
		expect( record.apply( { title: 'One' }, 'b' ) ).toBe( false );
		expect( origins ).toEqual( [ 'a' ] );
	} );

	it( 'compares blocks by reference: the editor tree is immutable', () => {
		const record = createDeRtcRecord();
		const blocks = [ A ];
		expect( record.apply( { blocks }, 'x' ) ).toBe( true );
		expect( record.apply( { blocks }, 'x' ) ).toBe( false );
		expect( record.apply( { blocks: [ A ] }, 'x' ) ).toBe( true );
		expect( sameBlocks( blocks, [ A ] ) ).toBe( true );
		expect( sameBlocks( blocks, [ B ] ) ).toBe( false );
	} );

	it( 'merges meta per key, removes undefined values, and never keeps the CRDT meta key', () => {
		const record = createDeRtcRecord();
		record.apply( { meta: { a: 1, b: 2 } }, 'x' );
		record.apply(
			{ meta: { b: undefined, c: 3, _crdt_document: 'bytes' } },
			'x'
		);
		expect( record.get( 'meta' ) ).toEqual( { a: 1, c: 3 } );

		record.apply( { title: 'T' }, 'x' );
		record.apply( { title: undefined }, 'x' );
		expect( record.keys() ).not.toContain( 'title' );
	} );

	it( 'treats term IDs as a set but keeps the order of meta lists', () => {
		const record = createDeRtcRecord();
		record.apply( { categories: [ 3, 1, 2 ] }, 'x' );
		expect( record.apply( { categories: [ 1, 2, 3 ] }, 'x' ) ).toBe(
			false
		);

		record.apply( { meta: { gallery_ids: [ 3, 1, 2 ] } }, 'x' );
		expect(
			record.apply( { meta: { gallery_ids: [ 1, 2, 3 ] } }, 'x' )
		).toBe( true );
		expect( record.get( 'meta' ) ).toEqual( { gallery_ids: [ 1, 2, 3 ] } );
	} );
} );

describe( 'editor changes into the record (post rules)', () => {
	it( 'keeps synced fields only, and never stores content', () => {
		const record = createDeRtcRecord();
		const blocks = [ A ];
		expect(
			recordChangesFromEditor(
				{
					blocks,
					content: () => 'lazy',
					selection: { selectionStart: {} },
					title: { raw: 'Hello', rendered: 'Hello' },
					unknown_field: 1,
				},
				record,
				POST
			)
		).toEqual( { blocks, title: 'Hello' } );
	} );

	it( 'derives blocks from content when the Code Editor clears them', () => {
		const record = createDeRtcRecord();
		expect(
			recordChangesFromEditor(
				{ blocks: undefined, content: JSON.stringify( [ B ] ) },
				record,
				POST
			)
		).toEqual( { blocks: [ B ] } );
	} );

	it( 'never syncs the Auto Draft placeholder title or an empty slug', () => {
		const record = createDeRtcRecord();
		expect(
			recordChangesFromEditor(
				{ title: 'Auto Draft', slug: '' },
				record,
				POST
			)
		).toEqual( { title: '' } );
	} );

	it( 'keeps a taxonomy field only once the server has seeded it', () => {
		const record = createDeRtcRecord();
		expect(
			recordChangesFromEditor( { genres: [ 2 ] }, record, POST )
		).toEqual( {} );
		// The room's first version seeds every attached taxonomy.
		record.apply( { genres: [] }, 'remote' );
		expect(
			recordChangesFromEditor( { genres: [ 2 ] }, record, POST )
		).toEqual( { genres: [ 2 ] } );
	} );

	it( 'keeps every non-function field for other entities', () => {
		const record = createDeRtcRecord();
		expect(
			recordChangesFromEditor(
				{ name: 'Term', count: 3, render: () => '' },
				record,
				'taxonomy/category'
			)
		).toEqual( { name: 'Term', count: 3 } );
	} );
} );

describe( 'record changes into the editor (post rules)', () => {
	it( 'reports only fields that differ, comparing title and excerpt by raw value', () => {
		const record = createDeRtcRecord();
		record.apply( { title: 'Same', excerpt: 'New', format: 'aside' }, 'x' );
		const changes = editorChangesFromRecord(
			record,
			{
				title: { raw: 'Same', rendered: 'Same' },
				excerpt: { raw: 'Old', rendered: 'Old' },
				format: 'aside',
			},
			POST
		);
		expect( changes ).toEqual( { excerpt: 'New' } );
	} );

	it( 'never overwrites a floating date or reports the auto-draft status', () => {
		const record = createDeRtcRecord();
		record.apply(
			{ date: '2026-01-01T00:00:00', status: 'auto-draft' },
			'x'
		);
		expect(
			editorChangesFromRecord(
				record,
				{ date: null, status: 'draft' },
				POST
			)
		).toEqual( {} );
	} );

	it( 'merges meta over the editor meta and ignores keys the post no longer registers', () => {
		const record = createDeRtcRecord();
		record.apply( { meta: { kept: 'peer', gone: 'orphan' } }, 'x' );
		expect(
			editorChangesFromRecord(
				record,
				{ meta: { kept: 'mine', other: 1 } },
				POST
			)
		).toEqual( { meta: { kept: 'peer', other: 1 } } );
	} );

	it( 'sends changed blocks with a lazy content serializer, and skips the tree the editor already has', () => {
		const record = createDeRtcRecord();
		const blocks = [ A ];
		record.apply( { blocks }, 'x' );

		expect( editorChangesFromRecord( record, { blocks }, POST ) ).toEqual(
			{}
		);

		const changes = editorChangesFromRecord(
			record,
			{ blocks: [ B ] },
			POST
		) as { blocks: unknown; content: () => string };
		expect( changes.blocks ).toBe( blocks );
		expect( changes.content() ).toBe( JSON.stringify( [ A ] ) );
	} );
} );

describe( 'de-rtc entity without a Y.Doc', () => {
	const snapshotRow = ( version: string, blocks: unknown[] ) => ( {
		type: DE_RTC_SNAPSHOT_TYPE,
		data: JSON.stringify( { version, content: JSON.stringify( blocks ) } ),
	} );

	function makeEntity() {
		setDeRtcBurstQuietMsForTesting( 0 );
		const entity = createDeRtcEngine().createEntity( {
			syncConfig: {},
			objectType: 'postType/book',
			objectId: '1',
		} as any );
		const onRemoteChange = jest.fn();
		entity.observe( { onRemoteChange } as any );
		const session = entity.createSession();
		return { entity, session, onRemoteChange };
	}

	it( 'does not reach the editor when a canonical version holds the same content', () => {
		const { session, onRemoteChange } = makeEntity();
		session.receiveUpdate( snapshotRow( 'v1', [ A ] ) );
		expect( onRemoteChange ).toHaveBeenCalledTimes( 1 );

		session.receiveUpdate( snapshotRow( 'v2', [ A ] ) );
		expect( onRemoteChange ).toHaveBeenCalledTimes( 1 );

		session.receiveUpdate( snapshotRow( 'v3', [ B ] ) );
		expect( onRemoteChange ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'adds no CRDT snapshot or persisted document to saves', () => {
		const { entity } = makeEntity();
		expect( entity.encodeSnapshot() ).toBe( '' );
		expect( entity.containsSnapshot( 'anything' ) ).toBe( false );
		expect( entity.serialize() ).toBe( '' );
	} );
} );

describe( 'replaceBlockBySyncId', () => {
	it( 'copies the parents of a nested replacement instead of changing them', () => {
		const child = {
			name: 'core/paragraph',
			attributes: { metadata: { syncId: 'c' } },
			innerBlocks: [],
		};
		const group = {
			name: 'core/group',
			attributes: { metadata: { syncId: 'g' } },
			innerBlocks: [ child ],
		};
		const tree = [ group ];
		const replacement = { ...child, attributes: { ...child.attributes } };

		expect( replaceBlockBySyncId( tree, 'c', replacement ) ).toBe( true );
		expect( group.innerBlocks[ 0 ] ).toBe( child );
		expect( ( tree[ 0 ] as any ).innerBlocks[ 0 ] ).toBe( replacement );
	} );
} );

describe( 'de-rtc sources', () => {
	// Presence still uses y-protocols' Awareness over a stub doc, as every
	// engine does; that protocol keeps no document.
	it( 'import nothing from Yjs', () => {
		const root = join( __dirname, '../../../../src/engines' );
		const files = [
			...readdirSync( join( root, 'de-rtc' ) ).map( ( name ) =>
				join( root, 'de-rtc', name )
			),
			join( root, 'de-rtc-adapter.ts' ),
		].filter( ( file ) => /\.tsx?$/.test( file ) );
		for ( const file of files ) {
			const source = readFileSync( file, 'utf8' );
			expect( [
				file,
				/from '(yjs|[^']*yjs-server\/[^']*)'/.test( source ),
			] ).toEqual( [ file, false ] );
		}
	} );
} );
