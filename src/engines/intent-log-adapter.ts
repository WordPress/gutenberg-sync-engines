/**
 * Internal dependencies
 */
import { registerConflictSource } from '../review/conflicts';
import { createIntentLogManager } from './intent-log-manager';
import {
	INTENT_LOG_ENGINE_SLUG,
	INTENT_LOG_ENGINE_PROTOCOL,
} from './intent-log-session';

/**
 * The intent-log engine adapter: a server-authoritative log of typed
 * intents. Its manager owns the capture bridge and session codec. Each
 * manager's conflict source is registered with the conflict registry on
 * creation.
 *
 * @return {Object} A SyncEngineAdapter for `registerSyncEngine`.
 */
export function createIntentLogEngineAdapter() {
	return {
		slug: INTENT_LOG_ENGINE_SLUG,
		protocolVersion: INTENT_LOG_ENGINE_PROTOCOL,
		createManager: ( debug?: boolean ) => {
			const manager = createIntentLogManager( debug );
			registerConflictSource( manager.conflicts );
			return manager;
		},
	};
}
