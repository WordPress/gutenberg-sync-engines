/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import type { SyncPayload, SyncResponse } from '../http-polling/types';

/**
 * Decode complete SSE events only; partial final events are never applied.
 * @param reader
 * @param onActivity Called for each complete frame, including heartbeats.
 */
export async function* readSse(
	reader: ReadableStreamDefaultReader< Uint8Array >,
	onActivity: () => void = () => {}
): AsyncGenerator< SyncResponse > {
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while ( true ) {
			const { value, done } = await reader.read();
			if ( done ) {
				return;
			}
			buffer += decoder.decode( value, { stream: true } );
			// Bound a malformed/unfinished event rather than growing forever.
			if ( buffer.length > 32 * 1024 * 1024 ) {
				throw new Error( 'SSE event exceeds the size limit' );
			}
			let end: number;
			while ( ( end = buffer.indexOf( '\n\n' ) ) >= 0 ) {
				onActivity();
				const frame = buffer.slice( 0, end );
				buffer = buffer.slice( end + 2 );
				const lines = frame.split( '\n' );
				const event = lines
					.find( ( line ) => line.startsWith( 'event:' ) )
					?.slice( 6 )
					.trim();
				if ( event === 'retry' ) {
					throw new Error( 'SSE notification connection closed' );
				}
				if ( event !== 'sync' ) {
					continue;
				}
				const data = lines
					.filter( ( line ) => line.startsWith( 'data:' ) )
					.map( ( line ) => line.slice( 5 ).replace( /^ /, '' ) )
					.join( '\n' );
				const response = JSON.parse( data ) as SyncResponse;
				if ( ! Array.isArray( response.rooms ) ) {
					throw new Error( 'Invalid SSE response' );
				}
				yield response;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// After a failed stream, receiving runs on ordinary polling for this long
// before SSE is tried again; each further failure in a row doubles the
// wait, up to the cap, so a site without Redis is not asked every 5 s.
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

// A stream with no frame (the server heartbeats every 5 s) is dead.
const INACTIVITY_MS = 25000;

/**
 * What the e2e suite and a curious developer can read off the page:
 * whether a stream is open, how many sync events it has delivered, and
 * the last applied cursor per room.
 */
interface SseDebugState {
	open: boolean;
	events: number;
	rooms: Record< string, number >;
}

/**
 * A receive stream shared by the polling manager's sequential exchanges.
 * It only ever opens and reads streams: the manager sends through the
 * updates request beside it, marked `rows_received_separately: true`, so a send never
 * closes the stream and the stream stays the only path that delivers
 * stored rows and moves a room's cursor. Normal polling remains available
 * while Redis is down.
 */
export class SseExchange {
	private controller?: AbortController;
	private events?: AsyncGenerator< SyncResponse >;
	private signature = '';
	private cursors = new Map< string, number >();
	private retryAfter = 0;
	private failures = 0;
	private eventCount = 0;
	private deadline?: ReturnType< typeof setTimeout >;

	private publishState(): void {
		(
			window as Window & { __wpSyncSseState?: SseDebugState }
		 ).__wpSyncSseState = {
			open: !! this.events,
			events: this.eventCount,
			rooms: Object.fromEntries( this.cursors ),
		};
	}

	private resetTimeout = (): void => {
		clearTimeout( this.deadline );
		this.deadline = setTimeout(
			() => this.controller?.abort(),
			INACTIVITY_MS
		);
	};

	public get available(): boolean {
		return Date.now() >= this.retryAfter;
	}

	/**
	 * Whether a stream response is live right now (opened and not yet
	 * ended or closed).
	 */
	public isOpen(): boolean {
		return !! this.events;
	}

	public close(): void {
		clearTimeout( this.deadline );
		this.controller?.abort();
		this.controller = undefined;
		void this.events?.return( undefined );
		this.events = undefined;
		this.signature = '';
		this.cursors.clear();
		this.publishState();
	}

	public async exchange(
		payload: SyncPayload,
		signal?: AbortSignal
	): Promise< SyncResponse > {
		if ( payload.rooms.some( ( room ) => room.updates.length > 0 ) ) {
			// The manager sends beside the stream; see the class comment.
			throw new Error( 'A stream exchange never carries updates' );
		}
		/*
		 * The stream's identity: which rooms, as which client, under which
		 * engine. Awareness is left out on purpose: a cursor move changes
		 * the tab's awareness many times a minute, and each change rides
		 * the updates request instead (the manager's awareness check), so
		 * the stream stays open across them. `after` is compared against
		 * the delivered cursors below instead.
		 */
		const signature = JSON.stringify(
			payload.rooms.map( ( { after, awareness, updates, ...room } ) => ( {
				...room,
				rows_received_separately: undefined,
			} ) )
		);
		if (
			signature !== this.signature ||
			payload.rooms.some(
				( room ) => this.cursors.get( room.room ) !== room.after
			)
		) {
			this.close();
		}
		const abort = () => this.close();
		signal?.addEventListener( 'abort', abort, { once: true } );
		this.resetTimeout();
		try {
			if ( signal?.aborted ) {
				throw new DOMException( 'Aborted', 'AbortError' );
			}
			// Reopen once after a normal bounded stream ends. The payload
			// contains the manager's last APPLIED cursor, not bytes received.
			for ( let attempt = 0; attempt < 2; attempt++ ) {
				if ( ! this.events ) {
					this.controller = new AbortController();
					this.resetTimeout();
					const response = await apiFetch( {
						path: '/wp-sync/v1/sse',
						method: 'POST',
						data: payload,
						parse: false,
						signal: this.controller.signal,
					} );
					if ( ! response.ok ) {
						throw await response.json();
					}
					if (
						! response.body ||
						! response.headers
							.get( 'content-type' )
							?.includes( 'text/event-stream' )
					) {
						throw new Error( 'SSE response is not a stream' );
					}
					if ( signal?.aborted ) {
						throw new DOMException( 'Aborted', 'AbortError' );
					}
					this.events = readSse(
						response.body.getReader(),
						this.resetTimeout
					);
					this.signature = signature;
					this.publishState();
				}
				const next = await this.events.next();
				if ( signal?.aborted ) {
					throw new DOMException( 'Aborted', 'AbortError' );
				}
				if ( ! next.done ) {
					for ( const room of next.value.rooms ) {
						this.cursors.set( room.room, room.end_cursor );
					}
					this.failures = 0;
					this.eventCount++;
					this.publishState();
					return next.value;
				}
				this.close();
			}
			throw new Error( 'SSE ended without a response' );
		} catch ( error ) {
			this.close();
			if ( ! signal?.aborted ) {
				this.failures++;
				this.retryAfter =
					Date.now() +
					Math.min(
						RETRY_MAX_MS,
						RETRY_BASE_MS * 2 ** ( this.failures - 1 )
					);
			}
			throw error;
		} finally {
			clearTimeout( this.deadline );
			signal?.removeEventListener( 'abort', abort );
		}
	}
}
