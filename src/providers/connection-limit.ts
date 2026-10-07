/**
 * WordPress dependencies
 */
import { applyFilters } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import { DEFAULT_CLIENT_LIMIT_PER_ROOM } from './http-polling/config';
import { intValueOrDefault } from './http-polling/utils';

/**
 * Gets the total editor limit shared by polling, SSE, and WebSocket.
 * Keep the existing filter name so site overrides and benchmarks still work.
 *
 * @param room Primary room being joined.
 * @return Maximum total editor connections.
 */
export function getClientLimitPerRoom( room: string ): number {
	return intValueOrDefault(
		applyFilters(
			'sync.pollingProvider.maxClientsPerRoom',
			DEFAULT_CLIENT_LIMIT_PER_ROOM,
			room
		),
		DEFAULT_CLIENT_LIMIT_PER_ROOM
	);
}
