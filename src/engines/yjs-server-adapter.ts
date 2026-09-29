/**
 * Internal dependencies
 */
import { createSyncManager } from '../framework';
import { createConflictFanOut } from '../review/fan-out';
import {
	YJS_SERVER_ENGINE_SLUG,
	YJS_SERVER_ENGINE_PROTOCOL,
	createYjsServerEngine,
} from './yjs-server';

/**
 * The yjs-server engine adapter: the relay's CRDT machinery with the
 * canonical document owned by the SERVER (merged, compacted, and
 * materialized in PHP via the vendored y-php). It composes the framework's
 * engine-neutral sync manager with this plugin's server-authoritative Yjs
 * engine.
 *
 * @return {Object} A SyncEngineAdapter for `registerSyncEngine`.
 */
const conflicts = createConflictFanOut();

/**
 * The yjs-server engine's conflict source, registered from src/index.ts:
 * the security holds of every engine this adapter created, as one source
 * (see src/review/fan-out.ts).
 */
export const yjsServerConflictSource = conflicts.source;

export function createYjsServerEngineAdapter() {
	return {
		slug: YJS_SERVER_ENGINE_SLUG,
		protocolVersion: YJS_SERVER_ENGINE_PROTOCOL,
		createManager: ( debug?: boolean ) => {
			const engine = createYjsServerEngine();
			conflicts.add( engine.conflicts );
			return createSyncManager( engine, { debug } );
		},
	};
}
