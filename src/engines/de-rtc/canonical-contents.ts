/**
 * The canonical content a session has received, by version, exactly as
 * the server sent it. The document itself is not that record: it can
 * hold local text the server has not accepted, or has set aside.
 *
 * Two readers need the server's own text. The session builds a
 * proposal's descriptor from the content of its declared base version.
 * The review lane shows the newest version held as a record's `current`
 * side, because that is the content an accepted result replaces.
 *
 * Bounded: an old version can never become a proposal base again.
 */
export interface DeRtcCanonicalContents {
	record: ( version: string, content: string ) => void;
	get: ( version: string ) => string | undefined;
	/** The newest version held, or null when none is. */
	latest: () => { version: string; content: string } | null;
	/** Forgets every version (a room restart). */
	clear: () => void;
	/** Returns an unsubscribe function. */
	onChange: ( listener: () => void ) => () => void;
}

/** How many versions are kept. */
const MAX_VERSIONS = 8;

// Version labels are the server's monotonic 'v<seq>' scheme.
const seqOf = ( version: string ): number =>
	parseInt( version.replace( /^v/, '' ), 10 ) || 0;

/**
 * Creates the per-entity record of canonical content.
 *
 * @return The record.
 */
export function createDeRtcCanonicalContents(): DeRtcCanonicalContents {
	const contents = new Map< string, string >();
	const listeners = new Set< () => void >();

	const notify = () => {
		listeners.forEach( ( listener ) => listener() );
	};

	return {
		record( version, content ) {
			contents.set( version, content );
			while ( contents.size > MAX_VERSIONS ) {
				const oldest = contents.keys().next().value as string;
				contents.delete( oldest );
			}
			notify();
		},

		get: ( version ) => contents.get( version ),

		latest() {
			let newest: { version: string; content: string } | null = null;
			// Rows can arrive out of order (a replayed genesis), so the
			// newest version is not always the last one recorded.
			for ( const [ version, content ] of contents ) {
				if ( ! newest || seqOf( version ) >= seqOf( newest.version ) ) {
					newest = { version, content };
				}
			}
			return newest;
		},

		clear() {
			if ( 0 === contents.size ) {
				return;
			}
			contents.clear();
			notify();
		},

		onChange( listener ) {
			listeners.add( listener );
			return () => listeners.delete( listener );
		},
	};
}
