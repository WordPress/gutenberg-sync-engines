/**
 * `@wordpress/editor` ships no type declarations the plugin resolves (it is
 * externalized to `wp.editor` at build time and resolved from the vendored
 * subtree under Jest). Declare the two members the review UI's TypeScript
 * modules touch; the JSX components use the package untyped.
 */
declare module '@wordpress/editor' {
	export const privateApis: object;
	export const store: import('@wordpress/data').StoreDescriptor< unknown >;
}
