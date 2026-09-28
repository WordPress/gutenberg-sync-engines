/**
 * Internal dependencies
 */
import { createHttpPollingProvider } from '../http-polling/http-polling-provider';
import { setSseMode } from '../http-polling/polling-manager';
import type { ProviderCreator } from '@wordpress/sync';

/** Use the same send queue, recovery, presence, and cursor handling as polling. */
export function createSseProvider(): ProviderCreator {
	setSseMode( true );
	return createHttpPollingProvider();
}
