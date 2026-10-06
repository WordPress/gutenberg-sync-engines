/** Exact-result contract for text that moves between blocks. */
import { verifyEffect } from './simulator.js';
import {
	createDocument,
	getBlock,
} from '../../../../src/engines/intent-log/document.js';
import { createIntent } from '../../../../src/engines/intent-log/intents.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../../src/engines/intent-log/rebase.js';

let nextId;
beforeEach( () => {
	nextId = 0;
} );
const intent = ( type, payload, actorId = 'alice', baseSeq = 0 ) =>
	createIntent( type, payload, {
		actorId,
		baseSeq,
		intentId: `edit-${ nextId++ }`,
	} );
const initial = () =>
	createDocument( [
		{ syncId: 'p', blockType: 'core/paragraph', text: 'Hello world' },
	] );
const head = ( server ) =>
	serverDocAt( server, server.firstSeq + server.log.length );
const split = ( id = 'p', offset = 5, tail = 'q', base = 0 ) =>
	intent(
		'split_block',
		{ syncId: id, offset, newSyncId: tail },
		'alice',
		base
	);
const format = ( on = true ) =>
	intent(
		'format_text',
		{ syncId: 'p', start: 3, end: 8, format: 'bold', on },
		'bob'
	);
const text = ( server ) =>
	head( server ).root.map( ( b ) => b.fields.content.text );
const spans = ( server ) =>
	head( server ).root.map( ( b ) => b.fields.content.formats );

test.each( [ false, true ] )(
	'format follows both halves, split arrives first: %s',
	( splitFirst ) => {
		const server = createServer( initial() );
		const edits = [ split(), format() ];
		if ( ! splitFirst ) {
			edits.reverse();
		}
		for ( const edit of edits ) {
			expect( serverIngestBatch( server, [ edit ] )[ 0 ].status ).toBe(
				'applied'
			);
		}
		expect( text( server ) ).toEqual( [ 'Hello', ' world' ] );
		expect( spans( server ) ).toEqual( [
			[ { start: 3, end: 5, format: 'bold' } ],
			[ { start: 0, end: 3, format: 'bold' } ],
		] );
	}
);

test( 'format survives repeated splits, join to unrelated text, then another split', () => {
	const doc = initial();
	doc.root.push(
		...createDocument( [
			{ syncId: 'other', blockType: 'core/paragraph', text: 'XY' },
		] ).root
	);
	const server = createServer( doc );
	const edits = [
		split(),
		split( 'q', 2, 'r', 1 ),
		intent(
			'merge_blocks',
			{ survivorId: 'other', absorbedId: 'q', joinOffset: 2 },
			'alice',
			2
		),
		split( 'other', 3, 's', 3 ),
	];
	edits.forEach( ( edit ) => serverIngestBatch( server, [ edit ] ) );
	expect( serverIngestBatch( server, [ format() ] )[ 0 ].status ).toBe(
		'applied'
	);
	const final = head( server );
	expect( getBlock( final, 'p' ).fields.content.formats ).toEqual( [
		{ start: 3, end: 5, format: 'bold' },
	] );
	expect( getBlock( final, 'other' ).fields.content.formats ).toEqual( [
		{ start: 2, end: 3, format: 'bold' },
	] );
	expect( getBlock( final, 's' ).fields.content.formats ).toEqual( [
		{ start: 0, end: 1, format: 'bold' },
	] );
	expect( getBlock( final, 'r' ).fields.content.formats ).toEqual( [
		{ start: 0, end: 1, format: 'bold' },
	] );
} );

test( 'delete across split is one idempotent edit and preserves the break', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	const edit = intent(
		'delete_text',
		{ syncId: 'p', start: 3, end: 8, removedText: 'lo wo' },
		'bob'
	);
	expect( serverIngestBatch( server, [ edit ] )[ 0 ].status ).toBe(
		'applied'
	);
	expect( text( server ) ).toEqual( [ 'Hel', 'rld' ] );
	expect( server.log ).toHaveLength( 2 );
	serverIngestBatch( server, [ edit ] );
	expect( server.log ).toHaveLength( 2 );
	expect( text( server ) ).toEqual( [ 'Hel', 'rld' ] );
} );

test( 'a conflict in the second slice holds back the whole deletion', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent(
			'insert_text',
			{ syncId: 'q', offset: 1, text: 'PEER' },
			'carol',
			1
		),
	] );
	const edit = intent(
		'delete_text',
		{ syncId: 'p', start: 3, end: 8, removedText: 'lo wo' },
		'bob'
	);
	expect( serverIngestBatch( server, [ edit ] )[ 0 ] ).toEqual( {
		status: 'escalated',
		reason: 'concurrent-insert-in-range',
	} );
	expect( text( server ) ).toEqual( [ 'Hello', ' PEERworld' ] );
} );

test( 'deletion after split and rejoin uses original coordinates once', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent(
			'merge_blocks',
			{ survivorId: 'p', absorbedId: 'q', joinOffset: 5 },
			'alice',
			1
		),
	] );
	expect(
		serverIngestBatch( server, [
			intent(
				'delete_text',
				{ syncId: 'p', start: 3, end: 8, removedText: 'lo wo' },
				'bob'
			),
		] )[ 0 ].status
	).toBe( 'applied' );
	expect( text( server ) ).toEqual( [ 'Helrld' ] );
} );

test( 'removing formatting covers both halves', () => {
	const doc = initial();
	doc.root[ 0 ].fields.content.formats = [
		{ start: 0, end: 11, format: 'bold' },
	];
	const server = createServer( doc );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [ format( false ) ] );
	expect( spans( server ) ).toEqual( [
		[ { start: 0, end: 3, format: 'bold' } ],
		[ { start: 3, end: 6, format: 'bold' } ],
	] );
} );

test.each( [
	[ 2, [ 'He!llo', ' world' ] ],
	[ 5, [ 'Hello', '! world' ] ],
	[ 9, [ 'Hello', ' wor!ld' ] ],
] )( 'insertion at %s follows its text', ( offset, expected ) => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent( 'insert_text', { syncId: 'p', offset, text: '!' }, 'bob' ),
	] );
	expect( text( server ) ).toEqual( expected );
} );

test( 'same-point splits keep an empty paragraph and do not duplicate formatting', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent(
			'split_block',
			{ syncId: 'p', offset: 5, newSyncId: 'r' },
			'carol'
		),
	] );
	serverIngestBatch( server, [ format() ] );
	expect( text( server ) ).toEqual( [ 'Hello', '', ' world' ] );
	expect( spans( server ) ).toEqual( [
		[ { start: 3, end: 5, format: 'bold' } ],
		[],
		[ { start: 0, end: 3, format: 'bold' } ],
	] );
} );

test.each( [ 'remove_block', 'replace_attr_content' ] )(
	'%s in a tail preserves the entire edit for review',
	( type ) => {
		const server = createServer( initial() );
		serverIngestBatch( server, [ split() ] );
		serverIngestBatch( server, [
			intent(
				type,
				{
					syncId: 'q',
					...( type === 'replace_attr_content'
						? { newText: 'unrelated', observedVersion: 0 }
						: {} ),
				},
				'carol',
				1
			),
		] );
		const edit = format();
		expect( serverIngestBatch( server, [ edit ] )[ 0 ].status ).toBe(
			'escalated'
		);
		expect(
			getBlock( head( server ), 'p' ).fields.content.formats
		).toEqual( [] );
		expect( server.proposals[ 0 ].intent.payload ).toEqual( edit.payload );
	}
);

test( 'replacement across a split still needs review', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	expect(
		serverIngestBatch( server, [
			intent(
				'replace_text',
				{
					syncId: 'p',
					start: 3,
					end: 8,
					removedText: 'lo wo',
					text: 'NEW',
				},
				'bob'
			),
		] )[ 0 ]
	).toEqual( { status: 'escalated', reason: 'range-crosses-split' } );
	expect( text( server ) ).toEqual( [ 'Hello', ' world' ] );
} );

test( 'a later edit rebases over every part of an accepted deletion', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent(
			'delete_text',
			{ syncId: 'p', start: 3, end: 8, removedText: 'lo wo' },
			'bob'
		),
	] );
	serverIngestBatch( server, [
		intent(
			'insert_text',
			{ syncId: 'q', offset: 5, text: '!' },
			'carol',
			1
		),
	] );
	expect( text( server ) ).toEqual( [ 'Hel', 'rl!d' ] );
} );

test( 'a completely deleted slice does not discard the surviving format', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	serverIngestBatch( server, [
		intent(
			'delete_text',
			{ syncId: 'q', start: 0, end: 3, removedText: ' wo' },
			'carol',
			1
		),
	] );
	expect( serverIngestBatch( server, [ format() ] )[ 0 ].status ).toBe(
		'applied'
	);
	expect( spans( server ) ).toEqual( [
		[ { start: 3, end: 5, format: 'bold' } ],
		[],
	] );
} );

test( 'checkpoint replay keeps slices without changing the document format', () => {
	const server = createServer( initial() );
	serverIngestBatch( server, [ split() ] );
	const checkpoint = JSON.parse( JSON.stringify( head( server ) ) );
	serverIngestBatch( server, [ format() ] );
	const restored = createServer( checkpoint, 1 );
	restored.log = JSON.parse( JSON.stringify( server.log.slice( 1 ) ) );
	expect( head( restored ) ).toEqual( head( server ) );
	expect( JSON.stringify( head( restored ) ) ).not.toContain( 'textSlices' );
} );

test( 'nested named fields keep Unicode positions and leave other fields alone', () => {
	const doc = createDocument( [
		{
			syncId: 'group',
			blockType: 'core/group',
			children: [
				{
					syncId: 'p',
					blockType: 'core/quote',
					fields: {
						content: { text: 'A😀éB' },
						citation: { text: 'Author' },
					},
				},
			],
		},
	] );
	const server = createServer( doc );
	serverIngestBatch( server, [ split( 'p', 3 ) ] );
	serverIngestBatch( server, [
		intent(
			'format_text',
			{ syncId: 'p', start: 1, end: 5, format: 'bold', on: true },
			'bob'
		),
	] );
	expect( getBlock( head( server ), 'p' ).fields ).toEqual( {
		content: {
			text: 'A😀',
			formats: [ { start: 1, end: 3, format: 'bold' } ],
		},
		citation: { text: 'Author', formats: [] },
	} );
	expect( getBlock( head( server ), 'q' ).fields.content ).toEqual( {
		text: 'éB',
		formats: [ { start: 0, end: 2, format: 'bold' } ],
	} );
} );

test.each( [ 'format_text', 'delete_text' ] )(
	'the oracle detects a broken second %s slice',
	( type ) => {
		const server = createServer( initial() );
		serverIngestBatch( server, [ split() ] );
		const before = head( server );
		const edit = intent(
			type,
			{
				syncId: 'p',
				start: 3,
				end: 8,
				...( type === 'format_text'
					? { format: 'bold', on: true }
					: { removedText: 'lo wo' } ),
			},
			'bob'
		);
		serverIngestBatch( server, [ edit ] );
		const accepted = server.log.at( -1 );
		expect( verifyEffect( before, head( server ), accepted ) ).toBeNull();
		const broken = JSON.parse( JSON.stringify( head( server ) ) );
		getBlock( broken, 'q' ).fields.content = getBlock(
			before,
			'q'
		).fields.content;
		expect( verifyEffect( before, broken, accepted ) ).not.toBeNull();
	}
);
