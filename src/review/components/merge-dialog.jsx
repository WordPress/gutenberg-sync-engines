// @ts-nocheck -- Prototype JavaScript moved as is from the bundled Gutenberg fork; typing it (TSX) is a later pass.
import { useState } from '@wordpress/element';
import { useSelect } from '@wordpress/data';
import { __ } from '@wordpress/i18n';
import { Button, Modal, Notice } from '@wordpress/components';
import { parse, serialize } from '@wordpress/blocks';
import { store as coreStore } from '@wordpress/core-data';
import BlockDiffPane, { BlockDiffResources } from './block-diff-pane';
import MergedResultEditor from './merged-result-editor';

/**
 * The notice a review dialog shows when the record has no base: the
 * comparison then runs from the current version to the proposed one.
 */
export function MissingBaseNotice() {
	return (
		<Notice
			className="gse-review-merge-dialog__notice"
			status="warning"
			isDismissible={ false }
		>
			{ __(
				'The version both edits started from is no longer available. The proposed version is compared with the current version, so the current version shows no changes of its own.'
			) }
		</Notice>
	);
}

/**
 * The notice a review dialog shows when the record changed while the
 * dialog was open: a collaborator edited the content, or the author
 * typed on. The dialog says what it did with the result the reviewer is
 * working on.
 *
 * @param {Object}   props
 * @param {string}   props.children  What happened, in the dialog's words.
 * @param {Function} props.onDismiss Hide the notice.
 */
export function ChangedWhileReviewingNotice( { children, onDismiss } ) {
	return (
		<Notice
			className="gse-review-merge-dialog__notice"
			status="warning"
			onRemove={ onDismiss }
		>
			{ children }
		</Notice>
	);
}

/**
 * One version pane: a heading, this version's blocks rendered read-only
 * with the revisions diff highlighting against the base version, and a
 * button copying this version into the merged result.
 *
 * @param {Object}   props
 * @param {string}   props.label       Pane heading.
 * @param {string}   props.content     This version as serialized blocks.
 * @param {string}   props.baseContent The version the diff is computed
 *                                     against, as serialized blocks.
 * @param {Function} props.onRestore   Copy this version into the merged
 *                                     result.
 */
function Pane( { label, content, baseContent, onRestore } ) {
	return (
		<div className="gse-review-merge-dialog__pane">
			<h3 className="gse-review-merge-dialog__pane-label">{ label }</h3>
			<div className="gse-review-merge-dialog__pane-content">
				<BlockDiffPane
					content={ content }
					baseContent={ baseContent }
				/>
			</div>
			<Button
				__next40pxDefaultSize
				size="compact"
				variant="secondary"
				onClick={ onRestore }
			>
				{ __( 'Restore this version' ) }
			</Button>
		</div>
	);
}

/**
 * The merge dialog's content: the proposed version and the current
 * version side by side, each rendered as read-only blocks diffed against
 * the SHARED BASE both started from with the revisions diff system, so
 * each pane highlights only its own changes at both grains: block-level
 * added/removed/modified markers and inline ins/del inside rich text.
 * Every side is serialized block content, one block or several, so the
 * same dialog serves a paragraph and a whole section (a conflict with no
 * per-block answer, like a paragraph split on one side and edited on the
 * other).
 *
 * Without a base (the engine could no longer recover it) the proposed
 * version is compared against the current one, which then shows no
 * changes of its own. A notice tells the reviewer so: the panes would
 * otherwise read as if the current version had changed nothing.
 *
 * The merged result below the panes is a real block editor seeded from
 * the current version. Either pane's "Restore this version" reseeds it
 * wholly. Accept hands the merged result back as serialized block
 * content; Cancel closes without changing anything.
 *
 * The record can change while the dialog is open: a collaborator edits
 * the block, or the author types on. The panes always show the record
 * as it is. The merged result follows only while it is still a plain
 * copy of the version that changed. Once the reviewer has edited it by
 * hand it is left alone. Either way a notice says so, because accepting
 * a result built from the older version would undo the newer edit.
 *
 * The merged editor deliberately stays free of the diff highlighting:
 * the inline diff marks are rich-text formats living in the content,
 * and they would serialize into the accepted result.
 *
 * Position-independent so it can be unit-tested without the modal.
 *
 * @param {Object}         props
 * @param {?string}        props.base          Serialized blocks both
 *                                             versions started from, or
 *                                             null when unknown.
 * @param {string}         props.proposed      The author's version.
 * @param {string}         props.current       The document's current
 *                                             version.
 * @param {string}         props.proposedLabel The proposed pane's heading.
 * @param {string|boolean} props.templateLock  The merged editor's lock:
 *                                             'all' keeps the structure
 *                                             (text and formatting only),
 *                                             false lets blocks be added,
 *                                             removed, and split.
 * @param {string}         props.help          The line under the merged
 *                                             editor.
 * @param {Function}       props.onAccept      ( mergedContent ) => void,
 *                                             with the merged result as
 *                                             serialized blocks.
 * @param {Function}       props.onCancel      Close without resolving.
 */
export function MergeDialogBody( {
	base,
	proposed,
	current,
	proposedLabel = __( 'Your version' ),
	templateLock = false,
	help = __( 'These blocks replace the conflicted content when you accept.' ),
	onAccept,
	onCancel,
} ) {
	// The merged result starts as the current version's blocks. Either
	// pane's "Restore this version" reseeds it, and it stays
	// hand-editable in the merged block editor below the panes.
	const [ merged, setMerged ] = useState( () => parse( current ) );
	// Which version the merged result is a plain copy of: 'current',
	// 'proposed', or null once the reviewer has edited it by hand.
	const [ seedSide, setSeedSide ] = useState( 'current' );
	// The versions as the dialog last showed them, and what it did with
	// the merged result when they last changed: 'updated', 'kept', or
	// null (nothing changed, or the notice was dismissed).
	const [ shown, setShown ] = useState( { proposed, current } );
	const [ changeHandling, setChangeHandling ] = useState( null );
	const isBaseMissing = null === base || undefined === base;
	const baseContent = base ?? current;

	if ( shown.proposed !== proposed || shown.current !== current ) {
		setShown( { proposed, current } );

		if ( 'current' === seedSide && shown.current !== current ) {
			setMerged( parse( current ) );
			setChangeHandling( 'updated' );
		} else if ( 'proposed' === seedSide && shown.proposed !== proposed ) {
			setMerged( parse( proposed ) );
			setChangeHandling( 'updated' );
		} else {
			setChangeHandling( 'kept' );
		}
	}

	const restore = ( side, content ) => {
		setMerged( parse( content ) );
		setSeedSide( side );
	};
	const onEditMerged = ( blocks ) => {
		setMerged( blocks );
		setSeedSide( null );
	};

	return (
		<div className="gse-review-merge-dialog__body">
			<BlockDiffResources />
			<p className="gse-review-merge-dialog__description">
				{ __(
					'These edits could not be merged automatically. Compare the versions and choose what to keep.'
				) }
			</p>
			{ isBaseMissing && <MissingBaseNotice /> }
			{ 'updated' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'This content changed while you were reviewing it. The merged result now starts from the newer version.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			{ 'kept' === changeHandling && (
				<ChangedWhileReviewingNotice
					onDismiss={ () => setChangeHandling( null ) }
				>
					{ __(
						'This content changed while you were reviewing it. The merged result was not changed. Check it against the versions above before you accept.'
					) }
				</ChangedWhileReviewingNotice>
			) }
			<div className="gse-review-merge-dialog__panes">
				<Pane
					label={ proposedLabel }
					content={ proposed }
					baseContent={ baseContent }
					onRestore={ () => restore( 'proposed', proposed ) }
				/>
				<Pane
					label={ __( 'Current version' ) }
					content={ current }
					baseContent={ baseContent }
					onRestore={ () => restore( 'current', current ) }
				/>
			</div>
			<div className="gse-review-merge-dialog__merged">
				<h3 className="gse-review-merge-dialog__pane-label">
					{ __( 'Merged result' ) }
				</h3>
				<MergedResultEditor
					blocks={ merged }
					onChange={ onEditMerged }
					templateLock={ templateLock }
				/>
				<p className="gse-review-merge-dialog__help">{ help }</p>
			</div>
			<div className="gse-review-merge-dialog__actions">
				<Button
					__next40pxDefaultSize
					variant="tertiary"
					onClick={ onCancel }
				>
					{ __( 'Cancel' ) }
				</Button>
				<Button
					__next40pxDefaultSize
					variant="primary"
					onClick={ () => onAccept( serialize( merged ) ) }
				>
					{ __( 'Accept' ) }
				</Button>
			</div>
		</div>
	);
}

/**
 * Whether the person reviewing authored the proposed side, which decides
 * how its pane is named.
 *
 * @param {number} authorId The proposed side's author.
 * @return {boolean} Whether the current user is the author.
 */
export function useIsOwnProposal( authorId ) {
	return useSelect(
		( select ) => select( coreStore ).getCurrentUser()?.id === authorId,
		[ authorId ]
	);
}

/**
 * The built-in merge dialog, opened from a conflicted block's "Review
 * conflict" card. It presents the engine's record as it is: the three
 * sides are the engine's, and the decision goes back to the engine as
 * content.
 *
 * @param {Object}   props
 * @param {Object}   props.conflict  The conflict record.
 * @param {boolean}  props.isSection Whether the record covers a section
 *                                   (several blocks, or a container):
 *                                   the merged editor's structure is
 *                                   then unlocked.
 * @param {Function} props.onDecide  ( decision ) => void.
 * @param {Function} props.onClose   Close without resolving.
 */
export default function CollaborationMergeDialog( {
	conflict,
	isSection,
	onDecide,
	onClose,
} ) {
	const isOwn = useIsOwnProposal( conflict.authorId );
	let className = 'gse-review-merge-dialog';
	if ( isSection ) {
		className += ' gse-review-merge-dialog--section';
	}
	let templateLock = 'all';
	let help = __(
		'This block replaces the conflicted content when you accept.'
	);
	if ( isSection ) {
		templateLock = false;
		help = __(
			'These blocks replace the conflicted section when you accept.'
		);
	}
	let proposedLabel = __( 'Proposed version' );
	if ( isOwn ) {
		proposedLabel = __( 'Your version' );
	}

	return (
		<Modal
			title={ __( 'Review conflicting edits' ) }
			onRequestClose={ onClose }
			className={ className }
			size="large"
		>
			<MergeDialogBody
				base={ conflict.base }
				proposed={ conflict.proposed }
				current={ conflict.current }
				proposedLabel={ proposedLabel }
				templateLock={ templateLock }
				help={ help }
				onAccept={ ( content ) =>
					onDecide( { action: 'accept', content } )
				}
				onCancel={ onClose }
			/>
		</Modal>
	);
}
