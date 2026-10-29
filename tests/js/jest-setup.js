/**
 * External dependencies
 */
const { TextEncoder, TextDecoder } = require( 'util' );
const { webcrypto } = require( 'crypto' );

// The jsdom test environment does not provide the Encoding API globals that the
// framework's byte-accounting (and Yjs) rely on. Node ships them in `util`.
if ( typeof global.TextEncoder === 'undefined' ) {
	global.TextEncoder = TextEncoder;
}
if ( typeof global.TextDecoder === 'undefined' ) {
	global.TextDecoder = TextDecoder;
}

// The intent-log core mints identifiers via `crypto.randomUUID()`; jsdom's
// Crypto stub omits it. jsdom exposes `crypto` as a read-only accessor, so a
// plain assignment is a no-op — install via defineProperty, patching just
// `randomUUID` onto the existing Crypto when one is present.
if ( typeof global.crypto === 'undefined' ) {
	Object.defineProperty( global, 'crypto', {
		value: webcrypto,
		configurable: true,
	} );
} else if ( typeof global.crypto.randomUUID !== 'function' ) {
	Object.defineProperty( global.crypto, 'randomUUID', {
		value: webcrypto.randomUUID.bind( webcrypto ),
		configurable: true,
	} );
}

// The editor package registers viewport listeners at import time through
// `window.matchMedia`, which jsdom does not implement. The review UI's
// component tests import the editor store, so give them a stub that
// matches nothing (the desktop layout).
if ( typeof global.window !== 'undefined' && ! global.window.matchMedia ) {
	global.window.matchMedia = ( query ) => ( {
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	} );
}
