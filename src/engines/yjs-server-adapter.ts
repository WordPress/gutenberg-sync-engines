/**
 * Internal dependencies
 */
import { createSyncManager } from '../framework';
import { registerConflictSource } from '../review/conflicts';
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
 * engine. Each engine's conflict source (its security holds) is
 * registered with the conflict registry on creation.
 *
 * @return {Object} A SyncEngineAdapter for `registerSyncEngine`.
 */
export function createYjsServerEngineAdapter() {
	return {
		slug: YJS_SERVER_ENGINE_SLUG,
		protocolVersion: YJS_SERVER_ENGINE_PROTOCOL,
		createManager: ( debug?: boolean ) => {
			const engine = createYjsServerEngine();
			registerConflictSource( engine.conflicts );
			return createSyncManager( engine, { debug } );
		},
	};
}
