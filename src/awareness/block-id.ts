/**
 * Naming blocks for the wire: the durable identity when the block has
 * one, else the editor clientId.
 */

/**
 * The slice of the block-editor store this module reads. Narrow so tests
 * can hand in a plain object.
 */
export interface BlockTreeReader {
	getSelectedBlockClientId: () => string | null | undefined;
	getSelectionStart: () => { clientId?: string | null } | undefined;
	getBlockAttributes: (
		clientId: string
	) => Record< string, unknown > | null | undefined;
}

/**
 * The `metadata.syncId` of a block, when stamped.
 *
 * @param attributes Block attributes.
 * @return The syncId, or undefined.
 */
export function getSyncId(
	attributes: Record< string, unknown > | null | undefined
): string | undefined {
	const metadata = attributes?.metadata as { syncId?: unknown } | undefined;
	const syncId = metadata?.syncId;
	return 'string' === typeof syncId && '' !== syncId ? syncId : undefined;
}

/**
 * The wire name of a block: its syncId, else its clientId.
 *
 * @param reader   The block-editor store.
 * @param clientId The block's clientId.
 * @return The name, or null when the block does not exist.
 */
export function blockIdOf(
	reader: BlockTreeReader,
	clientId: string
): string | null {
	const attributes = reader.getBlockAttributes( clientId );
	if ( ! attributes ) {
		return null;
	}
	return getSyncId( attributes ) ?? clientId;
}

/**
 * The wire name of the block the local selection is in: the selected
 * block, or the first block of a multi-block selection.
 *
 * @param reader The block-editor store.
 * @return The name, or null when nothing is selected.
 */
export function focusedBlockId( reader: BlockTreeReader ): string | null {
	const clientId =
		reader.getSelectedBlockClientId() ??
		reader.getSelectionStart()?.clientId;
	if ( ! clientId ) {
		return null;
	}
	return blockIdOf( reader, clientId );
}
