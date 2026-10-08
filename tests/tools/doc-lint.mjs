/**
 * Checks the prose files against the code, so a renamed file, option,
 * filter or class, a broken link, or a stale number is caught in CI.
 *
 *   node tests/tools/doc-lint.mjs            # every prose file
 *   node tests/tools/doc-lint.mjs docs/a.md  # just these files
 *
 * What it checks (from the 2026-10-07 documentation review, section 6.3;
 * the review itself lives in the git history, commit 510bbcbdaa):
 *
 * 1. Every backticked repo path (`src/...`, `includes/...`, `tests/...`,
 *    `docs/...`, `examples/...`, `bin/...`, `gutenberg/...`, a root
 *    file) exists.
 * 2. Every backticked name that looks like one of the plugin's options,
 *    filters, constants, classes or JavaScript hooks (the patterns in
 *    NAME_PATTERNS below) appears somewhere in the code. A name on a
 *    line, or under a heading, that says it is retired, removed or gone
 *    is allowed.
 * 3. Every relative Markdown link resolves, and its `#anchor` matches a
 *    heading in the target.
 * 4. `docs/README.md` links every page under docs/.
 * 5. Retired names appear only beside a word such as "retired" or
 *    "removed".
 * 6. A number wrapped as `<!-- const:NAME -->5<!-- /const -->` equals
 *    the constant NAME in the PHP or JavaScript source.
 * 7. AGENTS.md stays under a size limit, so detail goes into docs/,
 *    where the other checks can see it.
 *
 * Exit status 1 when anything fails. Fenced code blocks are skipped.
 */

/**
 * External dependencies
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
	path.dirname( fileURLToPath( import.meta.url ) ),
	'../..'
);

/** Directories never scanned for prose and never searched for names. */
const SKIP_DIRS = new Set( [
	'.git',
	'node_modules',
	'vendor',
	'build',
	'artifacts',
	'bench-results',
] );

/** Prose directories that are third-party code. */
const SKIP_PROSE = [ 'gutenberg/', 'includes/lib/' ];

/** Where a documented name must appear. */
const CODE_DIRS = [
	'includes',
	'src',
	'tests',
	'examples',
	'bin',
	'gutenberg/lib',
	'gutenberg/packages/sync/src',
	'gutenberg/packages/core-data/src',
	'.github',
];
const CODE_EXTENSIONS = new Set( [
	'.php',
	'.js',
	'.mjs',
	'.ts',
	'.tsx',
	'.json',
	'.yml',
	'.sh',
	'.dist',
] );

const PATH_PATTERN =
	/^(?:src|includes|tests|docs|examples|bin|gutenberg|\.github|\.claude)\/[A-Za-z0-9_.\/{},-]+$/;
const ROOT_FILE_PATTERN =
	/^\.?[A-Za-z0-9_.-]+\.(?:md|json|php|js|mjs|ts|yml|sh|dist|lock)$/;
const NAME_PATTERNS = [
	/^gutenberg_sync_engines_[a-z0-9_]+$/,
	/^wp_sync_[a-z0-9_]+$/,
	/^WP_SYNC_[A-Z0-9_]+$/,
	/^WP_[A-Z][A-Za-z0-9_]+$/,
	/^Gutenberg_Sync_Engines_[A-Za-z0-9_]+$/,
	/^sync\.[A-Za-z.]+$/,
];
const RETIRED_CONTEXT =
	/\b(retire\w*|remov\w*|gone|old|histor\w*|replac\w*|deleted|no longer|used to|before|was)\b/i;
/** A heading under which every line counts as history. */
const RETIRED_HEADING = /\b(removed|retired|history|historical|deprecated)\b/i;
const BANNED = [
	/yjs-relay/,
	/long-polling/,
	/review-manager-decorator/,
	/wp_collaboration_enabled/,
	/\bV1 item\b/,
	/\bTODO-[0-9]/,
	/post[- ]meta storage/,
];
const AGENTS_MAX_LINES = 700;

const problems = [];
function report( file, line, message ) {
	problems.push( `${ file }:${ line }: ${ message }` );
}

function walk( dir, accept, out = [] ) {
	for ( const entry of readdirSync( dir ) ) {
		if ( SKIP_DIRS.has( entry ) ) {
			continue;
		}
		const full = path.join( dir, entry );
		const stat = statSync( full );
		if ( stat.isDirectory() ) {
			walk( full, accept, out );
		} else if ( accept( full ) ) {
			out.push( full );
		}
	}
	return out;
}

function relative( file ) {
	return path.relative( ROOT, file ).split( path.sep ).join( '/' );
}

/** Prose files: every Markdown file outside the skipped trees. */
function proseFiles() {
	return walk( ROOT, ( file ) => {
		if ( ! file.endsWith( '.md' ) ) {
			return false;
		}
		const rel = relative( file );
		return ! SKIP_PROSE.some( ( prefix ) => rel.startsWith( prefix ) );
	} );
}

/** One string holding every code file, for name lookups. */
function codeCorpus() {
	const parts = [];
	for ( const dir of CODE_DIRS ) {
		const full = path.join( ROOT, dir );
		if ( ! existsSync( full ) ) {
			continue;
		}
		for ( const file of walk( full, ( f ) =>
			CODE_EXTENSIONS.has( path.extname( f ) )
		) ) {
			parts.push( readFileSync( file, 'utf8' ) );
		}
	}
	for ( const entry of readdirSync( ROOT ) ) {
		const full = path.join( ROOT, entry );
		if (
			statSync( full ).isFile() &&
			CODE_EXTENSIONS.has( path.extname( entry ) )
		) {
			parts.push( readFileSync( full, 'utf8' ) );
		}
	}
	return parts.join( '\n' );
}

/** Integer constants declared in PHP (`const X = 5;`) or JS (`const X = 5;`). */
function integerConstants() {
	const values = new Map();
	const pattern = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(-?\d+)\s*;/g;
	for ( const dir of [ 'includes', 'src' ] ) {
		for ( const file of walk( path.join( ROOT, dir ), ( f ) =>
			[ '.php', '.ts', '.js' ].includes( path.extname( f ) )
		) ) {
			if ( relative( file ).startsWith( 'includes/lib/' ) ) {
				continue;
			}
			const text = readFileSync( file, 'utf8' );
			for ( const match of text.matchAll( pattern ) ) {
				if ( ! values.has( match[ 1 ] ) ) {
					values.set( match[ 1 ], [] );
				}
				values.get( match[ 1 ] ).push( Number( match[ 2 ] ) );
			}
		}
	}
	return values;
}

/**
 * The lines of a file with fenced code blocks blanked out.
 *
 * @param {string} text File contents.
 * @return {string[]} Lines, code blocks replaced by empty lines.
 */
function proseLines( text ) {
	const lines = text.split( '\n' );
	let inFence = false;
	return lines.map( ( line ) => {
		if ( /^\s*(```|~~~)/.test( line ) ) {
			inFence = ! inFence;
			return '';
		}
		return inFence ? '' : line;
	} );
}

/**
 * For each line, the headings above it, outermost first.
 *
 * @param {string[]} lines Prose lines.
 * @return {string[]} The joined heading path in force on each line.
 */
function headingFor( lines ) {
	const stack = [];
	return lines.map( ( line ) => {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec( line );
		if ( match ) {
			stack.length = match[ 1 ].length - 1;
			stack[ match[ 1 ].length - 1 ] = match[ 2 ];
		}
		return stack.filter( Boolean ).join( ' / ' );
	} );
}

/**
 * GitHub-style heading anchors of a Markdown file.
 *
 * @param {string} text File contents.
 * @return {Set<string>} Anchor slugs.
 */
function headingSlugs( text ) {
	const slugs = new Set();
	for ( const line of proseLines( text ) ) {
		const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec( line );
		if ( ! match ) {
			continue;
		}
		const slug = match[ 1 ]
			.replace( /`/g, '' )
			.replace( /\[([^\]]*)\]\([^)]*\)/g, '$1' )
			.toLowerCase()
			.replace( /[^\p{L}\p{N}\s-]/gu, '' )
			.trim()
			.replace( / /g, '-' );
		slugs.add( slug );
	}
	return slugs;
}

function expandBraces( value ) {
	const match = /^(.*?)\{([^{}]*)\}(.*)$/.exec( value );
	if ( ! match ) {
		return [ value ];
	}
	return match[ 2 ]
		.split( ',' )
		.flatMap( ( option ) =>
			expandBraces( match[ 1 ] + option + match[ 3 ] )
		);
}

function checkPaths( file, lines ) {
	lines.forEach( ( line, index ) => {
		for ( const match of line.matchAll( /`([^`]+)`/g ) ) {
			let span = match[ 1 ].trim();
			if ( /[*<>$…]|\.\.\./.test( span ) ) {
				continue;
			}
			span = span.replace( /:\d+(-\d+)?$/, '' ).replace( /\/$/, '' );
			if (
				! PATH_PATTERN.test( span ) &&
				! ROOT_FILE_PATTERN.test( span )
			) {
				continue;
			}
			if (
				ROOT_FILE_PATTERN.test( span ) &&
				! PATH_PATTERN.test( span ) &&
				! existsSync( path.join( ROOT, span ) )
			) {
				// A bare file name is a path only when it exists at the root; otherwise it is
				// a file named relative to some folder the prose already gave, which is fine.
				continue;
			}
			for ( const candidate of expandBraces( span ) ) {
				if ( ! existsSync( path.join( ROOT, candidate ) ) ) {
					report(
						file,
						index + 1,
						`path does not exist: \`${ candidate }\``
					);
				}
			}
		}
	} );
}

function checkNames( file, lines, corpus ) {
	const headings = headingFor( lines );
	lines.forEach( ( line, index ) => {
		for ( const match of line.matchAll( /`([^`]+)`/g ) ) {
			const span = match[ 1 ]
				.trim()
				.replace( /(::[A-Za-z_]+)?\(\)$/, '' )
				.replace( /::[A-Z_]+$/, '' );
			if ( /[*<>$…\s]/.test( span ) ) {
				continue;
			}
			if ( ! NAME_PATTERNS.some( ( pattern ) => pattern.test( span ) ) ) {
				continue;
			}
			if ( corpus.includes( span ) ) {
				continue;
			}
			if (
				RETIRED_CONTEXT.test( line ) ||
				RETIRED_HEADING.test( headings[ index ] )
			) {
				continue;
			}
			report(
				file,
				index + 1,
				`name not found in the code: \`${ span }\``
			);
		}
	} );
}

function checkLinks( file, lines ) {
	lines.forEach( ( line, index ) => {
		for ( const match of line.matchAll( /\[[^\]]*\]\(([^)\s]+)\)/g ) ) {
			const target = match[ 1 ];
			if ( /^(https?:|mailto:)/.test( target ) ) {
				continue;
			}
			const [ targetPath, anchor ] = target.split( '#' );
			const resolved = targetPath
				? path.resolve( path.dirname( file ), targetPath )
				: file;
			if ( ! existsSync( resolved ) ) {
				report(
					file,
					index + 1,
					`link target does not exist: ${ target }`
				);
				continue;
			}
			if ( anchor && resolved.endsWith( '.md' ) ) {
				const slugs = headingSlugs( readFileSync( resolved, 'utf8' ) );
				if ( ! slugs.has( anchor ) ) {
					report(
						file,
						index + 1,
						`anchor not found in ${ relative(
							resolved
						) }: #${ anchor }`
					);
				}
			}
		}
	} );
}

function checkBanned( file, lines ) {
	const headings = headingFor( lines );
	lines.forEach( ( line, index ) => {
		for ( const pattern of BANNED ) {
			if (
				pattern.test( line ) &&
				! RETIRED_CONTEXT.test( line ) &&
				! RETIRED_HEADING.test( headings[ index ] )
			) {
				report(
					file,
					index + 1,
					`retired name without a word like "retired" or "removed" beside it: ${ pattern.source }`
				);
			}
		}
	} );
}

function checkConstants( file, text, constants ) {
	const pattern =
		/<!--\s*const:([A-Z][A-Z0-9_]+)\s*-->\s*(-?\d+)\s*<!--\s*\/const\s*-->/g;
	for ( const match of text.matchAll( pattern ) ) {
		const line = text.slice( 0, match.index ).split( '\n' ).length;
		const [ , name, written ] = match;
		const found = constants.get( name );
		if ( ! found ) {
			report(
				file,
				line,
				`no integer constant named ${ name } in includes/ or src/`
			);
		} else if ( ! found.includes( Number( written ) ) ) {
			report(
				file,
				line,
				`${ name } is ${ found.join(
					' or '
				) } in the code, the doc says ${ written }`
			);
		}
	}
}

function checkIndex( files ) {
	const indexFile = path.join( ROOT, 'docs/README.md' );
	const index = readFileSync( indexFile, 'utf8' );
	const linked = new Set();
	for ( const match of index.matchAll( /\]\(([^)\s#]+)(?:#[^)]*)?\)/g ) ) {
		linked.add( path.resolve( path.dirname( indexFile ), match[ 1 ] ) );
	}
	const docsDir = path.join( ROOT, 'docs' );
	for ( const file of walk( docsDir, ( f ) => f.endsWith( '.md' ) ) ) {
		const rel = relative( file );
		if ( rel === 'docs/README.md' ) {
			continue;
		}
		if ( ! linked.has( file ) ) {
			report( 'docs/README.md', 1, `does not link ${ rel }` );
		}
	}
	return files;
}

function checkAgentsSize() {
	const text = readFileSync( path.join( ROOT, 'AGENTS.md' ), 'utf8' );
	const count = text.split( '\n' ).length;
	if ( count > AGENTS_MAX_LINES ) {
		report(
			'AGENTS.md',
			count,
			`is ${ count } lines; the limit is ${ AGENTS_MAX_LINES }. Move behavior text into docs/ and link it.`
		);
	}
}

function main() {
	const requested = process.argv
		.slice( 2 )
		.map( ( f ) => path.resolve( ROOT, f ) );
	const files = requested.length ? requested : proseFiles();
	const corpus = codeCorpus();
	const constants = integerConstants();
	for ( const file of files ) {
		const rel = relative( file );
		const text = readFileSync( file, 'utf8' );
		const lines = proseLines( text );
		checkPaths( rel, lines );
		checkNames( rel, lines, corpus );
		checkLinks( file, lines );
		checkBanned( rel, lines );
		checkConstants( rel, text, constants );
	}
	if ( ! requested.length ) {
		checkIndex( files );
		checkAgentsSize();
	}
	if ( problems.length ) {
		// eslint-disable-next-line no-console
		console.error( problems.join( '\n' ) );
		// eslint-disable-next-line no-console
		console.error( `\ndoc-lint: ${ problems.length } problem(s).` );
		process.exit( 1 );
	}
	// eslint-disable-next-line no-console
	console.log(
		`doc-lint: ${ files.length } prose files checked, no problems.`
	);
}

main();
