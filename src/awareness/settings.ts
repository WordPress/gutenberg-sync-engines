/**
 * Internal dependencies
 */
import type { SlowAwarenessSettings } from './types';

/**
 * Reads the mode settings the server injected before the bundle
 * (`window._gutenbergSyncEnginesSettings`).
 *
 * @return The settings; `intervalMs` is 0 when the mode is off.
 */
export function readSlowAwarenessSettings(): SlowAwarenessSettings {
	const settings = (
		window as {
			_gutenbergSyncEnginesSettings?: {
				awarenessIntervalMs?: number;
				awarenessChannel?: string;
			};
		}
	 )._gutenbergSyncEnginesSettings;
	const intervalMs = Number( settings?.awarenessIntervalMs ?? 0 );
	return {
		intervalMs:
			Number.isFinite( intervalMs ) && intervalMs > 0 ? intervalMs : 0,
		channel:
			'heartbeat' === settings?.awarenessChannel ? 'heartbeat' : 'sync',
	};
}
