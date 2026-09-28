// The review UI's component tests assert with Testing Library's DOM
// matchers (toBeVisible, toHaveClass, ...); resolved from the subtree by
// the moduleNameMapper, like Testing Library itself.
require( '@testing-library/jest-dom' );

// Some suites re-import the module graph with `jest.isolateModules`, which
// re-executes Yjs's module body. Yjs guards against being imported twice via a
// flag on the global object and `console.error`s the "already imported" warning
// on the second run (https://github.com/yjs/yjs/issues/438). Under Jest that
// re-execution is deliberate and benign — one Yjs copy is mapped in — but
// @wordpress/jest-console escalates the stray error into a failure. Clearing
// the flag before each test makes every re-import look like a first import.
beforeEach( () => {
	delete globalThis[ '__ $YJS$ __' ];
} );
