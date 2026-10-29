/**
 * Build the development history panel against the built, pinned subtree.
 * Usage: node tests/tools/semantic-capture/build.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const framework = path.resolve( 'gutenberg' );
const dataBundle = await readFile(
	path.join( framework, 'build/scripts/data/index.js' ),
	'utf8'
);
const blockBundle = await readFile(
	path.join( framework, 'build/scripts/block-editor/index.js' ),
	'utf8'
);
if (
	! dataBundle.includes( 'observeStoreActions' ) ||
	! blockBundle.includes( 'editingOperation' )
) {
	throw new Error(
		'Build the pinned Gutenberg subtree before building this prototype.'
	);
}
const output = 'build/semantic-capture';
await mkdir( output, { recursive: true } );
await build( {
	entryPoints: [ 'tests/tools/semantic-capture/browser.js' ],
	outfile: `${ output }/index.js`,
	bundle: true,
	format: 'iife',
	plugins: [
		{
			name: 'shared-yjs',
			setup( builder ) {
				builder.onResolve( { filter: /^yjs$/ }, () => ( {
					path: 'yjs',
					namespace: 'shared-yjs',
				} ) );
				builder.onLoad(
					{ filter: /.*/, namespace: 'shared-yjs' },
					() => ( { contents: 'module.exports = window.wp.sync.Y;' } )
				);
			},
		},
	],
} );
await writeFile(
	`${ output }/framework-commit.txt`,
	JSON.parse( await readFile( 'gutenberg-pin.json', 'utf8' ) ).commit + '\n'
);
console.log(
	`Built ${ output }. Activate the Semantic Capture Prototype fixture.`
);
