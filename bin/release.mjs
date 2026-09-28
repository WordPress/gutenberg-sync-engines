#!/usr/bin/env node
/**
 * Prepares a release commit on a release/vX.Y.Z branch.
 *
 * Usage: npm run release -- <patch|minor|major>
 *
 * What it does, in order:
 *   1. Refuses to run on a dirty working tree.
 *   2. Bumps the version in package.json + package-lock.json (npm version).
 *   3. Stamps the new version into the plugin header and the
 *      GUTENBERG_SYNC_ENGINES_VERSION constant, and replaces any `n.e.x.t`
 *      placeholders in tracked source files.
 *   4. Turns the changelog's "Unreleased" section into the new version's
 *      section: the hand-written highlights (if any) stay on top, and
 *      below them the script appends every commit merged since the last
 *      release tag, each linked to its pull request. It refuses to
 *      release when there is nothing in either list. A fresh, empty
 *      "Unreleased" heading is left above the new section.
 *   5. Commits everything on a new release/vX.Y.Z branch.
 *
 * It never pushes — the create-release-pr workflow (or a human) does that.
 *
 * `npm run release -- --dry-run` prints the commit list the next release
 * would record and changes nothing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = ( cmd, args ) =>
	execFileSync( cmd, args, { encoding: 'utf8' } ).trim();

const die = ( message ) => {
	console.error( `release: ${ message }` );
	process.exit( 1 );
};

const args = process.argv.slice( 2 );
const dryRun = args.includes( '--dry-run' );
const type = args.find( ( arg ) => arg !== '--dry-run' );

// GitHub URL for the links in the generated changelog list, from the
// origin remote (both SSH and HTTPS forms), else the canonical repo.
const repoUrl = ( () => {
	try {
		const match = run( 'git', [ 'remote', 'get-url', 'origin' ] ).match(
			/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/
		);
		if ( match ) {
			return `https://github.com/${ match[ 1 ] }`;
		}
	} catch {
		// No origin remote — fall through.
	}
	return 'https://github.com/Automattic/gutenberg-sync-engines';
} )();

/**
 * Lists the commits merged since the last release tag as changelog lines.
 *
 * Trunk is squash-merged, so each commit's subject is its pull request's
 * title and ends with "(#NN)". That number becomes a link to the PR; any
 * other "#NN" in the title (an issue reference) is linked too. A commit
 * that reached trunk without a PR is listed without a link, and a plain
 * merge commit ("Merge pull request #NN ...") is listed under its body's
 * first line.
 *
 * @return {{lastTag: string, lines: string[]}|null} Null when no release
 *                                                   tag is reachable.
 */
const changesSinceLastRelease = () => {
	let lastTag;
	try {
		lastTag = run( 'git', [
			'describe',
			'--tags',
			'--abbrev=0',
			'--match',
			'v*',
		] );
	} catch {
		return null;
	}
	const linkRefs = ( text ) =>
		text.replace( /#(\d+)/g, `[#$1](${ repoUrl }/issues/$1)` );
	const lines = run( 'git', [
		'log',
		'--first-parent',
		'--format=%s%x1f%b%x1e',
		`${ lastTag }..HEAD`,
	] )
		.split( '\x1e' )
		.map( ( record ) => record.trim() )
		.filter( Boolean )
		.map( ( record ) => {
			let [ subject, body = '' ] = record.split( '\x1f' );
			subject = subject.trim();
			let pr = null;
			const squash = subject.match( /^(.*?)\s*\(#(\d+)\)$/ );
			const merge = subject.match( /^Merge pull request #(\d+)/ );
			if ( squash ) {
				[ , subject, pr ] = squash;
			} else if ( merge ) {
				pr = merge[ 1 ];
				subject =
					body
						.split( '\n' )
						.map( ( line ) => line.trim() )
						.find( Boolean ) || subject;
			}
			const link = pr ? ` ([#${ pr }](${ repoUrl }/pull/${ pr }))` : '';
			return `-   ${ linkRefs( subject ) }${ link }`;
		} )
		.filter( ( line ) => ! /^-   Release v\d/.test( line ) );
	return { lastTag, lines };
};

if ( dryRun ) {
	const changes = changesSinceLastRelease();
	if ( ! changes ) {
		die( 'no release tag (v*) is reachable from HEAD' );
	}
	console.log(
		`${ changes.lines.length } commit(s) since ${ changes.lastTag }:\n`
	);
	console.log( changes.lines.join( '\n' ) );
	process.exit( 0 );
}

if ( ! [ 'patch', 'minor', 'major' ].includes( type ) ) {
	die( 'usage: npm run release -- <patch|minor|major> [--dry-run]' );
}

if ( run( 'git', [ 'status', '--porcelain' ] ) !== '' ) {
	die( 'working tree is dirty; commit or stash first' );
}

run( 'npm', [ 'version', type, '--no-git-tag-version' ] );
const version = JSON.parse( readFileSync( 'package.json', 'utf8' ) ).version;

// Plugin header + version constant.
const entryPath = 'gutenberg-sync-engines.php';
let entry = readFileSync( entryPath, 'utf8' );
const stamped = entry
	.replace( /^( \* Version:\s+).*$/m, `$1${ version }` )
	.replace(
		/(define\( 'GUTENBERG_SYNC_ENGINES_VERSION', ')[^']*(' \);)/,
		`$1${ version }$2`
	);
if ( stamped === entry ) {
	die( `could not stamp the version into ${ entryPath }` );
}
writeFileSync( entryPath, stamped );

// `n.e.x.t` placeholders in tracked sources (WordPress convention for
// "the next released version" in @since tags).
let placeholderFiles = [];
try {
	placeholderFiles = run( 'git', [
		'grep',
		'-l',
		'n.e.x.t',
		'--',
		'*.php',
		'*.js',
		'*.ts',
		'*.tsx',
	] )
		.split( '\n' )
		.filter( Boolean );
} catch {
	// git grep exits 1 when nothing matches — no placeholders to replace.
}
for ( const file of placeholderFiles ) {
	writeFileSync(
		file,
		readFileSync( file, 'utf8' ).replaceAll( 'n.e.x.t', version )
	);
}

// Changelog: the "Unreleased" section becomes the new version's section.
// Hand-written highlights stay on top; the commits merged since the last
// release tag follow, each linked to its pull request. A fresh, empty
// "Unreleased" heading is left above for the next cycle.
const changelogPath = 'CHANGELOG.md';
const changelog = readFileSync( changelogPath, 'utf8' );
const headingIndex = changelog.search( /^## Unreleased$/m );
if ( headingIndex === -1 ) {
	die( 'CHANGELOG.md has no "## Unreleased" section' );
}
const afterHeading = headingIndex + '## Unreleased'.length;
const body = changelog.slice( afterHeading );
const nextHeading = body.search( /^## /m );
const highlights = (
	nextHeading === -1 ? body : body.slice( 0, nextHeading )
).trim();
const changes = changesSinceLastRelease();
if ( ! changes ) {
	die( 'no release tag (v*) is reachable from HEAD' );
}
if ( ! /^-/m.test( highlights ) && changes.lines.length === 0 ) {
	die(
		`nothing to release: no changelog highlights and no commits since ${ changes.lastTag }`
	);
}
const now = new Date();
const month = now.toLocaleString( 'en-US', { month: 'long' } );
const section = [
	'## Unreleased',
	'',
	`## ${ version } — ${ month } ${ now.getFullYear() }`,
	'',
	...( highlights ? [ highlights, '' ] : [] ),
	...( changes.lines.length
		? [
				`### All changes since ${ changes.lastTag }`,
				'',
				...changes.lines,
				'',
		  ]
		: [] ),
]
	.join( '\n' )
	.replace( /\n*$/, '\n\n' );
writeFileSync(
	changelogPath,
	changelog.slice( 0, headingIndex ) +
		section +
		changelog.slice(
			afterHeading + ( nextHeading === -1 ? body.length : nextHeading )
		)
);

const branch = `release/v${ version }`;
run( 'git', [ 'switch', '-c', branch ] );
run( 'git', [ 'add', '-A' ] );
run( 'git', [ 'commit', '--no-verify', '-m', `Release v${ version }` ] );

console.log( `Prepared ${ branch } (v${ version }).` );
