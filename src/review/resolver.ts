/**
 * Where a review decision goes. The plugin's entity sync manager owns the
 * two resolution verbs (`resolveProposal` / `restoreProposal`, see
 * `src/entity-sync/manager.ts`); the notices and the review UI reach it
 * through this module rather than through core-data, which no longer
 * carries them.
 */

export type ReviewResolution = 'restored' | 'dismissed';

export interface ReviewResolver {
	/** Closes a parked proposal without re-authoring its content. */
	resolveProposal: (
		objectType: string,
		objectId: string | null,
		proposalId: string,
		resolution: ReviewResolution
	) => void;
	/**
	 * Re-authors the parked content as ordinary edits under the restorer's
	 * capability, then closes the proposal as restored.
	 */
	restoreProposal: (
		objectType: string,
		objectId: string | null,
		proposalId: string
	) => void;
}

let resolver: ReviewResolver | undefined;

/**
 * Installs the resolver the UI and the notices call. The sync manager
 * installs its own when the entity provider is created.
 *
 * @param next The resolver.
 * @return Removes it again (only if it is still the installed one).
 */
export function registerReviewResolver( next: ReviewResolver ): () => void {
	resolver = next;
	return () => {
		if ( resolver === next ) {
			resolver = undefined;
		}
	};
}

/**
 * Resolves a group of parked proposals: 'restored' re-authors each one's
 * lost content as an ordinary edit, 'dismissed' discards it. Either way
 * the proposals close for every collaborator. A no-op while no provider is
 * registered.
 *
 * @param objectType  The entity's `kind/name`.
 * @param objectId    The record id.
 * @param proposalIds The proposals to resolve (the review items' ids).
 * @param resolution  The decision.
 */
export function resolveReviewProposals(
	objectType: string,
	objectId: string | null,
	proposalIds: string[],
	resolution: ReviewResolution
): void {
	if ( ! resolver ) {
		return;
	}
	for ( const proposalId of proposalIds ) {
		if ( 'restored' === resolution ) {
			resolver.restoreProposal( objectType, objectId, proposalId );
		} else {
			resolver.resolveProposal(
				objectType,
				objectId,
				proposalId,
				'dismissed'
			);
		}
	}
}
