/**
 * WordPress dependencies
 */
import { applyFilters } from '@wordpress/hooks';

export const DEFAULT_CLIENT_LIMIT_PER_ROOM = 3;

// Retry delays after poll failures.
// The disconnect dialog shows after all retries are exhausted, then retries
// continue at DISCONNECT_DIALOG_RETRY_MS.
export const ERROR_RETRY_DELAYS_SOLO_MS = [
	2000, 4000, 8000, 12000,
	// Solo: 26s total retry time solo before dialog
];
export const ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS = [
	1000, 2000, 4000, 8000,
	// With collaborators: 15s total retry time before dialog
];

// How often to automatically retry the connection when in the disconnect dialog.
export const DISCONNECT_DIALOG_RETRY_MS = 30000;

// When a user manually retries on the disconnection dialog, the amount of time
// until the next automatic retry attempt.
export const MANUAL_RETRY_INTERVAL_MS = 15000;

const MAX_ENCODED_UPDATE_SIZE_IN_BYTES = 1 * 1024 * 1024; // 1 MB

// The server validates the base64-encoded `data` string against a 1 MB
// maxLength. Base64 encodes three raw bytes as four characters, so cap the raw
// Yjs update size to the largest value that cannot exceed the server limit.
export const MAX_UPDATE_SIZE_IN_BYTES =
	Math.floor( MAX_ENCODED_UPDATE_SIZE_IN_BYTES / 4 ) * 3;

// Corresponds with server-side
// WP_HTTP_Polling_Sync_Server::MAX_ROOMS_PER_REQUEST.
export const MAX_ROOMS_PER_REQUEST = 50;

// Corresponds with server-side
// WP_HTTP_Polling_Sync_Server::MAX_BODY_SIZE, with 1 MiB of headroom for
// serialization details and future metadata.
export const MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES = 15 * 1024 * 1024;

// Keep a single maximum-sized encoded update plus room metadata sendable if a
// request-body-too-large response forces the client to shrink its retry budget.
export const MIN_SYNC_REQUEST_BODY_SIZE_LIMIT_IN_BYTES = 2 * 1024 * 1024;

const DEFAULT_POLLING_INTERVAL_IN_MS = 4000; // 4 seconds
const DEFAULT_POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS = 1000; // 1 second

// Must be less than the server-side AWARENESS_TIMEOUT (30 s) to avoid
// false disconnects when the tab is in the background.
export const POLLING_INTERVAL_BACKGROUND_TAB_IN_MS = 25 * 1000; // 25 seconds

/**
 * Reads the polling interval chosen on Settings → Collaboration, in
 * milliseconds. The plugin injects it as an inline script before this bundle
 * loads (`window._gutenbergSyncEnginesSettings`). Returns 0 when the site
 * keeps the defaults. Capped at the background-tab cadence so a large value
 * can never trip the server's 30-second awareness timeout.
 */
function getSitePollingIntervalMs(): number {
	const settings = (
		window as {
			_gutenbergSyncEnginesSettings?: {
				httpPollingIntervalMs?: number;
			};
		}
	 )._gutenbergSyncEnginesSettings;
	const value = Number( settings?.httpPollingIntervalMs ?? 0 );

	if ( ! Number.isFinite( value ) || value <= 0 ) {
		return 0;
	}

	return Math.min( value, POLLING_INTERVAL_BACKGROUND_TAB_IN_MS );
}

/*
 * The site setting sets the cadence while collaborating — the interval that
 * dominates request volume and how quickly peers see each other's edits.
 * Solo polling only watches for a collaborator arriving, so it keeps its
 * slower default unless the chosen interval is slower still (polling faster
 * alone than while collaborating would be pure waste).
 */
const sitePollingIntervalMs = getSitePollingIntervalMs();
const BASE_POLLING_INTERVAL_IN_MS =
	sitePollingIntervalMs > 0
		? Math.max( sitePollingIntervalMs, DEFAULT_POLLING_INTERVAL_IN_MS )
		: DEFAULT_POLLING_INTERVAL_IN_MS;
const BASE_POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS =
	sitePollingIntervalMs > 0
		? sitePollingIntervalMs
		: DEFAULT_POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS;

function getFilteredPollingInterval(
	hookName: string,
	defaultInterval: number
): number {
	const filteredInterval = applyFilters( hookName, defaultInterval );

	if (
		typeof filteredInterval !== 'number' ||
		! Number.isFinite( filteredInterval ) ||
		filteredInterval <= 0
	) {
		return defaultInterval;
	}

	return Math.min( filteredInterval, defaultInterval );
}

export const POLLING_INTERVAL_IN_MS = getFilteredPollingInterval(
	'sync.pollingManager.pollingInterval',
	BASE_POLLING_INTERVAL_IN_MS
);

export const POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS =
	getFilteredPollingInterval(
		'sync.pollingManager.pollingIntervalWithCollaborators',
		BASE_POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS
	);

/*
 * Advisory-channel cadences (docs/plan/advisory-channel.md). While every
 * known peer is reachable over the channel there is no timer at all;
 * polls happen on demand — shortly after the first queued local update,
 * shortly after a peer announces new rows (coalesced, with a floor that
 * bounds a storm of announcements), and when a heartbeat answer reports
 * the room's head cursor ahead of this tab's.
 */
export const LOCAL_UPDATE_POLL_DELAY_MS = 300;
export const ANNOUNCE_POLL_COALESCE_MS = 150;
export const ANNOUNCE_POLL_MIN_GAP_MS = 250;
// How long after the page loads, or the tab regains focus, a lone tab
// keeps the solo cadence before dropping to the safety poll.
export const FAST_DISCOVERY_WINDOW_MS = 30000;
