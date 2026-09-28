/**
 * Block identity (syncId) — two-regime minting.
 *
 * Genesis: deterministic, computed ONLY from an immutable saved revision.
 * Creation: random, minted at the moment a block is born.
 *
 * Only the creation regime lives here. Genesis ids are minted by the server
 * (`WP_Intent_Log_Planner::genesis_sync_id`) and by the build-free stamper
 * script (`includes/engines/intent-log/sync-id.js`); the JS reference
 * implementation that the frozen vectors pin lives with the harness at
 * `tests/js/engines/intent-log/genesis-sync-id.js`. See SPEC.md.
 */

/**
 * Random syncId for a block born during a session (insert, paste-as-new,
 * split-second-half). Each creation event gets a unique identity; this is
 * what preserves both users' paragraphs when they concurrently insert at the
 * same position.
 *
 * @param {() => number} [random] Optional seeded RNG returning [0, 1), for
 *                                deterministic simulation. Defaults to
 *                                crypto randomness.
 * @return {string} Opaque syncId.
 */
export function mintSyncId( random ) {
	if ( ! random ) {
		// Browser and Node (>=19) global; secure contexts only, like the
		// rest of the collaboration stack.
		return globalThis.crypto.randomUUID();
	}
	let id = '';
	for ( let i = 0; i < 32; i++ ) {
		id += Math.floor( random() * 16 ).toString( 16 );
	}
	return id;
}
