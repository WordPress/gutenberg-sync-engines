<?php
/**
 * Redis wire protocol tests, independent of a Redis installation.
 *
 * @package GutenbergSyncEngines
 * @group collaboration
 */
class Tests_Collaboration_WpSyncRedis extends WP_UnitTestCase {
	private $peer;

	private function client(): WP_Sync_Redis {
		$pair       = stream_socket_pair( STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP );
		$this->peer = $pair[1];
		$reflection = new ReflectionClass( WP_Sync_Redis::class );
		$client     = $reflection->newInstanceWithoutConstructor();
		$socket     = $reflection->getProperty( 'socket' );
		$socket->setAccessible( true );
		$socket->setValue( $client, $pair[0] );
		stream_set_timeout( $pair[0], 1 );
		return $client;
	}

	public function tear_down() {
		if ( is_resource( $this->peer ) ) {
			fclose( $this->peer ); }
		parent::tear_down();
	}

	public function test_subscribe_waits_for_ack_and_receives_a_notice() {
		$client = $this->client();
		fwrite( $this->peer, "*3\r\n$9\r\nsubscribe\r\n$4\r\nroom\r\n:1\r\n" );
		$client->subscribe( array( 'room' ) );
		$this->assertSame( "*2\r\n$9\r\nSUBSCRIBE\r\n$4\r\nroom\r\n", fread( $this->peer, 1024 ) );
		fwrite( $this->peer, "*3\r\n$7\r\nmessage\r\n$4\r\nroom\r\n$7\r\nchanged\r\n" );
		$this->assertTrue( $client->wait( 0.01 ) );
		$this->assertFalse( $client->wait( 0.01 ) );
		$client->close();
	}

	public function test_redis_disconnect_ends_the_wait() {
		$client = $this->client();
		fclose( $this->peer );
		$this->expectException( RuntimeException::class );
		$client->wait( 0.01 );
	}

	public function test_redis_error_does_not_leak_credentials() {
		$client = $this->client();
		fwrite( $this->peer, "-ERR private server detail\r\n" );
		$this->expectExceptionMessage( 'Redis rejected the command.' );
		$client->read();
	}

	public function test_rejects_unbounded_replies() {
		$client = $this->client();
		fwrite( $this->peer, "$999999999\r\n" );
		$this->expectException( RuntimeException::class );
		$client->read();
	}
	public function test_reads_notices_already_buffered_with_the_subscription_ack() {
		$client = $this->client();
		fwrite( $this->peer, "*3\r\n$9\r\nsubscribe\r\n$4\r\nroom\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$4\r\nroom\r\n$7\r\nchanged\r\n" );
		$client->subscribe( array( 'room' ) );
		$this->assertTrue( $client->wait( 0.01 ) );
	}
	/**
	 * @dataProvider object_cache_settings
	 */
	public function test_derives_the_redis_address_from_a_redis_object_cache( array $settings, string $expected ) {
		$this->assertSame( $expected, WP_Sync_Redis_Notifications::object_cache_url( $settings ) );
	}

	public function object_cache_settings(): array {
		$base = array(
			'persistent' => true,
			'cluster'    => false,
			'scheme'     => 'tcp',
			'host'       => '10.0.0.5',
			'port'       => 6380,
			'path'       => null,
			'password'   => null,
		);
		return array(
			'host and port'                     => array( $base, 'redis://10.0.0.5:6380' ),
			'default port'                      => array( array_merge( $base, array( 'port' => null ) ), 'redis://10.0.0.5:6379' ),
			'password'                          => array( array_merge( $base, array( 'password' => 'p@ss word' ) ), 'redis://:p%40ss%20word@10.0.0.5:6380' ),
			'ACL user and password'             => array( array_merge( $base, array( 'password' => array( 'app', 'secret' ) ) ), 'redis://app:secret@10.0.0.5:6380' ),
			'TLS'                               => array( array_merge( $base, array( 'scheme' => 'tls' ) ), 'rediss://10.0.0.5:6380' ),
			'unix socket'                       => array(
				array_merge(
					$base,
					array(
						'scheme' => 'unix',
						'path'   => '/var/run/redis.sock',
					)
				),
				'unix:///var/run/redis.sock',
			),
			'no persistent cache'               => array( array_merge( $base, array( 'persistent' => false ) ), '' ),
			'no host configured'                => array( array_merge( $base, array( 'host' => null ) ), '' ),
			'a cluster the client cannot speak' => array( array_merge( $base, array( 'cluster' => true ) ), '' ),
		);
	}

	public function test_the_configured_address_wins_and_the_filter_can_turn_redis_off() {
		$expected = defined( 'WP_SYNC_SSE_REDIS_URL' ) ? WP_SYNC_SSE_REDIS_URL : WP_Sync_Redis_Notifications::object_cache_url();
		$this->assertSame( $expected, WP_Sync_Redis_Notifications::url() );
		$derived = static fn() => 'redis://cache.example:6379';
		add_filter( 'wp_sync_sse_redis_url', $derived );
		$this->assertSame( 'redis://cache.example:6379', WP_Sync_Redis_Notifications::url() );
		remove_filter( 'wp_sync_sse_redis_url', $derived );
		add_filter( 'wp_sync_sse_redis_url', '__return_empty_string' );
		$this->assertSame( '', WP_Sync_Redis_Notifications::url() );
	}

	public function test_connects_over_a_unix_socket() {
		$path   = sys_get_temp_dir() . '/wp-sync-redis-' . wp_generate_password( 8, false ) . '.sock';
		$server = stream_socket_server( 'unix://' . $path );
		try {
			$client = new WP_Sync_Redis( 'unix://' . $path );
			$peer   = stream_socket_accept( $server, 1 );
			$this->assertIsResource( $peer );
			$client->command( array( 'PING' ) );
			$this->assertSame( "*1\r\n$4\r\nPING\r\n", fread( $peer, 64 ) );
			$client->close();
			fclose( $peer );
		} finally {
			fclose( $server );
			@unlink( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
	}

	public function test_channel_namespace_is_stable_and_separates_rooms() {
		$room    = 'postType/post:1';
		$channel = WP_Sync_Redis_Notifications::channel( $room );
		$this->assertSame( $channel, WP_Sync_Redis_Notifications::channel( $room ) );
		$this->assertNotSame( $channel, WP_Sync_Redis_Notifications::channel( 'postType/post:2' ) );
	}

	public function test_channel_namespace_ignores_the_hostname_a_site_is_reached_through() {
		$room       = 'postType/post:1';
		$channel    = WP_Sync_Redis_Notifications::channel( $room );
		$other_host = static fn() => 'https://alias.example';
		add_filter( 'home_url', $other_host );
		try {
			$this->assertSame( $channel, WP_Sync_Redis_Notifications::channel( $room ), 'One site behind several hostnames must share a channel.' );
		} finally {
			remove_filter( 'home_url', $other_host );
		}
	}

	public function test_channel_namespace_separates_table_prefixes_and_blog_ids() {
		global $wpdb, $blog_id;
		$prefix        = $wpdb->prefix;
		$original_blog = $blog_id;
		$channel       = WP_Sync_Redis_Notifications::channel( 'postType/post:1' );
		try {
			$wpdb->prefix = 'another_installation_';
			$this->assertNotSame( $channel, WP_Sync_Redis_Notifications::channel( 'postType/post:1' ) );
			$wpdb->prefix = $prefix;
			$blog_id      = (int) $original_blog + 1;
			$this->assertNotSame( $channel, WP_Sync_Redis_Notifications::channel( 'postType/post:1' ) );
		} finally {
			$wpdb->prefix = $prefix;
			$blog_id      = $original_blog;
		}
		$this->assertSame( $channel, WP_Sync_Redis_Notifications::channel( 'postType/post:1' ) );
	}
}
