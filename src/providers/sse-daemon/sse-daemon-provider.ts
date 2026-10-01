/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import type { ProviderCreator } from '@wordpress/sync';
import { createSseProvider } from '../sse/sse-provider';
import {
	setSseAuthProvider,
	setSseStreamHoldsWorker,
	setSseStreamUrl,
} from '../http-polling/polling-manager';

/** Where the one-time token is minted, the same route the socket uses. */
const TOKEN_API_PATH = '/wp-sync/v1/ws-token';

/**
 * The announced stream URL, published by the plugin's PHP half through the
 * framework's `wp_sync_transport_client_config` filter.
 *
 * @return {string} Stream URL.
 */
function streamUrl(): string {
	const transportConfig = (
		window as Window & {
			_wpCollaborationTransportConfig?: {
				'sse-daemon'?: { url?: string };
			};
		}
	 )._wpCollaborationTransportConfig;
	const url = transportConfig?.[ 'sse-daemon' ]?.url;
	if ( ! url ) {
		throw new Error( 'SSE daemon URL is not configured' );
	}
	return url;
}

/**
 * Mints a one-time token for one stream open.
 *
 * The same credential, route and lifetime the websocket transport's daemon
 * checks on handshake. A handshake can only carry the token in a
 * subprotocol offer, so it travels there; an ordinary request sets a
 * header, so it travels here. The daemon treats both alike and requires
 * the token's user to match the `logged_in` cookie's.
 *
 * Asked for PER OPEN rather than once: the daemon consumes the token the
 * first time it sees it, so a cached one would authenticate the first
 * stream and fail every reconnect after it.
 *
 * @return {Promise<Object>} The headers for one open.
 */
async function streamAuthHeaders(): Promise< Record< string, string > > {
	const response = ( await apiFetch( {
		method: 'POST',
		path: TOKEN_API_PATH,
	} ) ) as { token?: string };
	if ( ! response?.token ) {
		throw new Error( 'Invalid ws-token response' );
	}
	return {
		Authorization: `Bearer ${ response.token }`,
	};
	// The session cookie the token is checked against is a FETCH option
	// (`credentials: 'include'`), set where the request is made — not a
	// header here, which would send a literal `credentials` header name.
}

/**
 * The `sse-daemon` transport: the same receive stream the `sse` transport
 * already speaks, opened against the sync daemon rather than a web worker.
 *
 * The send queue, recovery, presence and cursor handling are the polling
 * manager's, unchanged — only the endpoint and the credential differ. The
 * daemon is the process the websocket transport already uses, on the same
 * port; this is the framing for networks that break the WebSocket upgrade
 * but pass ordinary chunked responses.
 *
 * SYNCHRONOUS on purpose: the framework's transport registration is
 * `create: () => ProviderCreator`, so this must hand back the provider
 * function itself. An async factory would return a Promise where the
 * framework expects a function, and negotiation would silently fail.
 */
export function createSseDaemonProvider(): ProviderCreator {
	setSseStreamUrl( streamUrl() );
	setSseAuthProvider( streamAuthHeaders );

	const provider = createSseProvider();

	/*
	 * Applied AFTER the shared setup, which is where SSE mode is turned
	 * on: the stream is served by the sync daemon's own process rather
	 * than by a web request, so it holds no PHP worker and a hidden tab
	 * keeps it.
	 */
	setSseStreamHoldsWorker( false );

	return provider;
}
