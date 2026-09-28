// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
/**
 * The fabricated security-hold contents shown by the prototype review UI.
 *
 * The engines detect and park real wp_kses rejections (review items with
 * the `requires-approval` reason), and resolving the dialog settles those
 * real items, but the CONTENTS presented are these pre-set placeholders
 * while the UI design settles. Making the engines supply the real held
 * markup is follow-up work.
 */

/**
 * A brand-new block proposal: an untrusted user inserted a block whose
 * markup needs approval. There is no prior version to compare against.
 */
export const MOCK_KSES_NEW = {
	kind: 'new',
	proposed: `<!-- wp:html -->
<script>alert(0);</script>
<!-- /wp:html -->`,
};

/**
 * An update to an existing block: an untrusted user changed markup that
 * needs approval, so there is an original to diff the proposal against.
 */
export const MOCK_KSES_UPDATE = {
	kind: 'update',
	original: `<!-- wp:html -->
<script data-wp-block-html="js">
alert(0);
</script>
<!-- /wp:html -->`,
	proposed: `<!-- wp:html -->
<script data-wp-block-html="js">
alert('changed');
</script>
<!-- /wp:html -->`,
};
