/**
 * The intent-log conflict records: one record per parked unit, overlapping
 * units folded, and the three sides rebuilt from the retained log. Runs the
 * real engine core (documents and the reducer). The serializer is a plain
 * stand-in, since block markup is the editor's business.
 */

/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createDocument } from '../../../src/engines/intent-log/document.js';
import { applyIntent } from '../../../src/engines/intent-log/reducer.js';
import {
	buildConflictRecords,
	coveringRun,
	topMostIds,
	type ConflictDeps,
} from '../../../src/engines/intent-log-conflicts';
import type {
	EngineBlock,
	EngineDocument,
	IntentEnvelope,
} from '../../../src/engines/intent-log/engine-types';
import type { IntentLogProposal } from '../../../src/engines/intent-log-session';

let nextId = 0;
const intent = (
	type: string,
	payload: Record< string, unknown >,
	options: { actorId?: string; baseSeq?: number; txnId?: string } = {}
): IntentEnvelope => ( {
	intentId: `i${ ++nextId }`,
	actorId: options.actorId ?? 'u7c1',
	baseSeq: options.baseSeq ?? 0,
	txnId: options.txnId ?? null,
	type,
	payload,
} );

const parked = (
	envelope: IntentEnvelope,
	reason = 'frame-conflict'
): IntentLogProposal => ( {
	intent: envelope,
	actorId: envelope.actorId,
	reason,
} );

const findBlock = (
	blocks: EngineBlock[],
	id: string
): EngineBlock | undefined => {
	for ( const block of blocks ) {
		if ( block.syncId === id ) {
			return block;
		}
		const inner = findBlock( block.children, id );
		if ( inner ) {
			return inner;
		}
	}
	return undefined;
};

// One line per block: `<id>:<text>`, children in brackets.
const render = ( block: EngineBlock ): string =>
	`${ block.syncId }:${ block.fields.content?.text ?? '' }` +
	( block.children.length
		? `[${ block.children.map( render ).join( ',' ) }]`
		: '' );

const depsFor = (
	current: EngineDocument,
	history: Record< number, EngineDocument > = {},
	log: IntentEnvelope[] = []
): ConflictDeps => ( {
	getDocument: () => current,
	getDocumentAt: ( seq ) => history[ seq ] ?? null,
	getLogSince: ( seq ) =>
		log
			.map( ( envelope, index ) => ( {
				seq: index + 1,
				intent: envelope,
			} ) )
			.filter( ( entry ) => entry.seq > seq ),
	serializeBlocks: ( doc, ids ) =>
		ids
			.map( ( id ) => findBlock( doc.root, id ) )
			.filter( ( block ): block is EngineBlock => !! block )
			.map( render )
			.join( '|' ),
} );

const BASE = createDocument( [
	{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
	{ syncId: 'p2', blockType: 'core/paragraph', text: 'World' },
] );

describe( 'intent-log conflict records', () => {
	it( 'rebuilds base, proposed, and current for a parked text edit', () => {
		// A collaborator's edit landed first: the current document differs
		// from the base the parked edit started from.
		const current = applyIntent(
			BASE,
			intent( 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: 5,
				text: ' there',
			} )
		).doc;
		const edit = intent( 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 5,
			text: ' friend',
		} );

		const [ record ] = buildConflictRecords(
			[ parked( edit ) ],
			depsFor( current, { 0: BASE } )
		);

		expect( record.conflict ).toEqual( {
			id: edit.intentId,
			kind: 'merge',
			authorId: 7,
			target: {
				type: 'blocks',
				ids: [ 'p1' ],
				parentId: undefined,
				index: 0,
				count: 1,
			},
			base: 'p1:Hello',
			proposed: 'p1:Hello friend',
			current: 'p1:Hello there',
			// The server sets the author's later typing in the block
			// aside into this record, so the card waits for a pause.
			followsTyping: true,
		} );
	} );

	it( 'leaves base null when the replica no longer holds the base seq', () => {
		const edit = intent(
			'insert_text',
			{ syncId: 'p1', field: 'content', offset: 5, text: '!' },
			{ baseSeq: 3 }
		);
		// No history: the proposal is older than the session.
		const [ record ] = buildConflictRecords(
			[ parked( edit ) ],
			depsFor( BASE )
		);
		expect( record.conflict.base ).toBeNull();
		// The members then apply onto the current document.
		expect( record.conflict.proposed ).toBe( 'p1:Hello!' );
		expect( record.conflict.current ).toBe( 'p1:Hello' );
	} );

	it( 'folds a burst of parked keystrokes on one block into one record', () => {
		const keystrokes = [ ' ', 'a', 'b' ].map( ( text, position ) =>
			intent( 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: 5 + position,
				text,
			} )
		);
		const records = buildConflictRecords(
			keystrokes.map( ( envelope ) => parked( envelope ) ),
			depsFor( BASE, { 0: BASE } )
		);

		expect( records ).toHaveLength( 1 );
		expect( records[ 0 ].members ).toHaveLength( 3 );
		expect( records[ 0 ].conflict.id ).toBe( keystrokes[ 0 ].intentId );
		// Applied in authoring order, the burst reads as the author typed it.
		expect( records[ 0 ].conflict.proposed ).toBe( 'p1:Hello ab' );
	} );

	it( 'applies what the author got accepted from the same frame before what was held', () => {
		// A typing burst: the first keystrokes went through, the later
		// ones parked. The parked offsets sit behind the accepted text.
		// The log holds it as the server rebased it, shifted past the
		// other author's character.
		const accepted = intent( 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 6,
			text: ' my',
		} );
		const held = intent( 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 8,
			text: ' friend',
		} );
		// Someone else's accepted edit, and the author's edit of another
		// block, are not part of this record's proposed side.
		const foreign = intent(
			'insert_text',
			{ syncId: 'p1', field: 'content', offset: 0, text: 'X' },
			{ actorId: 'u9c9' }
		);
		const elsewhere = intent( 'insert_text', {
			syncId: 'p2',
			field: 'content',
			offset: 0,
			text: 'Y',
		} );
		const log = [ foreign, accepted, elsewhere ];
		const current = log.reduce(
			( doc, envelope ) => applyIntent( doc, envelope ).doc,
			BASE
		);

		const [ record ] = buildConflictRecords(
			[ parked( held ) ],
			depsFor( current, { 0: BASE }, log )
		);
		expect( record.conflict.base ).toBe( 'p1:Hello' );
		expect( record.conflict.proposed ).toBe( 'p1:Hello my friend' );
		expect( record.conflict.current ).toBe( 'p1:XHello my' );
	} );

	it( 'replays an accepted keystroke the transform moved at its authored place', () => {
		// "A sentence.": a peer typed "abc " at the start while the author
		// typed " 123" before the period. The author's space got through,
		// moved past the peer's text; "1", "2", "3" were set aside. The
		// proposed side is the author's own version, so the space belongs
		// where the author put it, not where the log holds it.
		const base = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph', text: 'A sentence.' },
		] );
		const typed = ( offset: number, text: string ) =>
			intent( 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset,
				text,
			} );
		const peer = intent(
			'insert_text',
			{ syncId: 'p1', field: 'content', offset: 0, text: 'abc ' },
			{ actorId: 'u9c9' }
		);
		const space: IntentEnvelope = {
			...typed( 14, ' ' ),
			authoredPayload: {
				syncId: 'p1',
				field: 'content',
				offset: 10,
				text: ' ',
			},
		};
		const log = [ peer, space ];
		const current = log.reduce(
			( doc, envelope ) => applyIntent( doc, envelope ).doc,
			base
		);

		const [ record ] = buildConflictRecords(
			[
				parked( typed( 11, '1' ) ),
				parked( typed( 12, '2' ), 'dependent-on-escalated' ),
				parked( typed( 13, '3' ), 'dependent-on-escalated' ),
			],
			depsFor( current, { 0: base }, log )
		);
		expect( record.conflict.base ).toBe( 'p1:A sentence.' );
		expect( record.conflict.proposed ).toBe( 'p1:A sentence 123.' );
		expect( record.conflict.current ).toBe( 'p1:abc A sentence .' );
	} );

	it( 'rebuilds held markup whose placeholder was accepted', () => {
		// Custom HTML: the placeholder character is an ordinary insertion
		// (accepted), the markup a format over it (held for approval).
		const doc = createDocument( [
			{ syncId: 'h1', blockType: 'core/html', text: '' },
		] );
		const placeholder = intent( 'insert_text', {
			syncId: 'h1',
			field: 'content',
			offset: 0,
			text: '\uFFFC',
		} );
		const markup = intent( 'format_text', {
			syncId: 'h1',
			field: 'content',
			start: 0,
			end: 1,
			format: 'obj|{"html":"<script>x</script>"}',
			on: true,
		} );
		const current = applyIntent( doc, placeholder ).doc;
		const [ record ] = buildConflictRecords(
			[ parked( markup, 'requires-approval' ) ],
			{
				...depsFor( current, { 0: doc }, [ placeholder ] ),
				serializeBlocks: ( from, ids ) =>
					ids
						.map( ( id ) => findBlock( from.root, id ) )
						.map( ( block ) =>
							JSON.stringify( block?.fields.content )
						)
						.join( '|' ),
			}
		);
		expect( JSON.parse( record.conflict.base ?? '' ) ).toEqual( {
			text: '',
			formats: [],
		} );
		expect( JSON.parse( record.conflict.proposed ) ).toEqual( {
			text: '\uFFFC',
			formats: [
				{
					start: 0,
					end: 1,
					format: 'obj|{"html":"<script>x</script>"}',
				},
			],
		} );
	} );

	it( 'groups the members of one txn into one record whose target is their union', () => {
		// A split: the first paragraph loses its tail, a new paragraph
		// takes it. Both members park together.
		const txnId = 'txn-split';
		const members = [
			intent(
				'delete_text',
				{ syncId: 'p1', field: 'content', start: 3, end: 5 },
				{ txnId }
			),
			intent(
				'insert_block',
				{
					block: {
						syncId: 'p1b',
						blockType: 'core/paragraph',
						text: 'lo',
					},
					parentId: null,
					afterSiblingId: 'p1',
				},
				{ txnId }
			),
		];
		const records = buildConflictRecords(
			members.map( ( envelope ) => parked( envelope ) ),
			depsFor( BASE, { 0: BASE } )
		);

		expect( records ).toHaveLength( 1 );
		expect( records[ 0 ].blockIds ).toEqual( [ 'p1', 'p1b' ] );
		expect( records[ 0 ].conflict.base ).toBe( 'p1:Hello' );
		expect( records[ 0 ].conflict.proposed ).toBe( 'p1:Hel|p1b:lo' );
		// The new block does not exist yet: the target is the one that does.
		expect( records[ 0 ].conflict.target ).toMatchObject( {
			type: 'blocks',
			ids: [ 'p1' ],
			count: 1,
		} );
	} );

	it( 'keeps records apart by author, by kind, and by block', () => {
		const records = buildConflictRecords(
			[
				parked(
					intent( 'insert_text', {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'A',
					} )
				),
				parked(
					intent(
						'insert_text',
						{
							syncId: 'p1',
							field: 'content',
							offset: 0,
							text: 'B',
						},
						{ actorId: 'u8c2' }
					)
				),
				parked(
					intent( 'insert_text', {
						syncId: 'p2',
						field: 'content',
						offset: 0,
						text: 'C',
					} )
				),
				parked(
					intent( 'format_text', {
						syncId: 'p1',
						field: 'content',
						start: 0,
						end: 1,
						format: 'obj|{"html":"<script>x</script>"}',
						on: true,
					} ),
					'requires-approval'
				),
			],
			depsFor( BASE, { 0: BASE } )
		);

		expect(
			records.map( ( record ) => [
				record.conflict.authorId,
				record.conflict.kind,
				record.blockIds,
			] )
		).toEqual( [
			[ 7, 'merge', [ 'p1' ] ],
			[ 8, 'merge', [ 'p1' ] ],
			[ 7, 'merge', [ 'p2' ] ],
			[ 7, 'sequestration', [ 'p1' ] ],
		] );
	} );

	it( 'targets the slot after the anchor for a parked insertion', () => {
		const insertion = intent( 'insert_block', {
			block: { syncId: 'nb', blockType: 'core/html', text: '' },
			parentId: null,
			afterSiblingId: 'p1',
		} );
		const [ record ] = buildConflictRecords(
			[ parked( insertion, 'requires-approval' ) ],
			depsFor( BASE, { 0: BASE } )
		);
		expect( record.conflict.target ).toEqual( {
			type: 'blocks',
			parentId: undefined,
			index: 1,
			count: 0,
		} );
		expect( record.conflict.base ).toBe( '' );
		expect( record.conflict.proposed ).toBe( 'nb:' );
		expect( record.conflict.current ).toBe( '' );
	} );

	it( 'describes a parked property write by its three values', () => {
		const base = createDocument( [], { title: 'Draft' } );
		const current = createDocument( [], { title: 'Theirs' } );
		const write = intent( 'set_property', {
			name: 'title',
			value: 'Mine',
		} );
		const [ record ] = buildConflictRecords(
			[ parked( write, 'property-conflict' ) ],
			depsFor( current, { 0: base } )
		);
		expect( record.conflict ).toMatchObject( {
			target: { type: 'property', name: 'title' },
			base: 'Draft',
			proposed: 'Mine',
			current: 'Theirs',
		} );
		expect( record.property ).toBe( 'title' );
		// A property write has no text frame for later typing to follow.
		expect( record.conflict.followsTyping ).toBeUndefined();
	} );

	describe( 'a record over blocks that are not neighbours', () => {
		const THREE = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
			{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
			{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
		] );
		const append = (
			syncId: string,
			offset: number,
			text: string,
			options: { actorId?: string; txnId?: string } = {}
		) =>
			intent(
				'insert_text',
				{ syncId, field: 'content', offset, text },
				options
			);
		// One edit by the author changes the first and the third
		// paragraph.
		const authorEdit = () => [
			append( 'p1', 3, '!', { txnId: 'txn-ends' } ),
			append( 'p3', 5, '!', { txnId: 'txn-ends' } ),
		];

		it( 'covers the block between them on every side', () => {
			const members = authorEdit();
			const [ record ] = buildConflictRecords(
				members.map( ( envelope ) => parked( envelope ) ),
				depsFor( THREE, { 0: THREE } )
			);

			expect( record.conflict.base ).toBe( 'p1:One|p2:Two|p3:Three' );
			expect( record.conflict.current ).toBe( 'p1:One|p2:Two|p3:Three' );
			expect( record.conflict.proposed ).toBe(
				'p1:One!|p2:Two|p3:Three!'
			);
			expect( record.conflict.target ).toEqual( {
				type: 'blocks',
				ids: [ 'p1', 'p2', 'p3' ],
				parentId: undefined,
				index: 0,
				count: 3,
			} );
			// The edits touch two blocks. An accepted result replaces three.
			expect( record.blockIds ).toEqual( [ 'p1', 'p3' ] );
			expect( record.spanIds ).toEqual( [ 'p1', 'p2', 'p3' ] );
		} );

		it( "shows a collaborator's rewrite of the block in between on the proposed side too", () => {
			// The author started from THREE. A collaborator has since
			// rewritten the second paragraph.
			const current = applyIntent(
				THREE,
				append( 'p2', 3, ' (rewritten)', { actorId: 'u9c9' } )
			).doc;
			const [ record ] = buildConflictRecords(
				authorEdit().map( ( envelope ) => parked( envelope ) ),
				depsFor( current, { 0: THREE } )
			);

			expect( record.conflict.base ).toBe( 'p1:One|p2:Two|p3:Three' );
			expect( record.conflict.current ).toBe(
				'p1:One|p2:Two (rewritten)|p3:Three'
			);
			// The author proposed nothing about the second paragraph, so
			// taking this side whole keeps the collaborator's text.
			expect( record.conflict.proposed ).toBe(
				'p1:One!|p2:Two (rewritten)|p3:Three!'
			);
		} );

		it( 'shows a block a collaborator added in between on the current and the proposed side', () => {
			// The author started from two paragraphs that WERE neighbours.
			const base = createDocument( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
			] );
			const current = applyIntent(
				base,
				intent(
					'insert_block',
					{
						block: {
							syncId: 'px',
							blockType: 'core/paragraph',
							text: 'New',
						},
						parentId: null,
						afterSiblingId: 'p1',
					},
					{ actorId: 'u9c9' }
				)
			).doc;
			const [ record ] = buildConflictRecords(
				authorEdit().map( ( envelope ) => parked( envelope ) ),
				depsFor( current, { 0: base } )
			);

			expect( record.conflict.base ).toBe( 'p1:One|p3:Three' );
			expect( record.conflict.current ).toBe( 'p1:One|px:New|p3:Three' );
			expect( record.conflict.proposed ).toBe(
				'p1:One!|px:New|p3:Three!'
			);
			expect( record.conflict.target ).toMatchObject( {
				ids: [ 'p1', 'px', 'p3' ],
				index: 0,
				count: 3,
			} );
		} );

		it( 'leaves a block a collaborator removed from in between off the proposed side', () => {
			const current = applyIntent(
				THREE,
				intent( 'remove_block', { syncId: 'p2' }, { actorId: 'u9c9' } )
			).doc;
			const [ record ] = buildConflictRecords(
				authorEdit().map( ( envelope ) => parked( envelope ) ),
				depsFor( current, { 0: THREE } )
			);

			expect( record.conflict.base ).toBe( 'p1:One|p2:Two|p3:Three' );
			expect( record.conflict.current ).toBe( 'p1:One|p3:Three' );
			expect( record.conflict.proposed ).toBe( 'p1:One!|p3:Three!' );
		} );

		it( 'covers a block and a block inside a group at the level they meet', () => {
			const doc = createDocument( [
				{ syncId: 'p0', blockType: 'core/paragraph', text: 'Zero' },
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
				{
					syncId: 'g',
					blockType: 'core/group',
					children: [
						{
							syncId: 'p3',
							blockType: 'core/paragraph',
							text: 'Three',
						},
					],
				},
			] );
			const [ record ] = buildConflictRecords(
				authorEdit().map( ( envelope ) => parked( envelope ) ),
				depsFor( doc, { 0: doc } )
			);

			expect( record.conflict.current ).toBe(
				'p1:One|p2:Two|g:[p3:Three]'
			);
			expect( record.conflict.proposed ).toBe(
				'p1:One!|p2:Two|g:[p3:Three!]'
			);
			expect( record.conflict.target ).toEqual( {
				type: 'blocks',
				ids: [ 'p1', 'p2', 'g' ],
				parentId: undefined,
				index: 1,
				count: 3,
			} );
		} );

		it( 'covers blocks inside one group among the children of that group', () => {
			const doc = createDocument( [
				{
					syncId: 'g',
					blockType: 'core/group',
					children: [
						{
							syncId: 'p1',
							blockType: 'core/paragraph',
							text: 'One',
						},
						{
							syncId: 'p2',
							blockType: 'core/paragraph',
							text: 'Two',
						},
						{
							syncId: 'p3',
							blockType: 'core/paragraph',
							text: 'Three',
						},
						{
							syncId: 'p4',
							blockType: 'core/paragraph',
							text: 'Four',
						},
					],
				},
			] );

			expect( coveringRun( [ 'p3', 'p1', 'gone' ], doc ) ).toMatchObject(
				{
					ids: [ 'p1', 'p2', 'p3' ],
					parentId: 'g',
					index: 0,
				}
			);
			expect( coveringRun( [ 'p4' ], doc ) ).toMatchObject( {
				ids: [ 'p4' ],
				parentId: 'g',
				index: 3,
			} );
			expect( coveringRun( [ 'gone' ], doc ).ids ).toEqual( [] );
		} );
	} );

	it( 'serializes only the top-most of nested targets, in document order', () => {
		const doc = createDocument( [
			{
				syncId: 'g',
				blockType: 'core/group',
				children: [
					{ syncId: 'a', blockType: 'core/paragraph', text: 'A' },
					{ syncId: 'b', blockType: 'core/paragraph', text: 'B' },
				],
			},
			{ syncId: 'c', blockType: 'core/paragraph', text: 'C' },
		] );
		expect( topMostIds( [ 'c', 'b', 'g', 'gone' ], doc ) ).toEqual( [
			'g',
			'c',
		] );
		expect( topMostIds( [ 'b', 'a' ], doc ) ).toEqual( [ 'a', 'b' ] );
	} );
} );
