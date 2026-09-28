/**
 * External dependencies
 */
const path = require( 'path' );

/**
 * WordPress dependencies
 */
const defaultConfig = require( '@wordpress/scripts/config/jest-unit.config.js' );

// At runtime WordPress provides the framework (`@wordpress/sync`) and Yjs as
// `wp.sync`; under Jest there is no such global, so we resolve the framework
// from the pinned Gutenberg subtree in `./gutenberg` — the same copy wp-env
// and e2e run against — and pin `yjs` itself to the framework's SINGLE copy so
// the plugin and the framework share one Yjs instance
// (https://github.com/yjs/yjs/issues/438). y-protocols and lib0 are left to
// normal resolution so their package `exports` pick the CommonJS build Jest
// can load; being stateless, a duplicate of them is harmless as long as they
// bind to the one shared `yjs`. Requires the subtree to be installed and
// built (see Setup in AGENTS.md). Set WP_SYNC_FRAMEWORK_ROOT to test against
// a live framework checkout instead (co-development), mirroring the PHP
// bootstrap's WP_SYNC_FRAMEWORK_PLUGIN env override.
const FRAMEWORK_ROOT =
	process.env.WP_SYNC_FRAMEWORK_ROOT ||
	path.resolve( __dirname, 'gutenberg' );
const FRAMEWORK_MODULES = path.join( FRAMEWORK_ROOT, 'node_modules' );
const SYNC_SRC = path.join( FRAMEWORK_ROOT, 'packages/sync/src' );

module.exports = {
	...defaultConfig,
	// Discover ONLY this plugin's own tests. The pinned Gutenberg subtree in
	// `gutenberg/` carries thousands of the monorepo's own test files; without
	// this restriction Jest would recurse into it and run (and fail) them.
	roots: [ '<rootDir>/src', '<rootDir>/tests' ],
	// The frozen cross-language vector replay locates its fixture through
	// `import.meta.url`; Jest runs CommonJS, so transform it away with the same
	// plugin the framework's build uses. Overriding `transform` (rather than
	// adding a project babel config) keeps this scoped to Jest and leaves the
	// webpack build's babel untouched.
	transform: {
		'\\.(?:mjs|[jt]sx?)$': [
			require.resolve( 'babel-jest' ),
			{
				presets: [
					require.resolve( '@wordpress/babel-preset-default' ),
				],
				plugins: [
					require.resolve( 'babel-plugin-transform-import-meta' ),
				],
			},
		],
	},
	moduleNameMapper: {
		...( defaultConfig.moduleNameMapper || {} ),
		'^@wordpress/sync$': SYNC_SRC,
		// Stateless grammar parser used by the intent-log manager to read
		// persisted syncIds out of loaded record content; resolved from the
		// subtree so no plugin-local install is needed (at runtime it is the
		// wp-block-serialization-default-parser script).
		'^@wordpress/block-serialization-default-parser$': path.join(
			FRAMEWORK_MODULES,
			'@wordpress/block-serialization-default-parser'
		),
		'^yjs$': path.join( FRAMEWORK_MODULES, 'yjs' ),
		// The private-API lock lives in a module-scoped WeakMap; the framework
		// locks and the plugin unlocks, so both MUST share one copy of
		// @wordpress/private-apis (at runtime this is the single wp.privateApis).
		'^@wordpress/private-apis$': path.join(
			FRAMEWORK_MODULES,
			'@wordpress/private-apis'
		),
		// The framework reads provider creators through the `sync.providers`
		// hook filter that the tests write to; both sides must share one hooks
		// registry (the single wp.hooks at runtime).
		'^@wordpress/hooks$': path.join(
			FRAMEWORK_MODULES,
			'@wordpress/hooks'
		),
		// The slow-awareness store is a @wordpress/data store; resolve the
		// package from the subtree (the single wp.data at runtime).
		'^@wordpress/data$': path.join( FRAMEWORK_MODULES, '@wordpress/data' ),
		// The de-rtc doc bridge serializes/parses through the editor's block
		// library (the single wp.blocks at runtime); resolve it from the
		// subtree. Tests mock it — block registration is editor state.
		'^@wordpress/blocks$': path.join(
			FRAMEWORK_MODULES,
			'@wordpress/blocks'
		),
		// The conflict review UI's component tests (tests/js/review) render
		// real editor packages in jsdom: the block editor, the core blocks,
		// the editor's revisions differ. Every @wordpress package, React,
		// and Testing Library must then resolve to ONE copy, the subtree's,
		// or hooks and stores split across duplicates. These generic
		// mappers come AFTER the specific ones above, so `@wordpress/sync`
		// (the framework SOURCE) and the others keep winning.
		// ES-module-only subtree packages (no `require` entry in their export
		// map) are mapped to their module build by file, which babel-jest
		// transforms like the rest of the subtree.
		'^@wordpress/theme$': path.join(
			FRAMEWORK_ROOT,
			'packages/theme/build-module/index.mjs'
		),
		'^@wordpress/(.*)$': path.join( FRAMEWORK_MODULES, '@wordpress/$1' ),
		'^react$': path.join( FRAMEWORK_MODULES, 'react' ),
		'^react/(.*)$': path.join( FRAMEWORK_MODULES, 'react/$1' ),
		'^react-dom$': path.join( FRAMEWORK_MODULES, 'react-dom' ),
		'^react-dom/(.*)$': path.join( FRAMEWORK_MODULES, 'react-dom/$1' ),
		'^@testing-library/(.*)$': path.join(
			FRAMEWORK_MODULES,
			'@testing-library/$1'
		),
	},
	// `uuid` (a dependency of the subtree's components package) ships only
	// ES modules; Jest runs CommonJS, so let babel-jest transform it. Every
	// other node_modules package keeps the default (untransformed).
	transformIgnorePatterns: [ '/node_modules/(?!(uuid|marked|parsel-js|client-zip)/)', '\\.pnp\\.[^\\/]+$' ],
	setupFiles: [
		...( defaultConfig.setupFiles || [] ),
		path.join( __dirname, 'tests/js/jest-setup.js' ),
	],
	setupFilesAfterEnv: [
		...( defaultConfig.setupFilesAfterEnv || [] ),
		path.join( __dirname, 'tests/js/jest-setup-after-env.js' ),
	],
};
