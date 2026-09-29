import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(
	path.dirname( fileURLToPath( import.meta.url ) ),
	'../..'
);
const upstream =
	process.argv[ 2 ] ||
	process.env.WP_ENTITY_SYNC_ROOT ||
	path.join( root, 'gutenberg' );
const source = path.resolve(
	upstream,
	'packages/core-data/src/entity-sync.ts'
);
if ( ! existsSync( source ) ) {
	throw new Error( `Entity sync API not found: ${ source }` );
}
const directory = mkdtempSync( path.join( tmpdir(), 'gse-entity-sync-' ) );
try {
	const check = path.join( directory, 'check.ts' );
	writeFileSync(
		check,
		`
import type { EntitySyncManager } from ${ JSON.stringify( source ) };
import { registerEntitySyncManager } from ${ JSON.stringify( source ) };
import { createEntitySyncAdapter } from ${ JSON.stringify(
			path.join( root, 'src/entity-sync/adapter' )
		) };
declare const base: EntitySyncManager;
const adapter: EntitySyncManager = createEntitySyncAdapter( base, async () => {} );
registerEntitySyncManager( adapter );
`
	);
	const config = path.join( directory, 'tsconfig.json' );
	writeFileSync(
		config,
		JSON.stringify( {
			extends: path.join( root, 'tsconfig.json' ),
			compilerOptions: {
				types: [],
				incremental: false,
				allowImportingTsExtensions: true,
			},
			include: [ check ],
			exclude: [],
		} )
	);
	let result = spawnSync(
		process.execPath,
		[
			path.join( root, 'node_modules/typescript/bin/tsc' ),
			'--project',
			config,
		],
		{ cwd: root, stdio: 'inherit' }
	);
	if ( result.status !== 0 ) {
		process.exitCode = result.status ?? 1;
	} else {
		result = spawnSync(
			'npm',
			[ 'run', 'test:js', '--', '--runInBand', 'entity-sync' ],
			{
				cwd: root,
				stdio: 'inherit',
				env: {
					...process.env,
					WP_ENTITY_SYNC_ROOT: path.resolve( upstream ),
				},
			}
		);
		process.exitCode = result.status ?? 1;
	}
} finally {
	rmSync( directory, { recursive: true, force: true } );
}
