/**
 * Client/core cost of one stale formatting edit after repeated splits.
 * Run through npm run bench -- --suite=text-slices. No WordPress required.
 * Heap delta is sampled retained allocation, not PHP/request peak memory.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createDocument } from '../../src/engines/intent-log/document.js';
import { createIntent } from '../../src/engines/intent-log/intents.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../src/engines/intent-log/rebase.js';

if ( process.argv.length > 2 ) {
	throw new Error( 'This suite takes no arguments.' );
}
const report = [];
for ( const blocks of [ 1, 10, 100 ] ) {
	const initial = createDocument( [
		{ syncId: 'p0', blockType: 'core/paragraph', text: 'a'.repeat( 1000 ) },
	] );
	const setup = createServer( initial );
	for ( let i = 1; i < blocks; i++ ) {
		serverIngestBatch( setup, [
			createIntent(
				'split_block',
				{
					syncId: `p${ i - 1 }`,
					offset: 1000 / blocks,
					newSyncId: `p${ i }`,
				},
				{ actorId: 'alice', intentId: `split-${ i }`, baseSeq: i - 1 }
			),
		] );
	}
	const doc = serverDocAt( setup, setup.log.length );
	let wall = 0;
	let cpu = 0;
	let maxHeapDelta = 0;
	let rowBytes = 0;
	let snapshotBytes = 0;
	const trials = 20;
	for ( let trial = 0; trial < trials; trial++ ) {
		const server = createServer( initial );
		server.log = [ ...setup.log ];
		server.docCache.set( server.log.length, doc );
		const edit = createIntent(
			'format_text',
			{ syncId: 'p0', start: 0, end: 1000, format: 'bold', on: true },
			{ actorId: 'bob', intentId: 'format', baseSeq: 0 }
		);
		const beforeHeap = process.memoryUsage().heapUsed;
		const beforeCpu = process.cpuUsage();
		const start = performance.now();
		const [ disposition ] = serverIngestBatch( server, [ edit ] );
		wall += performance.now() - start;
		const used = process.cpuUsage( beforeCpu );
		cpu += ( used.user + used.system ) / 1000;
		maxHeapDelta = Math.max(
			maxHeapDelta,
			process.memoryUsage().heapUsed - beforeHeap
		);
		assert.equal( disposition.status, 'applied' );
		const result = serverDocAt( server, server.log.length );
		assert.equal( result.root.length, blocks );
		for ( const block of result.root ) {
			assert.deepEqual( block.fields.content.formats, [
				{ start: 0, end: 1000 / blocks, format: 'bold' },
			] );
		}
		rowBytes = Buffer.byteLength( JSON.stringify( server.log.at( -1 ) ) );
		snapshotBytes = Buffer.byteLength( JSON.stringify( result ) );
		assert.ok( ! JSON.stringify( result ).includes( 'textSlices' ) );
	}
	report.push( {
		blocks,
		trials,
		meanWallMs: +( wall / trials ).toFixed( 3 ),
		meanCpuMs: +( cpu / trials ).toFixed( 3 ),
		maxSampledHeapDeltaBytes: maxHeapDelta,
		acceptedRowBytes: rowBytes,
		snapshotBytes,
	} );
}
console.log(
	JSON.stringify(
		{
			scope: 'JavaScript core, one formatting edit after 0/9/99 splits, fixed 1000 characters; excludes WordPress, transport and PHP',
			results: report,
		},
		null,
		2
	)
);
