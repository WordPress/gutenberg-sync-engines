/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * Internal dependencies
 */
import { createActionCapture } from '../../js/semantic-capture/capture';
import { applyPlainTextEvent } from '../../js/semantic-capture/yjs-text';

// Development UI. Gutenberg actions arrive through the plugin's selected
// entity provider; this fixture does not register another Gutenberg observer.
const pending = new WeakMap();
const entries = [];
const stats = { reads: 0, targeted: 0, fallback: 0, resets: 0 };
const session = crypto.randomUUID();
let panel;

function render() {
	if ( ! panel ) {
		panel = document.createElement( 'details' );
		panel.id = 'gse-action-history';
		panel.style.cssText =
			'position:fixed;bottom:16px;right:16px;z-index:100000;background:white;color:#1e1e1e;border:1px solid #949494;padding:12px;max-width:420px;max-height:40vh;overflow:auto;box-shadow:0 2px 8px #0003';
		document.body.append( panel );
	}
	const open = panel.open;
	panel.replaceChildren();
	const title = document.createElement( 'summary' );
	title.textContent = `Editing history · ${ entries.length } actions`;
	panel.append( title );
	const note = document.createElement( 'p' );
	note.textContent =
		'Prototype: local evidence only. Download it before closing this tab.';
	panel.append( note );
	const status = document.createElement( 'p' );
	status.textContent = `${ stats.targeted } text edits used the targeted path. Other changes use the existing sync path.`;
	panel.append( status );
	const download = document.createElement( 'button' );
	download.textContent = 'Download history';
	download.onclick = () => {
		const url = URL.createObjectURL(
			new Blob(
				[ JSON.stringify( { session, stats, entries }, null, 2 ) ],
				{ type: 'application/json' }
			)
		);
		const link = document.createElement( 'a' );
		link.href = url;
		link.download = 'editing-history.json';
		link.click();
		URL.revokeObjectURL( url );
	};
	panel.append( download );
	const list = document.createElement( 'ol' );
	for ( const entry of entries.slice( -20 ) ) {
		const item = document.createElement( 'li' );
		item.textContent = entry.description;
		list.append( item );
	}
	panel.append( list );
	panel.open = open;
}

function description( event ) {
	if ( event.kind === 'attributes' ) {
		if ( event.fields[ event.before[ 0 ].id ]?.join() !== 'content' ) {
			return `Changed block fields: ${ Object.values( event.fields )
				.flat()
				.join( ', ' ) }.`;
		}
		return `Changed paragraph: “${ event.before[ 0 ].attributes.content }” to “${ event.after[ 0 ].attributes.content }”.`;
	}
	if ( event.kind === 'move' ) {
		return `Moved “${
			event.before[ 0 ].attributes.content
		}” from position ${ event.before[ 0 ].index + 1 } to ${
			event.after[ 0 ].index + 1
		}.`;
	}
	if ( event.kind === 'split' ) {
		return `Split “${ event.before[ 0 ].attributes.content }” into ${ event.after.length } paragraphs.`;
	}
	return `Replaced ${ event.before.length } block(s) with ${ event.after.length } block(s).`;
}

function readBlock( state, clientId ) {
	stats.reads++;
	const block = state.blocks.byClientId.get( clientId );
	if ( ! block ) {
		return null;
	}
	const original = state.blocks.attributes.get( clientId );
	const attributes = { ...original };
	// Gutenberg stores RichTextData objects. Preserve the HTML string as
	// evidence; the plain-text adapter explicitly refuses markup.
	if ( attributes.content !== undefined ) {
		attributes.content = attributes.content.toString();
	}
	const parent = state.blocks.parents.get( clientId ) || '';
	return {
		clientId,
		// Yjs adopts shared clientIds at join. This prototype's identity is
		// session-scoped; it does not promise durable identity across resets.
		id: clientId,
		name: block.name,
		attributes: JSON.parse( JSON.stringify( attributes ) ),
		parent,
		index: state.blocks.order.get( parent ).indexOf( clientId ),
		childCount: state.blocks.order.get( clientId )?.length || 0,
	};
}

function captureAction( { registry, action, before, after } ) {
	if ( ! before || ! after ) {
		return;
	}
	if ( action.type === 'RESET_BLOCKS' ) {
		stats.resets++;
		return; // Incoming content and initial loading use this path.
	}
	if (
		! [
			'UPDATE_BLOCK_ATTRIBUTES',
			'MOVE_BLOCKS_TO_POSITION',
			'MOVE_BLOCKS_UP',
			'MOVE_BLOCKS_DOWN',
			'REPLACE_BLOCKS',
		].includes( action.type )
	) {
		return;
	}
	const post = registry.select( 'core/editor' );
	const entity = `postType/${ post.getCurrentPostType() }:${ post.getCurrentPostId() }`;
	const command = action.meta?.editingOperation;
	const capture = createActionCapture( {
		context: () => ( { entity, source: 'local', command } ),
		createId: () => crypto.randomUUID(),
		readBlock,
	} );
	let state = before;
	capture.middleware( { getState: () => state } )( () => {
		state = after;
	} )( action );
	const tree = after.blocks.tree.get( '' )?.innerBlocks;
	const oldTree = before.blocks.tree.get( '' )?.innerBlocks;
	const prior = pending.get( oldTree ) || [];
	if ( tree && capture.events.length ) {
		pending.set( tree, [ ...prior, ...capture.events ] );
	}
	for ( const event of capture.events ) {
		entries.push( {
			event,
			description: description( event ),
			result: 'captured',
			session,
		} );
	}
	for ( const fallback of capture.fallbacks ) {
		entries.push( {
			fallback,
			description: `Used the existing sync path: ${ fallback.reason }.`,
			session,
		} );
	}
	queueMicrotask( render );
}

window._gseSemanticPrototype = {
	capture: captureAction,
	apply( doc, changes, entity ) {
		if ( ! Array.isArray( changes.blocks ) ) {
			return false;
		}
		const events = pending.get( changes.blocks );
		pending.delete( changes.blocks );
		if ( events?.length !== 1 || events[ 0 ].entity !== entity ) {
			stats.fallback++;
			return false;
		}
		const event = events[ 0 ];
		const block = event.before[ 0 ];
		const yblocks = doc.getMap( 'document' ).get( 'blocks' );
		const yblock = yblocks instanceof Y.Array && yblocks.get( block.index );
		const text =
			yblock instanceof Y.Map &&
			yblock.get( 'attributes' )?.get( 'content' );
		const accepted =
			block.parent === '' &&
			yblock?.get( 'clientId' ) === block.clientId &&
			text instanceof Y.Text &&
			applyPlainTextEvent( doc, event, () => text );
		const entry = entries.find( ( item ) => item.event?.id === event.id );
		if ( entry ) {
			entry.result = accepted ? 'targeted-yjs' : 'existing-sync-path';
		}
		stats[ accepted ? 'targeted' : 'fallback' ]++;
		queueMicrotask( render );
		return !! accepted;
	},
};
window.gseActionHistory = { entries, stats, session };
queueMicrotask( render );
