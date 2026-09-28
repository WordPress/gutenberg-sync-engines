/**
 * Genesis syncId — the JS reference implementation of the cross-language
 * contract in `test-vectors/sync-id.json`.
 *
 * The editor never mints genesis ids from this code: the server does
 * (`WP_Intent_Log_Planner::genesis_sync_id`), and the build-free stamper
 * script (`includes/engines/intent-log/sync-id.js`) mirrors it with
 * WebCrypto. This module exists for the Node-side tooling only — the
 * simulator, the Jest harness, the vector generators, and the e2e specs —
 * which is why it can lean on `node:crypto` for a synchronous, exact
 * SHA-256 instead of carrying its own.
 *
 * See SPEC.md ("Block identity").
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/**
 * Immutable saved-revision descriptor a genesis syncId is derived from.
 *
 * @typedef {Object} GenesisRevision
 * @property {number} postId     Post ID.
 * @property {number} revisionId Revision ID the content was read from.
 */

const GENESIS_ID_BYTES = 16;

/**
 * Throws unless `value` is a non-negative integer.
 *
 * @param {unknown} value Value to check.
 * @param {string}  label Name used in the error message.
 */
function assertNonNegativeInt( value, label ) {
	if ( ! Number.isInteger( value ) || /** @type {number} */ ( value ) < 0 ) {
		throw new TypeError( `${ label } must be a non-negative integer` );
	}
}

/**
 * Canonical input string for the genesis hash. This exact string, UTF-8
 * encoded, is what both the JS and PHP implementations must hash.
 *
 * @param {GenesisRevision} revision Immutable revision descriptor.
 * @param {number[]}        path     Block path within the revision (child
 *                                   indices from the root).
 * @return {string} Canonical input.
 */
export function canonicalGenesisInput( revision, path ) {
	assertNonNegativeInt( revision?.postId, 'postId' );
	assertNonNegativeInt( revision?.revisionId, 'revisionId' );
	if ( ! Array.isArray( path ) ) {
		throw new TypeError( 'path must be an array of child indices' );
	}
	for ( const index of path ) {
		assertNonNegativeInt( index, 'path index' );
	}
	return `${ revision.postId }:${ revision.revisionId }:${ path.join(
		'.'
	) }`;
}

/**
 * Deterministic genesis syncId for a block that exists in a saved revision:
 * `base64url( sha256( canonicalInput )[ 0..16 ) )`, unpadded.
 *
 * Pure function of the revision descriptor and block path — it structurally
 * cannot observe live editor state. Any number of independent minters agree.
 *
 * @param {GenesisRevision} revision Immutable revision descriptor.
 * @param {number[]}        path     Block path within the revision.
 * @return {string} 22-character base64url syncId.
 */
export function genesisSyncId( revision, path ) {
	const digest = createHash( 'sha256' )
		.update( canonicalGenesisInput( revision, path ), 'utf8' )
		.digest();
	return Buffer.from( digest.subarray( 0, GENESIS_ID_BYTES ) ).toString(
		'base64url'
	);
}
