/**
 * Styles for the in-canvas presence indicators, injected into the block
 * canvas document (the editor iframe) where the plugin's stylesheet does
 * not reach.
 *
 * Both rule sets are copies of the framework's own, under plugin-owned
 * class names, so the outline and the avatar badge look the same as the
 * ones Gutenberg draws for live cursors:
 *
 * - The outline mirrors `.is-collaborator-selected` from
 *   `packages/editor/src/components/collaborators-overlay/overlay-iframe-styles.ts`.
 * - The badge mirrors the `Avatar` component's `badge` variant from
 *   `packages/editor/src/components/collaborators-overlay/avatar-iframe-styles.ts`.
 * - The stack mirrors `AvatarGroup` from
 *   `packages/editor/src/components/collaborators-presence/avatar-group/`
 *   (later avatars tucked 8px under earlier ones), with one addition: the
 *   header group expands nothing on hover, while here hovering the stack
 *   spreads it out and opens every badge so each name can be read.
 *
 * The compiled design tokens (`collaborator-styles.ts` there) are inlined.
 */

const CANVAS_STYLE_ID = 'gutenberg-sync-engines-awareness-styles';

const WHITE = '#fff';
const ELEVATION_X_SMALL =
	'0 1px 1px rgba(0, 0, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.02), 0 3px 3px rgba(0, 0, 0, 0.02), 0 4px 4px rgba(0, 0, 0, 0.01)';

const CANVAS_STYLES = `
/*
 * The full-block outline, on every block a peer is in. The framework's
 * rule ends in :not(:focus) so the editor's own focus outline (the same
 * pseudo-element, the admin color) takes over when the local user selects
 * that block; here the peer's outline stays, so the color and the
 * geometry need to win over the editor's focus rule.
 *
 * The framework draws the outline 2px INSIDE the block box, which on a
 * text block is the text's own edge. Here the pseudo-element is pushed
 * out by 1px plus the outline width, so the outline's inner edge sits
 * 1px clear of the text.
 *
 * The pseudo-element comes into being when the class lands, so the short
 * fade runs exactly when the outline appears (and again if a block the
 * editor was already outlining gains a peer, since the animation name
 * changes then).
 */
@keyframes gse-outline-fade-in {
	from {
		opacity: 0;
	}
	to {
		opacity: 1;
	}
}
.block-editor-block-list__block.gse-presence::after {
	animation: gse-outline-fade-in 0.15s ease-out;
	--gse-outline-inset: calc(-1px - var(--wp-admin-border-width-focus, 2px) / var(--wp-block-editor-iframe-zoom-out-scale, 1));
	content: "";
	position: absolute;
	pointer-events: none;
	top: var(--gse-outline-inset) !important;
	right: var(--gse-outline-inset) !important;
	bottom: var(--gse-outline-inset) !important;
	left: var(--gse-outline-inset) !important;
	outline-color: var(--gse-outline-color) !important;
	outline-style: solid;
	outline-width: calc(var(--wp-admin-border-width-focus, 2px) / var(--wp-block-editor-iframe-zoom-out-scale, 1));
	outline-offset: calc(-1 * var(--wp-admin-border-width-focus, 2px) / var(--wp-block-editor-iframe-zoom-out-scale, 1));
	box-shadow: inset 0 0 0 calc((var(--wp-admin-border-width-focus, 2px) / var(--wp-block-editor-iframe-zoom-out-scale, 1)) + 0.5px) rgba(255, 255, 255, 0.7);
	z-index: 1;
}

/* The badge layer: a zero-size anchor at the document origin. */
.gse-presence-layer {
	position: absolute;
	top: 0;
	left: 0;
	width: 0;
	height: 0;
	overflow: visible;
	pointer-events: none;
	z-index: 20001;
}
/* One badge, placed at a block's top-left and lifted above it. */
.gse-presence-badge {
	position: absolute;
	z-index: 1;
	transform: translateY(calc(-100% - 8px));
	pointer-events: auto;
	overflow: visible;
	width: max-content;
}

/*
 * The stack: the block's peers side by side, primary first. Later avatars
 * tuck under earlier ones (negative start margin, descending z-index).
 * Hovering anywhere on the stack removes the overlap; the badges' own
 * hover rules below open each name at the same time.
 */
.gse-avatar-group {
	display: flex;
	align-items: center;
}
.gse-avatar-group > .gse-avatar + .gse-avatar {
	margin-inline-start: -8px;
	transition: margin-inline-start 0.3s cubic-bezier(0.15, 0, 0.15, 1);
}
.gse-avatar-group:hover > .gse-avatar + .gse-avatar {
	margin-inline-start: 4px;
	transition-timing-function: cubic-bezier(0.85, 0, 0.85, 1);
}
${ Array.from(
	{ length: 10 },
	( _, index ) =>
		`.gse-avatar-group > .gse-avatar:nth-child(${ index + 1 }) { z-index: ${
			10 - index
		}; }`
).join( '\n' ) }

/*
 * Joining and leaving a stack that is already drawn. A joiner pops in
 * from nothing (its slot grows from zero so the neighbors slide rather
 * than jump); a leaver shrinks away and its slot closes. The first badge
 * on a block appears and disappears plainly (no class). The pop-in fills
 * backwards only, so the base rules (and the hover spread) take over the
 * moment it ends; the pop-out fills forwards, staying collapsed until
 * the badge is removed.
 */
@keyframes gse-avatar-pop-in {
	from {
		width: 0;
		margin-inline-start: 0;
		transform: scale(0.3);
		opacity: 0;
	}
	60% {
		width: 24px;
		margin-inline-start: -8px;
		transform: scale(1.15);
		opacity: 1;
	}
	to {
		width: 24px;
		margin-inline-start: -8px;
		transform: scale(1);
		opacity: 1;
	}
}
@keyframes gse-avatar-pop-out {
	from {
		width: 24px;
		margin-inline-start: -8px;
		transform: scale(1);
		opacity: 1;
	}
	to {
		width: 0;
		margin-inline-start: 0;
		transform: scale(0.3);
		opacity: 0;
	}
}
.gse-avatar-group > .gse-avatar.is-entering {
	animation: gse-avatar-pop-in 0.3s cubic-bezier(0.15, 0, 0.15, 1) backwards;
}
.gse-avatar-group > .gse-avatar.is-leaving {
	animation: gse-avatar-pop-out 0.25s cubic-bezier(0.85, 0, 0.85, 1) forwards;
	pointer-events: none;
}

/* The avatar badge (the framework's Avatar, badge variant, small). */
.gse-avatar {
	position: relative;
	display: inline-grid;
	grid-template-columns: min-content 0fr;
	column-gap: 0;
	align-items: center;
	padding-inline-end: 0;
	border-radius: 9999px;
	flex-shrink: 0;
	box-shadow: 0 0 0 var(--wp-admin-border-width-focus, 2px) ${ WHITE }, ${ ELEVATION_X_SMALL };
	background-color: var(--gse-avatar-outline-color, var(--wp-admin-theme-color, #3858e9));
	transition:
		grid-template-columns 0.3s cubic-bezier(0.15, 0, 0.15, 1),
		column-gap 0.3s cubic-bezier(0.15, 0, 0.15, 1),
		padding-inline-end 0.3s cubic-bezier(0.15, 0, 0.15, 1);
}
.gse-avatar-group:hover .gse-avatar {
	grid-template-columns: min-content 1fr;
	column-gap: 4px;
	padding-inline-end: 8px;
	transition-timing-function: cubic-bezier(0.85, 0, 0.85, 1);
}
.gse-avatar__image {
	box-sizing: border-box;
	position: relative;
	width: 24px;
	height: 24px;
	border-radius: 9999px;
	border: var(--wp-admin-border-width-focus, 2px) solid var(--gse-avatar-outline-color);
	background-clip: padding-box;
	background-color: var(--gse-avatar-outline-color, var(--wp-admin-theme-color, #3858e9));
	overflow: hidden;
	overflow: clip;
	flex-shrink: 0;
	font-size: 0;
	color: ${ WHITE };
}
.gse-avatar__image::after {
	content: "";
	position: absolute;
	inset: 0;
	border-radius: inherit;
	box-shadow: inset 0 0 0 var(--wp-admin-border-width-focus, 2px) ${ WHITE };
	pointer-events: none;
	z-index: 1;
}
.gse-avatar__img {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	border-radius: inherit;
	opacity: 0;
}
.gse-avatar.has-src > .gse-avatar__image > .gse-avatar__img {
	opacity: 1;
}
/* No image: initials on the peer's color. */
.gse-avatar:not(.has-src) > .gse-avatar__image {
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 11px;
	font-weight: var(--wpds-typography-font-weight-emphasis, 600);
	border: 0;
	background-clip: border-box;
}
.gse-avatar:not(.has-src) > .gse-avatar__image::after {
	content: none;
}
.gse-avatar__name {
	font-size: 13px;
	font-weight: var(--wpds-typography-font-weight-emphasis, 600);
	line-height: 20px;
	color: var(--gse-avatar-name-color, ${ WHITE });
	min-width: 0;
	padding-bottom: 2px;
	overflow: hidden;
	opacity: 0;
	white-space: nowrap;
	transition: opacity 0.15s cubic-bezier(0.15, 0, 0.15, 1);
}
.gse-avatar-group:hover .gse-avatar__name {
	opacity: 1;
	transition-timing-function: cubic-bezier(0.85, 0, 0.85, 1);
}
@media (prefers-reduced-motion: reduce) {
	.gse-avatar-group > .gse-avatar + .gse-avatar,
	.gse-avatar,
	.gse-avatar__name {
		transition: none;
	}
	.block-editor-block-list__block.gse-presence::after,
	.gse-avatar-group > .gse-avatar.is-entering {
		animation: none;
	}
	.gse-avatar-group > .gse-avatar.is-leaving {
		display: none;
	}
}
`;

/**
 * Injects the styles into a document once.
 *
 * @param doc The document holding the blocks.
 */
export function ensureCanvasStyles( doc: Document ): void {
	if ( doc.getElementById( CANVAS_STYLE_ID ) ) {
		return;
	}
	const style = doc.createElement( 'style' );
	style.id = CANVAS_STYLE_ID;
	style.textContent = CANVAS_STYLES;
	( doc.head ?? doc.documentElement ).appendChild( style );
}

/**
 * The document that holds the block canvas: the editor iframe's when there
 * is one, else the page.
 *
 * @return The document.
 */
export function getCanvasDocument(): Document {
	const iframe = document.querySelector< HTMLIFrameElement >(
		'iframe[name="editor-canvas"]'
	);
	return iframe?.contentDocument ?? document;
}
