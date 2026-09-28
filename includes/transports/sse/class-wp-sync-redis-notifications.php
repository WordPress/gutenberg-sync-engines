<?php
/**
 * Redis carries wake notices; room tables remain the durable source of truth.
 *
 * @package GutenbergSyncEngines
 * @since 0.0.2
 */

/**
 * Publishes changes after the writer finishes.
 *
 * @since 0.0.2
 */
class WP_Sync_Redis_Notifications {
	/**
	 * Rooms changed in this request.
	 *
	 * @var array<string, bool> Rooms changed in this request.
	 */
	private static $pending = array();

	/**
	 * Server-only Redis URL, or empty when there is none: the configured
	 * address, else the one a Redis object cache drop-in is configured
	 * with, then the filter (which may blank it to turn Redis off).
	 *
	 * @return string Server-only Redis URL, or empty when there is none.
	 */
	public static function url(): string {
		$configured = defined( 'WP_SYNC_SSE_REDIS_URL' ) ? (string) WP_SYNC_SSE_REDIS_URL : '';
		/**
		 * Filters the Redis address the SSE transport publishes and subscribes on.
		 *
		 * @since 0.0.2
		 * @param string $url `redis://`, `rediss://`, or `unix://` address; '' for none.
		 */
		return (string) apply_filters( 'wp_sync_sse_redis_url', '' !== $configured ? $configured : self::object_cache_url() );
	}

	/**
	 * The address of the Redis a persistent object cache drop-in uses, read
	 * from the constants the Redis Object Cache plugin documents
	 * (WP_REDIS_HOST, WP_REDIS_PORT, WP_REDIS_PASSWORD, WP_REDIS_SCHEME,
	 * WP_REDIS_PATH). Empty when there is no persistent cache, when no host
	 * is configured, or when the cache is a cluster, replica set, or
	 * sentinel group the plugin's small client does not speak.
	 *
	 * @param array|null $settings The drop-in settings (tests); null reads the constants.
	 * @return string Redis URL, or '' when none applies.
	 */
	public static function object_cache_url( ?array $settings = null ): string {
		$settings = $settings ?? self::object_cache_settings();
		if ( empty( $settings['persistent'] ) || ! empty( $settings['cluster'] ) ) {
			return '';
		}
		$scheme = (string) ( $settings['scheme'] ?? 'tcp' );
		if ( 'unix' === $scheme ) {
			$path = (string) ( $settings['path'] ?? $settings['host'] ?? '' );
			return '' === $path ? '' : 'unix://' . $path;
		}
		$host = (string) ( $settings['host'] ?? '' );
		if ( '' === $host ) {
			return '';
		}
		$password = $settings['password'] ?? '';
		$userinfo = '';
		if ( is_array( $password ) && 2 === count( $password ) ) {
			$userinfo = rawurlencode( (string) $password[0] ) . ':' . rawurlencode( (string) $password[1] ) . '@';
		} elseif ( is_string( $password ) && '' !== $password ) {
			$userinfo = ':' . rawurlencode( $password ) . '@';
		}
		return ( 'tls' === $scheme ? 'rediss' : 'redis' ) . '://' . $userinfo . $host . ':' . (int) ( $settings['port'] ?? 6379 );
	}

	/**
	 * The Redis object cache drop-in's settings as this site defines them.
	 *
	 * @return array Settings for object_cache_url().
	 */
	public static function object_cache_settings(): array {
		$constant = static function ( string $name ) {
			return defined( $name ) ? constant( $name ) : null;
		};
		return array(
			'persistent' => (bool) wp_using_ext_object_cache(),
			'cluster'    => defined( 'WP_REDIS_CLUSTER' ) || defined( 'WP_REDIS_SERVERS' ) || defined( 'WP_REDIS_SENTINEL' ),
			'scheme'     => $constant( 'WP_REDIS_SCHEME' ) ?? 'tcp',
			'host'       => $constant( 'WP_REDIS_HOST' ),
			'port'       => $constant( 'WP_REDIS_PORT' ) ?? 6379,
			'path'       => $constant( 'WP_REDIS_PATH' ),
			'password'   => $constant( 'WP_REDIS_PASSWORD' ),
		);
	}

	/** Register storage notices and publish after request work is complete. */
	public static function register(): void {
		add_action( 'gutenberg_sync_engines_room_changed', array( self::class, 'changed' ) );
		add_action( 'shutdown', array( self::class, 'flush' ), PHP_INT_MAX );
	}

	/**
	 * Keep sites and rooms separate on a shared Redis service. The database
	 * identity (host, name, table prefix, blog id) is what makes a site
	 * distinct; the home URL is deliberately left out so a site reached
	 * through several hostnames publishes and subscribes on one channel.
	 *
	 * @param string $room Room name.
	 * @return string Channel.
	 */
	public static function channel( string $room ): string {
		global $wpdb;
		return 'wp-sync:' . hash( 'sha256', (string) wp_json_encode( array( DB_HOST, DB_NAME, $wpdb->prefix, get_current_blog_id(), $room ) ) );
	}

	/**
	 * Coalesce notices until the writer has finished updating engine metadata.
	 *
	 * @param string $room Changed room.
	 */
	public static function changed( string $room ): void {
		// Do not read options or site metadata on the storage write path.
		self::$pending[ $room ] = true;
	}

	/** Publish best-effort notices. Redis failure must never fail a saved edit. */
	public static function flush(): void {
		$rooms         = array_keys( self::$pending );
		self::$pending = array();
		if ( empty( $rooms ) || '' === self::url() || 'sse' !== wp_get_collaboration_transport_registry()->get_active_slug() ) {
			return;
		}
		try {
			$redis = new WP_Sync_Redis( self::url() );
			foreach ( $rooms as $room ) {
				$redis->command( array( 'PUBLISH', self::channel( $room ), 'changed' ) );
				$redis->read();
			}
			$redis->close();
		} catch ( RuntimeException $error ) {
			// Periodic catch-up reads recover missing notices even
			// when a writer dies or Redis loses a notice after the DB write.
			do_action( 'gutenberg_sync_engines_sse_publish_failed', $error );
		}
	}
}
