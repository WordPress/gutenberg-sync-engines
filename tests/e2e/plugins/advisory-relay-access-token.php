<?php
/**
 * Plugin Name: Gutenberg Test Plugin, Advisory Relay Access Token
 * Description: E2E fixture: switches WebSocket access-token mode on with a fixed test secret, the one the websocket e2e config starts the example advisory relay (examples/advisory-relay/relay.mjs) with. The spec points the WebSocket URL setting at the relay. Active only during the collaboration-websocket-advisory-relay spec.
 * Version: 0.0.0-fixture
 * Author: Gutenberg Sync Engines e2e fixtures
 * License: GPL-2.0-or-later
 *
 * @package GutenbergSyncEngines
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// The same value tests/e2e/playwright.rtc-websocket.config.ts starts the
// relay with. Test-only; never use this secret anywhere real.
define( 'GUTENBERG_SYNC_ENGINES_E2E_RELAY_ACCESS_TOKEN_SECRET', 'e2e-advisory-relay-access-token-secret-not-for-production-0123456789' );

add_filter(
	'wp_sync_websocket_access_token_secret',
	static function () {
		return GUTENBERG_SYNC_ENGINES_E2E_RELAY_ACCESS_TOKEN_SECRET;
	}
);
