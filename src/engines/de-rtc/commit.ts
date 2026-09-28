/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { EngineDisposition, EngineUpdate } from '@wordpress/sync';

/*
 * The Save/Sync inversion's commit carrier, client half: de-rtc sessions
 * commit through the ordinary autosave endpoint instead of transport
 * rows. The session's proposal payload is re-keyed onto the request; the
 * response returns the dispositions plus every room row the commit
 * appended, which the session feeds through its normal row machinery
 * (rows first, dispositions after — the provider's ordering contract).
 */

/** The commit response the session settles from. */
export interface DeRtcCommitResponse {
	dispositions?: EngineDisposition[];
	updates?: EngineUpdate[];
}

/** Commits one proposal; rejects on transport/HTTP failure. */
export type DeRtcCommitAdapter = (
	update: EngineUpdate
) => Promise< DeRtcCommitResponse >;

/** postType -> REST base for the routes the commit lane covers. */
const REST_BASES: Record< string, string > = {
	post: 'posts',
	page: 'pages',
};

/**
 * Builds the commit adapter for one entity, or null when the entity's
 * type has no commit route (collections, unsupported post types — those
 * sessions keep the transport proposal lane).
 *
 * @param objectType Sync object type (e.g. `postType/post`).
 * @param objectId   Object id.
 * @param clientId   The session's client id (the local Y.Doc's).
 * @return The adapter or null.
 */
export function createDeRtcCommitAdapter(
	objectType: string,
	objectId: unknown,
	clientId: number
): DeRtcCommitAdapter | null {
	const match = /^postType\/(.+)$/.exec( objectType );
	const restBase = match ? REST_BASES[ match[ 1 ] ] : undefined;
	if ( ! restBase ) {
		return null;
	}
	const path = `/wp/v2/${ restBase }/${ String( objectId ) }/autosaves`;

	return async ( update: EngineUpdate ): Promise< DeRtcCommitResponse > => {
		const proposal = JSON.parse( update.data ) as Record< string, unknown >;
		const response = ( await apiFetch( {
			path,
			method: 'POST',
			data: {
				proposal_id: proposal.proposalId,
				base_version: proposal.baseVersion,
				proposed_content: proposal.proposedContent,
				proposed_properties: proposal.proposedProperties ?? {},
				client_update: proposal.clientUpdate ?? null,
				block_base_versions: proposal.blockBaseVersions ?? null,
				client_id: clientId,
			},
		} ) ) as DeRtcCommitResponse;
		return response ?? {};
	};
}
