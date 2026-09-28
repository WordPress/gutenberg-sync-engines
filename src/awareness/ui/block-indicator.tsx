/**
 * The per-block outline: applied through the public `editor.BlockListBlock`
 * filter by adding a class, the primary peer's color, and every peer's key
 * to the block wrapper. Each block looks up its own peers by its durable
 * identity and its clientId, so no global index exists: a peer naming a
 * block this editor does not hold matches no block and shows nothing until
 * the block renders. When a peer moves on, the old block's lookup drops
 * them on the same store change, so the outline goes (or changes color to
 * the next peer's) at once.
 *
 * The primary peer is whoever entered the block first and is still there,
 * so the outline color does not flicker when others come and go.
 *
 * The outline's styles reach the canvas document through the badge layer
 * (`PresenceBadges` injects them whenever any peer exists), so this
 * component only marks the wrapper.
 */

/**
 * WordPress dependencies
 */
import { createHigherOrderComponent } from '@wordpress/compose';
import { useSelect } from '@wordpress/data';
import { addFilter } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import { getSyncId } from '../block-id';
import { store } from '../store';

interface BlockListBlockProps {
	clientId: string;
	attributes?: Record< string, unknown >;
	wrapperProps?: Record< string, unknown > & {
		className?: string;
		style?: Record< string, unknown >;
	};
	[ key: string ]: unknown;
}

type BlockListBlockComponent = ( props: BlockListBlockProps ) => JSX.Element;

/** The class on a block wrapper a peer is in. */
export const PRESENCE_CLASS = 'gse-presence';

/**
 * The wrapper attribute listing the peers in the block, primary first,
 * as comma-joined keys. Read by the badge overlay.
 */
export const PEERS_ATTRIBUTE = 'data-gse-peers';

/** The separator between keys in `PEERS_ATTRIBUTE`. */
export const PEERS_SEPARATOR = ',';

const withPeerPresence = createHigherOrderComponent(
	( BlockListBlock: BlockListBlockComponent ) =>
		function PeerPresenceBlock( props: BlockListBlockProps ) {
			const { clientId } = props;
			const syncId = getSyncId( props.attributes );
			const peers = useSelect(
				( select ) =>
					select( store ).getPeersForBlock( syncId, clientId ),
				[ syncId, clientId ]
			);
			const primary = peers[ 0 ];
			if ( ! primary ) {
				return <BlockListBlock { ...props } />;
			}

			const className = [ props.wrapperProps?.className, PRESENCE_CLASS ]
				.filter( Boolean )
				.join( ' ' );
			const wrapperProps = {
				...props.wrapperProps,
				className,
				style: {
					...props.wrapperProps?.style,
					'--gse-outline-color': primary.color,
				},
				[ PEERS_ATTRIBUTE ]: peers
					.map( ( peer ) => peer.key )
					.join( PEERS_SEPARATOR ),
			};
			return (
				<BlockListBlock { ...props } wrapperProps={ wrapperProps } />
			);
		},
	'withPeerPresence'
);

let registered = false;

/**
 * Registers the block wrapper filter once.
 */
export function registerBlockIndicator(): void {
	if ( registered ) {
		return;
	}
	registered = true;
	addFilter(
		'editor.BlockListBlock',
		'gutenberg-sync-engines/peer-presence',
		withPeerPresence
	);
}
