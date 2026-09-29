/**
 * Internal dependencies
 */
import { createSyncManager } from '../framework';
import { createConflictFanOut } from '../review/fan-out';
import {
	createDeRtcEngine,
	DE_RTC_ENGINE_PROTOCOL,
	DE_RTC_ENGINE_SLUG,
} from './de-rtc';

const conflicts = createConflictFanOut();

/**
 * The de-rtc engine's conflict source, registered from src/index.ts: every
 * engine this adapter created, as one source (see src/review/fan-out.ts).
 */
export const deRtcConflictSource = conflicts.source;

/**
 * The de-rtc engine adapter: Distributed Editing's save-centric model on
 * the room protocol. The client proposes whole content against the
 * version it last incorporated; the SERVER three-way-merges every
 * proposal with the ported DE-RTC merge core and announces each canonical
 * version. It composes the framework's engine-neutral sync manager
 * with this plugin's proposal-based engine.
 *
 * The engine's parked escalations reach the reviewer through the plugin's
 * own conflict review lane (src/review/), not the framework's: the
 * manager is composed WITHOUT the engine's `review` source, so the
 * framework's panel, notices, and resolution verbs stay idle.
 *
 * @return {Object} A SyncEngineAdapter for `registerSyncEngine`.
 */
export function createDeRtcEngineAdapter() {
	return {
		slug: DE_RTC_ENGINE_SLUG,
		protocolVersion: DE_RTC_ENGINE_PROTOCOL,
		createManager: ( debug?: boolean ) => {
			const engine = createDeRtcEngine();
			conflicts.add( engine.conflicts );
			return createSyncManager(
				{ ...engine, review: undefined },
				{ debug }
			);
		},
	};
}
