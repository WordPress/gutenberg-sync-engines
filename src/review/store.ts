/**
 * The conflict-review data store: the open review items (edits an engine
 * set aside instead of merging) per loaded entity. Fed by the record
 * handlers' `onProposalsChange` (see `./handlers.ts`), read by the
 * document-settings panel and the in-canvas cards (see `./ui/`).
 *
 * Gutenberg used to keep this list in core-data (`syncReviewItems`); it
 * now lives here, keyed the way the sync manager addresses entities:
 * `objectType` (`kind/name`) and `objectId`.
 */

/**
 * WordPress dependencies
 */
import { createReduxStore, register } from '@wordpress/data';

/**
 * Internal dependencies
 */
import type { SyncReviewItem } from '../sync';

export const STORE_NAME = 'gutenberg-sync-engines/review';

interface State {
	items: Record< string, SyncReviewItem[] >;
}

type Action =
	| {
			type: 'SET_REVIEW_ITEMS';
			key: string;
			items: SyncReviewItem[];
	  }
	| { type: 'RESET' };

const DEFAULT_STATE: State = { items: {} };

const EMPTY_ITEMS: SyncReviewItem[] = [];

/**
 * The store key of an entity.
 *
 * @param objectType The entity's `kind/name`.
 * @param objectId   The record id, or null for a collection.
 * @return The key.
 */
export function reviewKey(
	objectType: string,
	objectId: string | number | null
): string {
	return `${ objectType }:${ objectId ?? '' }`;
}

function reducer( state: State = DEFAULT_STATE, action: Action ): State {
	switch ( action.type ) {
		case 'SET_REVIEW_ITEMS': {
			if ( ! action.items.length ) {
				if ( ! ( action.key in state.items ) ) {
					return state;
				}
				const items = { ...state.items };
				delete items[ action.key ];
				return { ...state, items };
			}
			return {
				...state,
				items: { ...state.items, [ action.key ]: action.items },
			};
		}
		case 'RESET':
			return DEFAULT_STATE;
	}
	return state;
}

const actions = {
	/**
	 * Replaces an entity's open review list.
	 *
	 * @param objectType The entity's `kind/name`.
	 * @param objectId   The record id.
	 * @param items      The open review items.
	 * @return The action.
	 */
	setReviewItems(
		objectType: string,
		objectId: string | number | null,
		items: SyncReviewItem[]
	): Action {
		return {
			type: 'SET_REVIEW_ITEMS',
			key: reviewKey( objectType, objectId ),
			items,
		};
	},
	/** Forgets every entity's list. */
	reset(): Action {
		return { type: 'RESET' };
	},
};

const selectors = {
	/**
	 * An entity's open review items (a stable empty array when none).
	 *
	 * @param state      Store state.
	 * @param objectType The entity's `kind/name`.
	 * @param objectId   The record id.
	 * @return The open review items.
	 */
	getReviewItems(
		state: State,
		objectType: string,
		objectId: string | number | null
	): SyncReviewItem[] {
		return state.items[ reviewKey( objectType, objectId ) ] ?? EMPTY_ITEMS;
	},
};

export const store = createReduxStore( STORE_NAME, {
	reducer,
	actions,
	selectors,
} );

let registered = false;

/** Registers the store once; safe to call again. */
export function registerReviewStore(): void {
	if ( registered ) {
		return;
	}
	registered = true;
	register( store );
}
