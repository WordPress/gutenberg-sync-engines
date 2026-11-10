/**
 * The fixture entry of the collaboration suite Gutenberg used to carry.
 * The specs import `test`, `expect` and the `collaborationUtils` fixture
 * from here, as they did in Gutenberg; they get this plugin's hardened
 * wiring (tests/e2e/config/collaboration-fixtures.ts): the joining user
 * logs in through a bounded request instead of the login form, and the
 * discovery and sync-cycle waits know this plugin's transports, whose
 * tabs poll on demand once they have found each other.
 */

/**
 * Internal dependencies
 */
export { test, expect } from '../../../config/collaboration-fixtures';
