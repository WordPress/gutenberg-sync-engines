/**
 * The avatar badges: one stack per block a peer is in, placed above the
 * block's top-left corner like the framework's own block label. Rendered
 * into the block canvas document (the editor iframe) at page coordinates
 * measured from the marked block wrappers, so they scroll with the content.
 *
 * A block with several peers gets one stack, primary peer first, overlapped
 * like the header's collaborator avatars. Hovering the stack spreads it out
 * and shows every name. A peer joining a stack that is already drawn pops
 * in, and a peer other than the first leaving one pops out (the badge
 * stays mounted for the animation, then goes); the first peer on a block
 * appears and disappears plainly.
 *
 * Badges cannot live inside the block wrapper: for text blocks that
 * wrapper is the editable element itself, and a child there would become
 * part of the content. So, like the framework, this measures the blocks
 * and draws in a layer of its own.
 */

/**
 * WordPress dependencies
 */
import { subscribe, useSelect } from '@wordpress/data';
import {
	createPortal,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import { store } from '../store';
import type { Peer } from '../types';
import { PEERS_ATTRIBUTE, PEERS_SEPARATOR } from './block-indicator';
import { ensureCanvasStyles, getCanvasDocument } from './canvas-styles';

/** How long after the last editor change to re-measure the blocks. */
const RELAYOUT_DELAY_MS = 500;

/** How long a departed badge stays mounted for its pop-out animation. */
export const LEAVE_ANIMATION_MS = 250;

/** Inline styles that may carry CSS custom properties. */
type StyleWithVars = React.CSSProperties & Record< `--${ string }`, string >;

interface PlacedStack {
	/** The block element's id: the stack's identity across peer changes. */
	blockId: string;
	/** The block's peers, primary first. */
	peers: Peer[];
	top: number;
	left: number;
}

/** A badge kept mounted while its peer's departure animates. */
interface LeavingBadge {
	peer: Peer;
	/** Where in the stack the peer was drawn. */
	index: number;
}

/** One badge in a rendered stack. */
interface StackBadge {
	peer: Peer;
	/** Joined a stack that already had a badge: pop in. */
	entering: boolean;
	/** Departed from a stack that keeps its first badge: pop out. */
	leaving: boolean;
}

/**
 * The initials shown when a peer has no avatar image.
 *
 * @param name Display name.
 * @return Up to two initials.
 */
export function initialsOf( name: string ): string {
	return name
		.split( /\s+/ )
		.filter( Boolean )
		.slice( 0, 2 )
		.map( ( word ) => word[ 0 ] )
		.join( '' )
		.toUpperCase();
}

/**
 * Text color that reads on a badge color: dark on light backgrounds.
 *
 * @param color A `#rrggbb` color.
 * @return `#1e1e1e` or `#fff`.
 */
export function nameColorOn( color: string ): string {
	const match = /^#([0-9a-f]{6})$/i.exec( color );
	if ( ! match ) {
		return '#fff';
	}
	const value = parseInt( match[ 1 ], 16 );
	// eslint-disable-next-line no-bitwise
	const [ r, g, b ] = [ value >> 16, ( value >> 8 ) & 255, value & 255 ];
	const luminance = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) / 255;
	return luminance > 0.6 ? '#1e1e1e' : '#fff';
}

function Badge( { peer, entering, leaving }: StackBadge ) {
	const [ loaded, setLoaded ] = useState( false );
	// Decided once, when the badge mounts: later renders (a re-measure,
	// a peer elsewhere) must not cut the pop-in short by dropping the
	// class.
	const [ popsIn ] = useState( entering );
	const name = peer.identity.name || __( 'Anonymous User' );
	const src = peer.identity.avatarUrl;
	const className = [
		'gse-avatar',
		'is-badge',
		'is-small',
		loaded ? 'has-src' : null,
		popsIn ? 'is-entering' : null,
		leaving ? 'is-leaving' : null,
	]
		.filter( Boolean )
		.join( ' ' );
	const style: StyleWithVars = {
		'--gse-avatar-outline-color': peer.color,
		'--gse-avatar-name-color': nameColorOn( peer.color ),
	};
	return (
		<div
			className={ className }
			style={ style }
			role="img"
			aria-label={ name }
		>
			<span className="gse-avatar__image">
				{ src && (
					<img
						src={ src }
						alt=""
						crossOrigin="anonymous"
						className="gse-avatar__img"
						onLoad={ () => setLoaded( true ) }
						onError={ () => setLoaded( false ) }
					/>
				) }
				{ ! loaded && initialsOf( name ) }
			</span>
			<span className="gse-avatar__name">{ name }</span>
		</div>
	);
}

/**
 * Measures every marked block in the canvas document.
 *
 * @param doc   The canvas document.
 * @param peers The peers, by key.
 * @return Stacks to draw, one per block.
 */
function measure( doc: Document, peers: Map< string, Peer > ): PlacedStack[] {
	const win = doc.defaultView;
	const scrollX = win?.scrollX ?? 0;
	const scrollY = win?.scrollY ?? 0;
	const placed: PlacedStack[] = [];
	doc.querySelectorAll< HTMLElement >( `[${ PEERS_ATTRIBUTE }]` ).forEach(
		( element ) => {
			const keys = ( element.getAttribute( PEERS_ATTRIBUTE ) ?? '' )
				.split( PEERS_SEPARATOR )
				.filter( Boolean );
			const blockPeers: Peer[] = [];
			for ( const key of keys ) {
				const peer = peers.get( key );
				if ( peer ) {
					blockPeers.push( peer );
				}
			}
			if ( ! blockPeers.length ) {
				return;
			}
			const rect = element.getBoundingClientRect();
			if ( 0 === rect.width && 0 === rect.height ) {
				return;
			}
			placed.push( {
				blockId: element.id || blockPeers[ 0 ].key,
				peers: blockPeers,
				top: rect.top + scrollY,
				left: rect.left + scrollX,
			} );
		}
	);
	return placed;
}

/**
 * The badges to draw for one stack: the current peers, with a departed
 * peer's badge kept at its old place while it pops out. A peer who is
 * back before their pop-out ends is simply current again.
 *
 * @param stack    The measured stack.
 * @param previous The peers drawn for this block last time, if any.
 * @param leaving  The departed badges still animating for this block.
 * @return The badges in stack order.
 */
function stackBadges(
	stack: PlacedStack,
	previous: Peer[] | undefined,
	leaving: LeavingBadge[]
): StackBadge[] {
	const badges: StackBadge[] = stack.peers.map( ( peer ) => ( {
		peer,
		entering:
			!! previous?.length &&
			! previous.some( ( drawn ) => drawn.key === peer.key ),
		leaving: false,
	} ) );
	for ( const departed of leaving ) {
		if ( stack.peers.some( ( peer ) => peer.key === departed.peer.key ) ) {
			continue;
		}
		badges.splice( Math.min( departed.index, badges.length ), 0, {
			peer: departed.peer,
			entering: false,
			leaving: true,
		} );
	}
	return badges;
}

/**
 * The badge layer. Measures on the next animation frame after: a peer
 * change (the block filter, in the editor's own React tree, applies the
 * marker attribute on its own schedule, so the frame lets it land first),
 * any marker or block change in the canvas (a MutationObserver: the
 * peer's block arriving, moving, or losing its marker), an editor change
 * settling (blocks resized by typing), and a canvas resize.
 */
export function PresenceBadges() {
	const peers = useSelect( ( select ) => select( store ).getPeers(), [] );
	const [ layoutTick, setLayoutTick ] = useState( 0 );
	const [ placed, setPlaced ] = useState< PlacedStack[] >( [] );
	const [ leaving, setLeaving ] = useState<
		Record< string, LeavingBadge[] >
	>( {} );
	// The peers drawn per block on the last commit, in stack order: what
	// decides who is joining and who has departed. Peers, not keys, so a
	// departure still has an identity to draw once the store has dropped
	// the peer (a tab that closed).
	const drawnRef = useRef< Record< string, Peer[] > >( {} );
	const leaveTimers = useRef< Set< ReturnType< typeof setTimeout > > >(
		new Set()
	);
	const doc = getCanvasDocument();

	// Departures: a peer drawn last time but not now, from a stack that
	// still stands, keeps a badge for the pop-out unless they were the
	// stack's first peer. Runs before paint so the badge never blinks off
	// and back on. Stacks that are gone entirely animate nothing.
	useLayoutEffect( () => {
		const drawn = drawnRef.current;
		const departures: Record< string, LeavingBadge[] > = {};
		const next: Record< string, Peer[] > = {};
		for ( const stack of placed ) {
			const before = drawn[ stack.blockId ] ?? [];
			next[ stack.blockId ] = stack.peers;
			before.forEach( ( peer, index ) => {
				if (
					0 === index ||
					stack.peers.some( ( current ) => current.key === peer.key )
				) {
					return;
				}
				( departures[ stack.blockId ] ??= [] ).push( { peer, index } );
			} );
		}
		drawnRef.current = next;
		if ( ! Object.keys( departures ).length ) {
			return;
		}
		setLeaving( ( current ) => {
			const merged = { ...current };
			for ( const blockId in departures ) {
				merged[ blockId ] = [
					...( merged[ blockId ] ?? [] ).filter(
						( kept ) =>
							! departures[ blockId ].some(
								( gone ) => gone.peer.key === kept.peer.key
							)
					),
					...departures[ blockId ],
				];
			}
			return merged;
		} );
		const timer = setTimeout( () => {
			leaveTimers.current.delete( timer );
			setLeaving( ( current ) => {
				const remaining: Record< string, LeavingBadge[] > = {};
				for ( const blockId in current ) {
					const kept = current[ blockId ].filter(
						( badge ) =>
							! departures[ blockId ]?.some(
								( gone ) => gone.peer.key === badge.peer.key
							)
					);
					if ( kept.length ) {
						remaining[ blockId ] = kept;
					}
				}
				return remaining;
			} );
		}, LEAVE_ANIMATION_MS );
		leaveTimers.current.add( timer );
	}, [ placed ] );

	useEffect( () => {
		const timers = leaveTimers.current;
		return () => {
			timers.forEach( ( timer ) => clearTimeout( timer ) );
			timers.clear();
		};
	}, [] );

	// Editor changes, debounced: the canvas settles before we measure.
	useEffect( () => {
		let timer: ReturnType< typeof setTimeout > | null = null;
		const unsubscribe = subscribe( () => {
			if ( timer ) {
				clearTimeout( timer );
			}
			timer = setTimeout( () => {
				timer = null;
				setLayoutTick( ( tick ) => tick + 1 );
			}, RELAYOUT_DELAY_MS );
		}, 'core/block-editor' );
		return () => {
			unsubscribe();
			if ( timer ) {
				clearTimeout( timer );
			}
		};
	}, [] );

	// Canvas resizes (window width, content height) and marker changes.
	useEffect( () => {
		const body = doc.body;
		if ( ! body ) {
			return;
		}
		let frame: number | null = null;
		const relayout = () => {
			if ( null !== frame ) {
				return;
			}
			frame = requestAnimationFrame( () => {
				frame = null;
				setLayoutTick( ( tick ) => tick + 1 );
			} );
		};
		const resize =
			'undefined' !== typeof ResizeObserver
				? new ResizeObserver( relayout )
				: null;
		resize?.observe( body );
		const mutation =
			'undefined' !== typeof MutationObserver
				? new MutationObserver( relayout )
				: null;
		mutation?.observe( body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [ PEERS_ATTRIBUTE ],
		} );
		return () => {
			resize?.disconnect();
			mutation?.disconnect();
			if ( null !== frame ) {
				cancelAnimationFrame( frame );
			}
		};
	}, [ doc ] );

	useEffect( () => {
		if ( ! peers.length ) {
			setPlaced( ( current ) => ( current.length ? [] : current ) );
			return;
		}
		ensureCanvasStyles( doc );
		const byKey = new Map( peers.map( ( peer ) => [ peer.key, peer ] ) );
		// The editor's React tree applies the markers on its own schedule;
		// measure once it has had a frame to do so.
		const frame = requestAnimationFrame( () => {
			setPlaced( measure( doc, byKey ) );
		} );
		return () => cancelAnimationFrame( frame );
	}, [ peers, layoutTick, doc ] );

	if ( ! doc.body || ! placed.length ) {
		return null;
	}

	return createPortal(
		<div className="gse-presence-layer">
			{ placed.map( ( stack ) => (
				<div
					key={ stack.blockId }
					className="gse-presence-badge"
					style={ {
						top: `${ stack.top }px`,
						left: `${ stack.left }px`,
					} }
				>
					<div className="gse-avatar-group" role="group">
						{ stackBadges(
							stack,
							drawnRef.current[ stack.blockId ],
							leaving[ stack.blockId ] ?? []
						).map( ( badge ) => (
							<Badge key={ badge.peer.key } { ...badge } />
						) ) }
					</div>
				</div>
			) ) }
		</div>,
		doc.body
	);
}
