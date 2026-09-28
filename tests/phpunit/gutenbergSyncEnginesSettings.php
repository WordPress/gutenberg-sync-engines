<?php
/**
 * Tests for the Settings → Collaboration screen's model: the "Transport"
 * list that stands for a (transport, advisory channel) pair and stores
 * nothing itself, the WebSocket server URLs, and the polling interval's
 * default.
 *
 * @package gutenberg-sync-engines
 *
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesSettings extends WP_UnitTestCase {
	public function tear_down() {
		foreach (
			array(
				Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION,
				Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION,
				Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD,
				Gutenberg_Sync_Engines_Settings::WEBSOCKET_URL_OPTION,
				Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION,
				Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION,
				Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION,
				Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION,
			) as $option
		) {
			delete_option( $option );
		}
		parent::tear_down();
	}

	public function test_the_transport_list_reads_the_stored_pair() {
		$cases = array(
			array( 'http-polling', '', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING ),
			array( 'http-polling', 'webrtc-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC ),
			array( 'http-polling', 'web-rtc', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC ),
			array( 'http-polling', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBSOCKET ),
			// A preferred transport maps to its entry whatever fallback
			// channel is stored.
			// The retired long-polling transport reads as its successor.
			array( 'http-long-polling', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_SSE ),
			array( 'websocket', '', Gutenberg_Sync_Engines_Settings::DELIVERY_WEBSOCKET ),
			array( 'sse', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_SSE ),
		);
		foreach ( $cases as list( $transport, $advisory, $expected ) ) {
			update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, $transport );
			update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, $advisory );
			$this->assertSame( $expected, Gutenberg_Sync_Engines_Settings::delivery(), "$transport + $advisory" );
		}

		// Nothing stored: the default pair.
		delete_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION );
		delete_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC, Gutenberg_Sync_Engines_Settings::delivery() );
	}

	public function test_saving_the_transport_list_writes_the_pair_and_stores_nothing_itself() {
		$settings = new Gutenberg_Sync_Engines_Settings();

		$this->assertSame( 'polling-websocket', $settings->sanitize_delivery( 'polling-websocket' ) );
		$this->assertSame( 'http-polling', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'websocket-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// SSE and WebSocket keep WebRTC as the fallback channel.
		$settings->sanitize_delivery( 'websocket' );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'webrtc-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		$settings->sanitize_delivery( Gutenberg_Sync_Engines_Settings::DELIVERY_SSE );
		$this->assertSame( 'sse', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'webrtc-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		$settings->sanitize_delivery( 'polling' );
		$this->assertSame( 'http-polling', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( '', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// An unknown value falls back to the default pair.
		$this->assertSame( 'polling-webrtc', $settings->sanitize_delivery( 'carrier-pigeon' ) );
		$this->assertSame( 'webrtc-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// The field's own name is never stored: the plugin short-circuits
		// its update (the sanitize callback has already written the pair).
		$this->assertNotFalse( has_filter( 'pre_update_option_' . Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD ) );
		update_option( Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD, 'websocket' );
		$this->assertFalse( get_option( Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD ) );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );

		// The two options stay scriptable on their own (WP-CLI, the e2e
		// specs): writing one never touches the other.
		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, 'websocket-advisory' );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
	}

	public function test_a_stored_long_polling_choice_becomes_sse() {
		$settings = new Gutenberg_Sync_Engines_Settings();
		update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, 'http-long-polling' );
		$this->assertSame( 'sse', Gutenberg_Sync_Engines_Settings::stored_transport() );
		$this->assertSame( 'sse', wp_get_collaboration_transport_registry()->get_active_slug() );
		$this->assertSame( 'sse', $settings->sanitize_transport( 'http-long-polling' ) );
	}

	public function test_the_advisory_server_url_falls_back_to_the_transport_server() {
		$this->assertSame( WP_WebSocket_Sync_Transport::get_socket_url(), Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );

		update_option( Gutenberg_Sync_Engines_Settings::WEBSOCKET_URL_OPTION, 'wss://daemon.example.com' );
		$this->assertSame( 'wss://daemon.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );

		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION, 'wss://relay.example.com' );
		$this->assertSame( 'wss://relay.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );
		$this->assertSame( 'wss://daemon.example.com', WP_WebSocket_Sync_Transport::get_socket_url(), 'The transport keeps its own server' );

		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION, 'https://not-a-socket.example.com' );
		$this->assertSame( 'wss://daemon.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url(), 'A bad scheme means the default' );
	}

	public function test_the_polling_interval_defaults_to_five_seconds() {
		$this->assertSame( 5, Gutenberg_Sync_Engines_Settings::polling_interval() );

		// 0, the first release's "built-in cadence", now means the default.
		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 0 );
		$this->assertSame( 5, Gutenberg_Sync_Engines_Settings::polling_interval() );

		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 3 );
		$this->assertSame( 3, Gutenberg_Sync_Engines_Settings::polling_interval() );

		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 99 );
		$this->assertSame( 25, Gutenberg_Sync_Engines_Settings::polling_interval(), 'Capped below the awareness timeout' );
	}

	public function test_the_awareness_settings_are_off_by_default_and_clamped() {
		$settings = new Gutenberg_Sync_Engines_Settings();

		$this->assertSame( 0, Gutenberg_Sync_Engines_Settings::awareness_interval() );
		$this->assertSame( 'sync', Gutenberg_Sync_Engines_Settings::awareness_channel() );

		$this->assertSame( 0, $settings->sanitize_awareness_interval( -3 ) );
		$this->assertSame( 5, $settings->sanitize_awareness_interval( '5' ) );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_MAX, $settings->sanitize_awareness_interval( 9999 ) );

		$this->assertSame( 'heartbeat', $settings->sanitize_awareness_channel( 'heartbeat' ) );
		$this->assertSame( 'sync', $settings->sanitize_awareness_channel( 'sync' ) );
		$this->assertSame( 'sync', $settings->sanitize_awareness_channel( 'carrier-pigeon' ) );

		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, 15 );
		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION, 'heartbeat' );
		$this->assertSame( 15, Gutenberg_Sync_Engines_Settings::awareness_interval() );
		$this->assertSame( 'heartbeat', Gutenberg_Sync_Engines_Settings::awareness_channel() );

		// A stored value past the cap reads as the cap.
		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, 9999 );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_MAX, Gutenberg_Sync_Engines_Settings::awareness_interval() );
	}

	public function test_the_awareness_settings_are_exposed_to_the_rest_api() {
		( new Gutenberg_Sync_Engines_Settings() )->register_options();
		$registered = get_registered_settings();
		foreach ( array( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION ) as $option ) {
			$this->assertArrayHasKey( $option, $registered );
			$this->assertTrue( $registered[ $option ]['show_in_rest'] );
		}
	}
}
