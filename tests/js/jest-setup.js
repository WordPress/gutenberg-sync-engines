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
