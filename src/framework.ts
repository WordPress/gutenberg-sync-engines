/**
 * The runtime surface this plugin consumes from the collaborative-editing
 * framework (`@wordpress/sync`). Types are imported directly from
 * `@wordpress/sync` (public); runtime VALUES that live behind the framework's
 * private API are unlocked ONCE here and re-exported, so the engine adapters
 * and transport providers don't each repeat the unlock.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import { privateApis } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { unlock } from './lock-unlock';

const api = unlock( privateApis );

export const registerSyncEngine = api.registerSyncEngine;
export const registerSyncTransport = api.registerSyncTransport;
export const getProviderCreators = api.getProviderCreators;
export const createSyncManager = api.createSyncManager;
export const ConnectionError = api.ConnectionError;
export const ConnectionErrorCode = api.ConnectionErrorCode;
export const resolveEngineAdapter = api.resolveEngineAdapter;

// Origin marker for editor-originated updates (used by the yjs undo manager
// and its tests).
export const LOCAL_EDITOR_ORIGIN = api.LOCAL_EDITOR_ORIGIN;

// Origin marker for editor updates that must sync but never become undo
// steps (core-data's `undoIgnore` edits and save responses).
export const LOCAL_UNDO_IGNORED_ORIGIN = api.LOCAL_UNDO_IGNORED_ORIGIN;

// Test-support: reset the shared framework registries between unit tests.
export const getEngineAdapters = api.getEngineAdapters;
export const resetEngineAdaptersForTesting = api.resetEngineAdaptersForTesting;
export const resetProviderCreatorsForTesting =
	api.resetProviderCreatorsForTesting;
