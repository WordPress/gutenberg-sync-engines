/**
 * Yjs CRDT document constants.
 *
 * These define the on-the-wire/on-disk shape of a Yjs sync document and MUST
 * stay byte-identical across every peer speaking a Yjs engine — originally
 * the yjs-relay engine (retired), now yjs-server, whose room documents carry
 * the same schema (they used to live in `@wordpress/sync`'s `config.ts`; this
 * module owns them now).
 */

/** Version of the CRDT document schema. */
export const CRDT_DOC_VERSION = 1;

/** Doc-meta flag marking a document hydrated from persistence. */
export const CRDT_DOC_META_PERSISTENCE_KEY = 'fromPersistence';

/** Y.Map holding the synced entity record. */
export const CRDT_RECORD_MAP_KEY = 'document';

/** Y.Map holding document state (version, save markers). */
export const CRDT_STATE_MAP_KEY = 'state';

/** State-map key: timestamp of the last user-facing save. */
export const CRDT_STATE_MAP_SAVED_AT_KEY = 'savedAt';

/** State-map key: client id that performed the last save. */
export const CRDT_STATE_MAP_SAVED_BY_KEY = 'savedBy';

/** State-map key: the CRDT document schema version. */
export const CRDT_STATE_MAP_VERSION_KEY = 'version';
