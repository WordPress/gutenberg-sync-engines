/**
 * WordPress dependencies
 */
const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );

/**
 * The plugin ships a single client bundle containing its engine adapters,
 * transport providers, and sync manager. It registers one entity provider
 * with Gutenberg's core-data package.
 *
 * `@wordpress/sync` and Yjs are provided at runtime by WordPress as `wp.sync`
 * (and `wp.sync.Y`); they must NOT be bundled, so that this plugin consumes the
 * SAME Yjs instance as the editor (see https://github.com/yjs/yjs/issues/438).
 */
module.exports = {
	...defaultConfig,
	entry: {
		'sync-engines': './src/index.ts',
	},
	externals: {
		...defaultConfig.externals,
		'@wordpress/sync': 'wp.sync',
		yjs: 'wp.sync.Y',
	},
};
