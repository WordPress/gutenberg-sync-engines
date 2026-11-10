/**
 * Styles for the review panel and the in-canvas cards. The panel lives in
 * the editor's sidebar and the cards render in the block popover slot,
 * both in the admin document, so one stylesheet in the admin document
 * covers them. The design tokens (`@wordpress/base-styles`) are inlined,
 * as the awareness styles do.
 */

const STYLE_ID = 'gutenberg-sync-engines-review-styles';

const GRAY_100 = '#f0f0f0';
const GRAY_200 = '#e0e0e0';
const GRAY_700 = '#757575';
const ALERT_YELLOW = '#f0b849';
const WHITE = '#fff';
const ELEVATION_MEDIUM =
	'0 2px 3px rgba(0, 0, 0, 0.05), 0 4px 5px rgba(0, 0, 0, 0.04), 0 12px 12px rgba(0, 0, 0, 0.03), 0 16px 16px rgba(0, 0, 0, 0.02)';

export const REVIEW_STYLES = `
.gse-review-panel__description {
	color: ${ GRAY_700 };
	margin-bottom: 12px;
}

.gse-review-panel__item {
	border-top: 1px solid ${ GRAY_200 };
	padding: 12px 0;
}
.gse-review-panel__item:last-of-type {
	padding-bottom: 0;
}
.gse-review-panel__item .gse-review-panel__attribution {
	margin: 0 0 4px;
}
.gse-review-panel__item .gse-review-panel__summary {
	color: ${ GRAY_700 };
	margin: 0 0 8px;
	overflow-wrap: break-word;
}
.gse-review-panel__item .gse-review-panel__actions {
	display: flex;
	gap: 8px;
}

/* The card must not swallow clicks meant for the block below it. */
.gse-review-pending-card .components-popover__content,
.gse-review-insertion-card .components-popover__content {
	background: none;
	border: none;
	box-shadow: none;
	overflow: visible;
}

.gse-review-pending-card__body {
	background: ${ WHITE };
	border: 1px solid ${ ALERT_YELLOW };
	border-radius: 4px;
	box-shadow: ${ ELEVATION_MEDIUM };
	margin-top: 4px;
	max-height: 60vh;
	max-width: 320px;
	min-width: 280px;
	overflow-y: auto;
	padding: 12px;
}
.gse-review-pending-card__attribution {
	font-weight: 600;
	margin: 0 0 4px;
}
.gse-review-pending-card__summary {
	color: ${ GRAY_700 };
	margin: 0 0 8px;
	overflow-wrap: break-word;
}
.gse-review-pending-card__actions {
	align-items: center;
	display: flex;
	gap: 8px;
}
.gse-review-pending-card__hint {
	color: ${ GRAY_700 };
	font-size: 12px;
}

.gse-review-insertion-card__body {
	background: ${ WHITE };
	border: 1px dashed ${ ALERT_YELLOW };
	border-radius: 4px;
	box-shadow: ${ ELEVATION_MEDIUM };
	margin: 4px 0;
	max-width: 360px;
	min-width: 280px;
	padding: 12px;
}
.gse-review-insertion-card__attribution {
	font-weight: 600;
	margin: 0 0 4px;
}
.gse-review-insertion-card__type {
	color: ${ GRAY_700 };
	font-family: monospace;
	margin: 0 0 4px;
}
.gse-review-insertion-card__preview {
	background: ${ GRAY_100 };
	border-radius: 2px;
	margin: 0 0 8px;
	max-height: 12em;
	overflow: auto;
	padding: 8px;
	white-space: pre-wrap;
	word-break: normal;
	overflow-wrap: anywhere;
}
.gse-review-insertion-card__actions {
	align-items: center;
	display: flex;
	gap: 8px;
}
.gse-review-insertion-card__hint {
	color: ${ GRAY_700 };
	font-size: 12px;
}
`;

/**
 * Adds the stylesheet to the admin document once.
 *
 * @param doc The document; injectable for tests.
 */
export function ensureReviewStyles( doc: Document = document ): void {
	if ( doc.getElementById( STYLE_ID ) ) {
		return;
	}
	const style = doc.createElement( 'style' );
	style.id = STYLE_ID;
	style.textContent = REVIEW_STYLES;
	doc.head.appendChild( style );
}
