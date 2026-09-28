/**
 * Internal dependencies
 */
import { createSyncManager } from '../framework';
import {
	createDeRtcEngine,
	DE_RTC_ENGINE_PROTOCOL,
	DE_RTC_ENGINE_SLUG,
} from './de-rtc';
import type { SyncConflictSource } from '../review/types';

type DeRtcEngine = ReturnType< typeof createDeRtcEngine >;

/*
 * The conflict review lane (src/review/) takes the engine's conflict
 * source at module load, but engines are created per session (the
 * framework asks the adapter for a manager). So the registered source is
 * a fan-out over every engine this adapter created: reads union them,
 * subscriptions attach to each, and an engine created after a
 * subscription started is attached on creation.
 */
const engines = new Set< DeRtcEngine >();

interface Subscription {
	objectType: string;
	objectId: string | null;
	listener: () => void;
	unsubscribes: Map< DeRtcEngine, () => void >;
}

const subscriptions = new Set< Subscription >();

function attach( subscription: Subscription, engine: DeRtcEngine ): void {
	if ( subscription.unsubscribes.has( engine ) ) {
		return;
	}
	subscription.unsubscribes.set(
		engine,
		engine.conflicts.subscribe(
			subscription.objectType,
			subscription.objectId,
			subscription.listener
		)
	);
}

function registerEngine( engine: DeRtcEngine ): void {
	engines.add( engine );
	subscriptions.forEach( ( subscription ) => {
		attach( subscription, engine );
		subscription.listener();
	} );
}

/**
 * The de-rtc engine's conflict source, registered from src/index.ts.
 */
export const deRtcConflictSource: SyncConflictSource = {
	getOpenConflicts: ( objectType, objectId ) =>
		Array.from( engines ).flatMap( ( engine ) =>
			engine.conflicts.getOpenConflicts( objectType, objectId )
		),
	subscribe: ( objectType, objectId, listener ) => {
		const subscription: Subscription = {
			objectType,
			objectId,
			listener,
			unsubscribes: new Map(),
		};
		engines.forEach( ( engine ) => attach( subscription, engine ) );
		subscriptions.add( subscription );
		return () => {
			subscription.unsubscribes.forEach( ( unsubscribe ) =>
				unsubscribe()
			);
			subscriptions.delete( subscription );
		};
	},
	resolveConflict: ( objectType, objectId, conflictId, decision ) => {
		for ( const engine of engines ) {
			const open = engine.conflicts.getOpenConflicts(
				objectType,
				objectId
			);
			if ( open.some( ( conflict ) => conflict.id === conflictId ) ) {
				engine.conflicts.resolveConflict(
					objectType,
					objectId,
					conflictId,
					decision
				);
				return;
			}
		}
	},
};

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
			registerEngine( engine );
			return createSyncManager(
				{ ...engine, review: undefined },
				{ debug }
			);
		},
	};
}
