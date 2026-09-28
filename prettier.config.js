// Mirror Gutenberg's formatting: re-export the WordPress prettier config,
// with JSON on two spaces (npm rewrites package.json that way on every
// install, and JSON has no code to line up with the tab-indented sources).
const wordpressConfig = require( '@wordpress/prettier-config' );

module.exports = {
	...wordpressConfig,
	overrides: [
		...( wordpressConfig.overrides ?? [] ),
		{
			files: '*.json',
			options: {
				useTabs: false,
				tabWidth: 2,
			},
		},
	],
};
