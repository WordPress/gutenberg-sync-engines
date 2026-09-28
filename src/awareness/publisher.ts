/**
 * The publisher: samples which block the local selection is in once per
 * interval and hands it to the sync channel when it changed. (The
 * Heartbeat channel needs no publisher: it reads the selection itself
 * as each probe is built.)
 */

/**
 * Internal dependencies
 */
import { focusedBlockId } from './block-id';
import type { BlockTreeReader } from './block-id';

export interface PublisherOptions {
	reader: BlockTreeReader;
	intervalMs: number;
	onPublish: ( block: string | null ) => void;
}

export interface Publisher {
	/** Publishes now, then every interval while the block changes. */
	start: () => void;
	stop: () => void;
}

/**
 * Creates the publisher.
 *
 * @param options Publisher options.
 * @return The publisher.
 */
export function createPresencePublisher(
	options: PublisherOptions
): Publisher {
	const { reader, intervalMs, onPublish } = options;
	let timer: ReturnType< typeof setInterval > | null = null;
	/** The last block published; undefined before the first publish. */
	let lastBlock: string | null | undefined;

	function publish(): void {
		const block = focusedBlockId( reader );
		if ( block === lastBlock ) {
			return;
		}
		lastBlock = block;
		onPublish( block );
	}

	return {
		start() {
			publish();
			timer = setInterval( publish, intervalMs );
		},
		stop() {
			if ( timer ) {
				clearInterval( timer );
				timer = null;
			}
			lastBlock = undefined;
		},
	};
}
