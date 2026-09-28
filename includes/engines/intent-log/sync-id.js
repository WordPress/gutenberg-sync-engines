/**
 * Stable block identity (syncId) — client minting, two regimes.
 *
 * Fills `metadata.syncId` for any block that lacks one and re-mints when two
 * blocks carry the same ID (block duplication copies `metadata` wholesale, so
 * a duplicate would otherwise share its source's identity). The `metadata`
 * attribute serializes into the block comment delimiter, so IDs persist with
 * content, survive kses, and are visible to the server-side engine.
 *
 * Two-regime minting per the sync spec:
 *
 * - GENESIS (deterministic): blocks of a freshly loaded, unedited post get
 *   ids computed from (postId, 0, block path) — the exact function the
 *   server's room genesis uses (WP_Intent_Log_Planner::genesis_sync_id;
 *   frozen cross-language vectors in the sync package's
 *   test-vectors/sync-id.json). Every independent minter — each open tab,
 *   the server, a tab that never connects — derives the SAME ids from the
 *   same saved content, so identity agreement needs no adoption heuristics
 *   and survives sessions.
 * - CREATION (random): blocks born during the session (insert, paste,
 *   split, duplicate re-mints) get random ids — each creation event is a
 *   distinct identity; this is what preserves both users' paragraphs when
 *   they concurrently insert at the same position.
 *
 * The genesis regime applies only to the first populated pass over a
 * pristine (not-yet-dirty) editor; if the user edited before the first pass,
 * every unstamped block falls back to random minting and the capture
 * bridge's identity adoption reconciles as before (the safety net stays).
 * Known limitation: classic (freeform) content occupies a path index in the
 * editor but not in the server's parse — such posts fall back to adoption.
 *
 * ENGINES SERVED: the plugin enqueues this stamper for every engine whose
 * blocks carry `metadata.syncId` — intent-log and de-rtc. Under de-rtc the
 * editor is the identity authority for blocks born in a session (the
 * server stamps only room genesis, deterministically, and the blocks of
 * engine-unaware writers), so all three lanes run: genesis, random, and
 * dedupe. The stand-down below is intent-log's alone.
 *
 * IN-SESSION STAND-DOWN: while the intent-log engine is ANNOUNCED
 * (window._wpCollaborationSync.engine), only the genesis pass runs here.
 * The capture bridge mints identity for blocks created during a live
 * session and pushes the document's id back into the editor; minting here
 * too raced that push (the stamper's block-editor write landed before the
 * push's entity-level edit propagated down), putting a THIRD identity on
 * the block that the document never knew — and a save in that window
 * persisted it (the save-vs-settle id drift). The random and dedupe lanes
 * therefore yield to the engine; they still serve tabs where no engine is
 * announced. The genesis pass is race-free by construction: it runs on the
 * pristine first pass, before any capture has authored.
 *
 * Deliberately build-free: uses WordPress script globals so the prototype
 * stays inside lib/experimental/ without touching the packages build.
 */

/* global wp */
( function () {
	const { select, dispatch, subscribe } = wp.data;

	/**
	 * Random syncId for a block born (or first observed dirty) in this
	 * session.
	 *
	 * @return {string} Opaque syncId.
	 */
	function mintSyncId() {
		return crypto.randomUUID();
	}

	/**
	 * Deterministic genesis syncId — the WebCrypto mirror of the engine's
	 * genesisSyncId()/genesis_sync_id(): sha256 of `postId:0:path`, first 16
	 * digest bytes, base64url without padding (22 chars).
	 *
	 * @param {number}   postId Post ID.
	 * @param {number[]} path   Block path (child indices from the root).
	 * @return {Promise<string>} 22-character base64url syncId.
	 */
	async function genesisSyncId( postId, path ) {
		const input = postId + ':0:' + path.join( '.' );
		const digest = new Uint8Array(
			await crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode( input )
			)
		);
		let binary = '';
		for ( let i = 0; i < 16; i++ ) {
			binary += String.fromCharCode( digest[ i ] );
		}
		return btoa( binary )
			.replace( /\+/g, '-' )
			.replace( /\//g, '_' )
			.replace( /=+$/, '' );
	}

	// How long a retry waits before re-checking a save or flush in flight.
	const RETRY_DELAY_MS = 100;

	let scheduled = false;
	let flushing = false;
	let regimeDecided = false;

	/**
	 * Collects blocks missing a `metadata.syncId` and blocks whose ID
	 * duplicates an earlier one (all but the first holder), with each
	 * block's tree path for genesis derivation.
	 *
	 * @return {Array<Object>} { clientId, metadata, path, duplicate } rows.
	 */
	function collectUpdates() {
		const blockEditor = select( 'core/block-editor' );
		if ( ! blockEditor ) {
			return [];
		}
		const seen = new Set();
		const updates = [];
		( function walk( rootClientId, path ) {
			const order = blockEditor.getBlockOrder( rootClientId );
			for ( let index = 0; index < order.length; index++ ) {
				const clientId = order[ index ];
				const blockPath = path.concat( index );
				const attributes = blockEditor.getBlockAttributes( clientId );
				if ( attributes ) {
					const syncId = attributes.metadata?.syncId;
					if ( ! syncId || seen.has( syncId ) ) {
						updates.push( {
							clientId,
							metadata: attributes.metadata,
							path: blockPath,
							// A duplicate is a creation event (the copy is a
							// new block), never a genesis candidate.
							duplicate: !! syncId,
						} );
					} else {
						seen.add( syncId );
					}
				}
				walk( clientId, blockPath );
			}
		} )( '', [] );
		return updates;
	}

	/**
	 * Assigns missing/duplicated syncIds.
	 *
	 * Runs deferred (never synchronously inside the store-change tick that
	 * scheduled it) and never while a save is in flight: dispatching a block
	 * mutation into the middle of a save's serialization races with it and can
	 * drop the very edit being saved. Deferring to a microtask also avoids
	 * re-entrant store updates from within the subscribe callback. Retries
	 * that wait on a save or an in-flight flush must go through
	 * scheduleRetry() instead; see the comment there.
	 */
	async function flushSyncIds() {
		scheduled = false;
		if ( flushing ) {
			// A previous flush is awaiting its digests; rerun after it.
			scheduleRetry();
			return;
		}

		const editor = select( 'core/editor' );
		if (
			editor &&
			( editor.isSavingPost() || editor.isAutosavingPost() )
		) {
			// Retry after the save settles.
			scheduleRetry();
			return;
		}

		/*
		 * Regime decision, made once, on the first pass that sees blocks: a
		 * pristine editor's unstamped blocks are the saved revision's blocks
		 * (genesis regime); anything unstamped after that — or after the
		 * user already edited — was created in-session (random regime).
		 */
		const blockEditor = select( 'core/block-editor' );
		const hasBlocks = ( blockEditor?.getBlockCount() ?? 0 ) > 0;
		const postId = editor?.getCurrentPostId?.();
		const useGenesis =
			! regimeDecided &&
			hasBlocks &&
			!! postId &&
			! editor?.isEditedPostDirty?.() &&
			!! crypto.subtle;
		if ( hasBlocks ) {
			regimeDecided = true;
		}

		// In-session stand-down (see the header): with the intent-log
		// engine announced, creation identity belongs to the capture
		// bridge; only the genesis pass runs here.
		if (
			! useGenesis &&
			'intent-log' === window._wpCollaborationSync?.engine
		) {
			return;
		}

		const updates = collectUpdates();
		if ( ! updates.length ) {
			return;
		}

		flushing = true;
		try {
			const assignments = await Promise.all(
				updates.map( async ( update ) => ( {
					clientId: update.clientId,
					duplicate: update.duplicate,
					// The id observed at collection time (undefined for a
					// missing-id row, the duplicated id for a duplicate row),
					// re-checked at dispatch time below.
					observedSyncId: update.metadata?.syncId,
					syncId:
						useGenesis && ! update.duplicate
							? await genesisSyncId( postId, update.path )
							: mintSyncId(),
				} ) )
			);

			// The digest hop is asynchronous: re-check the save guard and
			// re-read each block's current metadata before dispatching.
			if (
				editor &&
				( editor.isSavingPost() || editor.isAutosavingPost() )
			) {
				scheduleRetry();
				return;
			}
			const editorDispatch = dispatch( 'core/block-editor' );
			for ( const {
				clientId,
				syncId,
				duplicate,
				observedSyncId,
			} of assignments ) {
				const attributes = blockEditor?.getBlockAttributes( clientId );
				if ( ! attributes || attributes.metadata?.syncId === syncId ) {
					continue; // Removed mid-flight, or already converged.
				}
				/*
				 * FILL-ONLY: never replace an identity that arrived during
				 * the digest hop. The capture bridge mints for id-less blocks
				 * and pushes the document's id back into the editor; the
				 * document is the identity authority, and overwriting its id
				 * here put a THIRD identity on the block that the document
				 * never knew — a save in that window persisted it (the
				 * save-vs-settle id drift). A missing-id row therefore only
				 * fills a still-missing id, and a duplicate row only re-mints
				 * while the block still carries the id observed as
				 * duplicated (someone else may have resolved the duplication
				 * mid-flight).
				 */
				const currentSyncId = attributes.metadata?.syncId;
				if ( ! duplicate && currentSyncId ) {
					continue;
				}
				if ( duplicate && currentSyncId !== observedSyncId ) {
					continue;
				}
				// Identity assignment is bookkeeping, not an edit — keep it
				// out of the undo stack.
				editorDispatch.__unstableMarkNextChangeAsNotPersistent();
				editorDispatch.updateBlockAttributes( clientId, {
					metadata: { ...( attributes.metadata || {} ), syncId },
				} );
			}
		} finally {
			flushing = false;
		}
	}

	function schedule() {
		if ( scheduled ) {
			return;
		}
		scheduled = true;
		Promise.resolve().then( flushSyncIds );
	}

	/*
	 * Retries wait on state that only changes when the event loop runs
	 * tasks: a save request completing, a digest promise resolving. They
	 * must therefore be scheduled as tasks. A microtask retry re-runs
	 * before the event loop can deliver the completion it is waiting for,
	 * so the queue never drains and the page hangs in an infinite
	 * microtask loop.
	 */
	function scheduleRetry() {
		if ( scheduled ) {
			return;
		}
		scheduled = true;
		setTimeout( flushSyncIds, RETRY_DELAY_MS );
	}

	subscribe( schedule, 'core/block-editor' );
} )();
