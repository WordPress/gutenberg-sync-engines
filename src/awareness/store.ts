/**
 * The slow-awareness data store: each peer's latest block. Blocks look
 * their own peers up by identity, so a block the local editor has not
 * received yet simply matches nothing and shows nothing.
 *
 * Several peers can share a block. The store remembers the order they
 * entered it (`Peer.entered`), so the block can keep the color of whoever
 * arrived first for as long as they stay, and stack the others behind
 * them in arrival order.
 */

/**
 * WordPress dependencies
 */
import { createReduxStore, createSelector, register } from '@wordpress/data';

/**
 * Internal dependencies
 */
import { getPeerColor } from './colors';
import type { Peer, PeerReport } from './types';

export const STORE_NAME = 'gutenberg-sync-engines/awareness';

interface State {
	peers: Record< string, Peer >;
	/** The `entered` value the next block change receives. */
	nextEntered: number;
}

/** A peer with its color decided, before the store assigns entry order. */
type ColoredPeer = Omit< Peer, 'entered' >;

type Action = { type: 'SET_PEERS'; peers: ColoredPeer[] } | { type: 'RESET' };

const DEFAULT_STATE: State = { peers: {}, nextEntered: 1 };

const NO_PEERS: Peer[] = [];

function samePeer( a: ColoredPeer, b: ColoredPeer ): boolean {
	return (
		a.key === b.key &&
		a.block === b.block &&
		a.color === b.color &&
		a.identity.userId === b.identity.userId &&
		a.identity.name === b.identity.name &&
		a.identity.avatarUrl === b.identity.avatarUrl
	);
}

function reducer( state: State = DEFAULT_STATE, action: Action ): State {
	switch ( action.type ) {
		case 'SET_PEERS': {
			// The roster replaces the peers wholesale: anyone missing has
			// left. A peer still in the same block (a repeat, a name or
			// avatar change) keeps their place; a different block is a
			// new entry.
			const peers: Record< string, Peer > = {};
			let nextEntered = state.nextEntered;
			let changed =
				action.peers.length !== Object.keys( state.peers ).length;
			for ( const report of action.peers ) {
				const existing = state.peers[ report.key ];
				if ( existing && samePeer( existing, report ) ) {
					peers[ report.key ] = existing;
					continue;
				}
				changed = true;
				const staysInBlock =
					existing && existing.block === report.block;
				peers[ report.key ] = {
					...report,
					entered: staysInBlock ? existing.entered : nextEntered++,
				};
			}
			return changed ? { peers, nextEntered } : state;
		}
		case 'RESET':
			return DEFAULT_STATE;
	}
	return state;
}

const actions = {
	/**
	 * The full roster of peers, as a channel reports it.
	 *
	 * @param reports The peers.
	 */
	setPeers( reports: PeerReport[] ): Action {
		return {
			type: 'SET_PEERS',
			peers: reports.map( ( report ) => ( {
				...report,
				color: getPeerColor(
					report.identity.userId,
					Number( report.key )
				),
			} ) ),
		};
	},
	reset(): Action {
		return { type: 'RESET' };
	},
};

const selectors = {
	getPeers: createSelector(
		( state: State ): Peer[] => Object.values( state.peers ),
		( state: State ) => [ state.peers ]
	),
	/**
	 * The peers in one block, in the order they entered it: every peer
	 * whose block matches the block's durable identity or its clientId.
	 * The first one is the block's primary peer (the outline color); the
	 * rest stack behind them. Returns one shared empty array when nobody
	 * is there, so unaffected blocks see no change.
	 *
	 * @param state    Store state.
	 * @param syncId   The block's syncId, if stamped.
	 * @param clientId The block's clientId.
	 * @return The peers, oldest entry first.
	 */
	getPeersForBlock: createSelector(
		(
			state: State,
			syncId: string | undefined,
			clientId: string
		): Peer[] => {
			const peers: Peer[] = [];
			for ( const key in state.peers ) {
				const peer = state.peers[ key ];
				if (
					null !== peer.block &&
					( peer.block === syncId || peer.block === clientId )
				) {
					peers.push( peer );
				}
			}
			if ( ! peers.length ) {
				return NO_PEERS;
			}
			return peers.sort( ( a, b ) => a.entered - b.entered );
		},
		( state: State ) => [ state.peers ]
	),
};

export const store = createReduxStore( STORE_NAME, {
	reducer,
	actions,
	selectors,
} );

let registered = false;

/**
 * Registers the store once.
 */
export function registerAwarenessStore(): void {
	if ( registered ) {
		return;
	}
	registered = true;
	register( store );
}
