<?php
/**
 * Tests for the plugin activation hook: activating the plugin turns the
 * Gutenberg real-time collaboration experiment on.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesActivation extends WP_UnitTestCase {
	const OPTION     = 'gutenberg-experiments';
	const EXPERIMENT = 'gutenberg-real-time-collaboration';

	/**
	 * The plugin entry registers the activation callback on its own file.
	 */
	public function test_activation_hook_is_registered() {
		$this->assertSame(
			10,
			has_action( 'activate_' . plugin_basename( GUTENBERG_SYNC_ENGINES_FILE ), 'gutenberg_sync_engines_activate' )
		);
	}

	/**
	 * A fresh site (no experiments stored) ends up with collaboration on.
	 */
	public function test_activation_turns_the_collaboration_experiment_on() {
		delete_option( self::OPTION );
		$this->assertFalse( gutenberg_is_experiment_enabled( self::EXPERIMENT ) );

		gutenberg_sync_engines_activate( false );

		$this->assertTrue( gutenberg_is_experiment_enabled( self::EXPERIMENT ) );
		$this->assertTrue( wp_is_collaboration_enabled() );
	}

	/**
	 * Other experiments keep their state; an explicitly disabled
	 * collaboration experiment is turned on.
	 */
	public function test_activation_preserves_other_experiments() {
		update_option(
			self::OPTION,
			array(
				'gutenberg-something-else' => true,
				self::EXPERIMENT           => false,
			)
		);

		gutenberg_sync_engines_activate( false );

		$this->assertSame(
			array(
				'gutenberg-something-else' => true,
				self::EXPERIMENT           => true,
			),
			get_option( self::OPTION )
		);
	}

	/**
	 * A corrupt (non-array) stored value is replaced rather than fataling.
	 */
	public function test_activation_recovers_from_a_non_array_option() {
		update_option( self::OPTION, 'not-an-array' );

		gutenberg_sync_engines_activate( false );

		$this->assertSame( array( self::EXPERIMENT => true ), get_option( self::OPTION ) );
	}

	/**
	 * When the experiment is already on, activation writes nothing.
	 */
	public function test_activation_is_a_no_op_when_already_on() {
		update_option( self::OPTION, array( self::EXPERIMENT => true ) );
		$writes = 0;
		$count  = function ( $value ) use ( &$writes ) {
			++$writes;
			return $value;
		};
		add_filter( 'pre_update_option_' . self::OPTION, $count );

		gutenberg_sync_engines_activate( false );

		remove_filter( 'pre_update_option_' . self::OPTION, $count );
		$this->assertSame( 0, $writes );
		$this->assertTrue( gutenberg_is_experiment_enabled( self::EXPERIMENT ) );
	}
}
