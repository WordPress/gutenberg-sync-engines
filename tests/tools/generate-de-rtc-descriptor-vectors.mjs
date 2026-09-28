/**
 * Regenerates the DE-RTC descriptor cross-language vector fixture.
 *
 * Runs tests/tools/generate-de-rtc-descriptor-vectors.php through `wp
 * eval-file` in the TESTS wp-env cli container (the env must be running
 * with the plugin active) and rewrites
 * tests/js/engines/de-rtc/test-vectors/descriptor-vectors.json.
 *
 * Usage: node tests/tools/generate-de-rtc-descriptor-vectors.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '../..' );
const fixture = resolve(
	root,
	'tests/js/engines/de-rtc/test-vectors/descriptor-vectors.json'
);

const output = execFileSync(
	'npx',
	[
		'wp-env',
		'--config',
		'.wp-env.tests.json',
		'run',
		'cli',
		'--env-cwd=wp-content/plugins/gutenberg-sync-engines',
		'wp',
		'eval-file',
		'tests/tools/generate-de-rtc-descriptor-vectors.php',
	],
	{ cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

const match =
	/-----BEGIN DE-RTC DESCRIPTOR VECTORS-----\n([\s\S]*?)\n-----END DE-RTC DESCRIPTOR VECTORS-----/.exec(
		output
	);
if ( ! match ) {
	process.stderr.write( output );
	throw new Error( 'Vector markers not found in wp eval-file output.' );
}

const vectors = JSON.parse( match[ 1 ] );
mkdirSync( dirname( fixture ), { recursive: true } );
writeFileSync( fixture, JSON.stringify( vectors, null, 2 ) + '\n' );
process.stdout.write(
	`Wrote ${ vectors.length } vectors to ${ fixture }\n`
);
