/**
 * N-window duration soak: the browser-driven multi-client run that
 * validates the hosting cost cards' composed per-user-hour projections
 * against measured end-to-end totals.
 *
 *   node tests/debugging/soak-transport.mjs \
 *       engine=de-rtc transport=http-polling windows=3 soak=3600 \
 *       json=soak-de-rtc.json
 *
 * N browser windows (same logged-in session; window 0 creates the post,
 * the rest join) collaborate for `soak` seconds. Each window owns ONE
 * paragraph and edits only it — staggered typing bursts with think time,
 * the shape of real co-editing without constant same-block conflict.
 * Window 0 saves the post periodically (drafts through the ordinary REST
 * save; under de-rtc the save-through-the-room middleware carries
 * base_version). Every `probe` seconds window 0 inserts a probe token
 * and every other window's in-page watcher stamps its arrival —
 * edit-to-visible latency sampled across the whole soak. Wire counters
 * are sampled per minute per window; the plugin's diagnostics request
 * log (cleared at start) supplies per-request server metrics. The run
 * ends with a convergence check (every window's serialized content must
 * be identical after quiescence) and a per-user-hour report:
 * requests/hour, KB up+down/hour, server dispatch+CPU ms/hour, and DB
 * queries/hour per collaborator — the measured numbers to set against
 * the cost cards' composed engine-seam floors.
 *
 * Arguments (bare key=value, like the other benchmarks):
 *
 *   engine=     intent-log | yjs-server | de-rtc | current
 *   transport=  http-polling | sse | websocket | current
 *   windows=    collaborator windows (default 3, min 2)
 *   soak=       soak duration in seconds (default 3600)
 *   probe=      seconds between latency probes (default 30)
 *   save=       seconds between periodic saves, 0 disables (default 120)
 *   json=       write full results as JSON to this path
 *   headed=1    visible browser (debugging)
 *
 * Requires the same environment as benchmark-transport.mjs. Wall clock
 * is the soak duration plus ~1 minute of setup/teardown — an hour-scale
 * run is deliberate, supervised work, not a CI job.
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

import {
	BASE,
	attachCounters,
	canvasOf,
	collectServerSide,
	configureSettings,
	dismissWelcomeGuide,
	ensureCollaborationEnabled,
	installScenarioTagging,
	installWatcher,
	kb,
	login,
	makeRestClient,
	observeTransport,
	parseCliOptions,
	percentile,
	restoreSettings,
	waitForSyncTraffic,
} from '../benchmarks/transport/lib.mjs';

const opts = parseCliOptions();

const ENGINE = String( opts.engine ?? 'current' );
const TRANSPORT = String( opts.transport ?? 'current' );
const WINDOWS = Math.max( 2, Number( opts.windows ?? 3 ) );
const SOAK_SECONDS = Number( opts.soak ?? 3600 );
const PROBE_SECONDS = Number( opts.probe ?? 30 );
const SAVE_SECONDS = Number( opts.save ?? 120 );
const JSON_PATH = opts.json ? String( opts.json ) : null;
const HEADED = Boolean( opts.headed );
// inspect=1: enable the wire inspector (window.wpSync) in every window and
// export each ring buffer into the JSON output — for diagnosing session
// state-machine stalls the aggregate counters cannot explain.
const INSPECT = Boolean( opts.inspect );

/**
 * Deterministic jitter (no wall-clock randomness: reruns pace the same).
 *
 * @param {number} step Monotonic counter.
 * @param {number} min  Minimum value.
 * @param {number} max  Maximum value.
 * @return {number} Value in [min, max].
 */
const jitter = ( step, min, max ) =>
	min +
	( ( ( step * 2654435761 ) % 4294967296 ) / 4294967296 ) * ( max - min );

/**
 * One window's editing driver: think, burst into its own paragraph,
 * repeat until the deadline. Runs as an independent async loop.
 *
 * @param {Object} win      Window record { page, canvas, index }.
 * @param {number} deadline Epoch ms to stop at.
 * @param {Object} stats    Mutable { tokensTyped, bursts } tally.
 */
async function editingDriver( win, deadline, stats ) {
	let step = win.index * 97 + 1;
	while ( Date.now() < deadline ) {
		const thinkMs = jitter( step++, 5000, 20000 );
		await win.page.waitForTimeout(
			Math.min( thinkMs, Math.max( 0, deadline - Date.now() ) )
		);
		if ( Date.now() >= deadline ) {
			return;
		}
		const burst = Math.round( jitter( step++, 3, 8 ) );
		const paragraph = win.canvas
			.locator( '[data-type="core/paragraph"]', {
				hasText: `soakw${ win.index }anchor`,
			} )
			.first();
		try {
			await paragraph.click( { timeout: 5000 } );
			await win.page.keyboard.press( 'End' );
			for ( let i = 0; i < burst && Date.now() < deadline; i++ ) {
				await win.page.keyboard.insertText(
					` w${ win.index }t${ stats.tokensTyped++ }x`
				);
				await win.page.waitForTimeout( jitter( step++, 300, 700 ) );
			}
			stats.bursts += 1;
		} catch {
			// A transient focus/park overlay hiccup: skip this burst; the
			// next iteration retries. The convergence check at the end is
			// the real gate.
			stats.burstErrors = ( stats.burstErrors ?? 0 ) + 1;
		}
	}
}

/**
 * Serialized post content of a window, for the convergence check.
 *
 * @param {import('@playwright/test').Page} page Editor page.
 * @return {Promise<string>} Serialized content.
 */
const editedContentOf = ( page ) =>
	page.evaluate( () =>
		window.wp.data.select( 'core/editor' ).getEditedPostContent()
	);

async function main() {
	if ( ! Number.isFinite( SOAK_SECONDS ) || SOAK_SECONDS < 30 ) {
		throw new Error( 'soak must be at least 30 seconds' );
	}
	const browser = await chromium.launch( { headless: ! HEADED } );
	let settings = null;
	const wins = [];
	const consoleErrors = {};
	try {
		const context = await browser.newContext();
		const phase = { value: 'setup' };
		await installScenarioTagging( context, phase );

		const adminPage = await login( context );
		settings = await configureSettings( adminPage, ENGINE, TRANSPORT );
		await ensureCollaborationEnabled( adminPage );

		// Window 0 creates the post; the rest join it. All windows share
		// the logged-in session (separate sessions trip the same-user
		// post-lock takeover flow) and all report visibilityState
		// 'visible' under headless Chromium.
		await adminPage.goto( `${ BASE }/wp-admin/post-new.php` );
		await dismissWelcomeGuide( adminPage );
		const postId = await adminPage
			.waitForFunction( () =>
				window.wp?.data?.select( 'core/editor' )?.getCurrentPostId()
			)
			.then( ( handle ) => handle.jsonValue() );

		const attach = async ( page, index ) => {
			consoleErrors[ index ] = [];
			page.on( 'pageerror', ( error ) =>
				consoleErrors[ index ].push( String( error ) )
			);
			page.on( 'console', ( message ) => {
				if ( 'error' === message.type() ) {
					consoleErrors[ index ].push( message.text() );
				}
			} );
			const counters = attachCounters( page );
			return { page, index, counters, canvas: null };
		};

		wins.push( await attach( adminPage, 0 ) );
		await waitForSyncTraffic( adminPage, wins[ 0 ].counters, '0' );

		for ( let i = 1; i < WINDOWS; i++ ) {
			const page = await context.newPage();
			const win = await attach( page, i );
			await page.goto(
				`${ BASE }/wp-admin/post.php?post=${ postId }&action=edit`
			);
			await dismissWelcomeGuide( page );
			await waitForSyncTraffic( page, win.counters, String( i ) );
			wins.push( win );
		}
		for ( const win of wins ) {
			win.canvas = await canvasOf( win.page );
			await installWatcher( win.page );
			if ( INSPECT ) {
				await win.page.evaluate( () => {
					window.wpSync?.enable?.();
				} );
			}
		}
		await adminPage.waitForTimeout( 3000 );

		const negotiated = observeTransport( wins[ 0 ].counters );
		if ( negotiated !== settings.active.transport ) {
			throw new Error(
				`Requested transport "${ settings.active.transport }" but the ` +
					`session negotiated "${ negotiated }".`
			);
		}

		// Window 0 seeds one anchor paragraph per window; every window
		// must receive ALL of them through the sync stack before the soak
		// starts (this is also the collaboration-works gate).
		const canvas0 = wins[ 0 ].canvas;
		await canvas0
			.getByRole( 'document', { name: 'Add default block' } )
			.click();
		for ( let i = 0; i < WINDOWS; i++ ) {
			await wins[ 0 ].page.keyboard.type( `soakw${ i }anchor` );
			if ( i < WINDOWS - 1 ) {
				await wins[ 0 ].page.keyboard.press( 'Enter' );
			}
		}
		for ( const win of wins ) {
			for ( let i = 0; i < WINDOWS; i++ ) {
				await win.page.waitForFunction(
					( anchor ) => {
						const walk = ( blocks ) =>
							blocks.some(
								( block ) =>
									String(
										block.attributes?.content ?? ''
									).includes( anchor ) ||
									( block.innerBlocks?.length &&
										walk( block.innerBlocks ) )
							);
						return walk(
							window.wp?.data
								?.select( 'core/block-editor' )
								?.getBlocks() ?? []
						);
					},
					`soakw${ i }anchor`,
					{ timeout: 60000 }
				);
			}
		}

		const rest = await makeRestClient( adminPage );
		if ( rest ) {
			await rest.del( '/rtc-test/v1/log' );
		}

		console.log(
			`soak: engine=${ settings.active.engine } ` +
				`transport=${ settings.active.transport } windows=${ WINDOWS } ` +
				`soak=${ SOAK_SECONDS }s probe=${ PROBE_SECONDS }s ` +
				`save=${ SAVE_SECONDS }s post=${ postId }`
		);

		phase.value = 'soak';
		const soakStart = Date.now();
		const deadline = soakStart + SOAK_SECONDS * 1000;
		const startSnapshots = wins.map( ( win ) => win.counters.snapshot() );

		// Independent async loops: N editing drivers + probes + saves +
		// the per-minute sampler, all racing the same deadline.
		const editStats = wins.map( () => ( { tokensTyped: 0, bursts: 0 } ) );
		const drivers = wins.map( ( win ) =>
			editingDriver( win, deadline, editStats[ win.index ] )
		);

		const probes = [];
		const probeDriver = ( async () => {
			let probeIndex = 0;
			while ( Date.now() + PROBE_SECONDS * 1000 < deadline ) {
				await wins[ 0 ].page.waitForTimeout( PROBE_SECONDS * 1000 );
				if ( Date.now() >= deadline ) {
					return;
				}
				const token = `probe${ String( probeIndex++ ).padStart(
					3,
					'0'
				) }x`;
				try {
					for ( const win of wins ) {
						await win.page.evaluate( ( t ) => {
							window.__benchTokens = [ t ];
						}, token );
					}
					const paragraph = wins[ 0 ].canvas
						.locator( '[data-type="core/paragraph"]', {
							hasText: 'soakw0anchor',
						} )
						.first();
					await paragraph.click( { timeout: 5000 } );
					await wins[ 0 ].page.keyboard.press( 'End' );
					await wins[ 0 ].page.keyboard.insertText( ` ${ token }` );
					const sentAt = await wins[ 0 ].page
						.waitForFunction(
							( t ) => window.__benchSeen[ t ] ?? false,
							token,
							{ timeout: 5000 }
						)
						.then( ( handle ) => handle.jsonValue() );
					const arrivals = [];
					for ( const win of wins.slice( 1 ) ) {
						const seenAt = await win.page
							.waitForFunction(
								( t ) => window.__benchSeen[ t ] ?? false,
								token,
								{ timeout: 60000, polling: 100 }
							)
							.then( ( handle ) => handle.jsonValue() );
						arrivals.push( seenAt - sentAt );
					}
					probes.push( {
						atMs: Date.now() - soakStart,
						token,
						latenciesMs: arrivals,
					} );
					console.log(
						`  probe ${ token }: ${ arrivals
							.map( ( ms ) => `${ ms }ms` )
							.join( ' ' ) }`
					);
				} catch ( error ) {
					probes.push( {
						atMs: Date.now() - soakStart,
						token,
						error: String( error ).split( '\n' )[ 0 ],
					} );
				}
			}
		} )();

		const saves = [];
		const saveDriver = ( async () => {
			if ( SAVE_SECONDS <= 0 ) {
				return;
			}
			while ( Date.now() + SAVE_SECONDS * 1000 < deadline ) {
				await wins[ 0 ].page.waitForTimeout( SAVE_SECONDS * 1000 );
				if ( Date.now() >= deadline ) {
					return;
				}
				const result = await wins[ 0 ].page
					.evaluate( async () => {
						await window.wp.data
							.dispatch( 'core/editor' )
							.savePost();
						return {
							ok: ! window.wp.data
								.select( 'core/editor' )
								.didPostSaveRequestFail(),
						};
					} )
					.catch( ( error ) => ( {
						ok: false,
						error: String( error ).split( '\n' )[ 0 ],
					} ) );
				saves.push( { atMs: Date.now() - soakStart, ...result } );
				console.log(
					`  save at ${ Math.round(
						( Date.now() - soakStart ) / 1000
					) }s: ${ result.ok ? 'ok' : 'FAILED' }`
				);
			}
		} )();

		const minuteSamples = [];
		const samplerDriver = ( async () => {
			while ( Date.now() + 60000 <= deadline ) {
				await wins[ 0 ].page.waitForTimeout( 60000 );
				minuteSamples.push( {
					atMs: Date.now() - soakStart,
					perWindow: wins.map( ( win ) => win.counters.snapshot() ),
				} );
			}
		} )();

		await Promise.all( [
			...drivers,
			probeDriver,
			saveDriver,
			samplerDriver,
		] );
		const soakMs = Date.now() - soakStart;
		const endSnapshots = wins.map( ( win ) => win.counters.snapshot() );

		// Quiesce, then converge: every window must reach the identical
		// serialized document (retrying across poll cycles up to 90s).
		phase.value = 'converge';
		console.log( 'soak done; waiting for convergence…' );
		let converged = false;
		let convergenceMs = null;
		let contents = [];
		const convergeStart = Date.now();
		while ( Date.now() - convergeStart < 90000 ) {
			await wins[ 0 ].page.waitForTimeout( 3000 );
			contents = await Promise.all(
				wins.map( ( win ) => editedContentOf( win.page ) )
			);
			if ( contents.every( ( content ) => content === contents[ 0 ] ) ) {
				converged = true;
				convergenceMs = Date.now() - convergeStart;
				break;
			}
		}

		phase.value = 'post';
		const serverSide = await collectServerSide( rest );

		// Wire-inspector ring buffers (inspect=1): the per-window decoded
		// poll history, for diagnosing session state-machine stalls.
		let wireLogs = null;
		if ( INSPECT ) {
			wireLogs = {};
			for ( const win of wins ) {
				const dump = await win.page
					.evaluate( () => window.wpSync?.export?.() ?? null )
					.catch( () => null );
				wireLogs[ win.index ] = dump ? JSON.parse( dump ) : null;
			}
		}

		// Per-user-hour composition: mean across windows, scaled to one
		// hour — the units the cost cards project in.
		const hours = soakMs / 3600000;
		const perWindow = wins.map( ( win, index ) => {
			const start = startSnapshots[ index ];
			const end = endSnapshots[ index ];
			const delta = {};
			for ( const key of Object.keys( start ) ) {
				delta[ key ] = end[ key ] - start[ key ];
			}
			return {
				window: index,
				tokensTyped: editStats[ index ].tokensTyped,
				bursts: editStats[ index ].bursts,
				burstErrors: editStats[ index ].burstErrors ?? 0,
				requests: delta.requests,
				requestBytes: delta.requestBytes,
				responseBytes: delta.responseBytes,
				wsBytes: delta.wsBytesSent + delta.wsBytesReceived,
				perHour: {
					requests: Math.round( delta.requests / hours ),
					kbUp: Math.round( delta.requestBytes / 1024 / hours ),
					kbDown: Math.round( delta.responseBytes / 1024 / hours ),
					kbWs: Math.round(
						( delta.wsBytesSent + delta.wsBytesReceived ) /
							1024 /
							hours
					),
				},
			};
		} );
		const meanPerHour = ( key ) =>
			Math.round(
				perWindow.reduce(
					( sum, win ) => sum + win.perHour[ key ],
					0
				) / perWindow.length
			);

		const allLatencies = probes
			.filter( ( probe ) => probe.latenciesMs )
			.flatMap( ( probe ) => probe.latenciesMs )
			.sort( ( a, b ) => a - b );

		// Server totals over the soak scenario, per user-hour.
		const soakServer = serverSide?.soak ?? null;
		const serverPerUserHour = soakServer
			? {
					dispatchMs: Math.round(
						( soakServer.ms_avg * soakServer.n ) / WINDOWS / hours
					),
					cpuMs: Math.round(
						( soakServer.cpu_ms_avg * soakServer.n ) /
							WINDOWS /
							hours
					),
					dbQueries: Math.round(
						( soakServer.db_queries_avg * soakServer.n ) /
							WINDOWS /
							hours
					),
					requests: Math.round( soakServer.n / WINDOWS / hours ),
			  }
			: null;

		const summary = {
			environment: {
				date: new Date().toISOString(),
				baseUrl: BASE,
				engine: settings.active.engine,
				transportRequested: settings.active.transport,
				transportObserved: observeTransport( wins[ 0 ].counters ),
				windows: WINDOWS,
				soakSeconds: Math.round( soakMs / 1000 ),
				probeSeconds: PROBE_SECONDS,
				saveSeconds: SAVE_SECONDS,
				postId,
			},
			convergence: {
				converged,
				convergenceMs,
				contentBytes: contents[ 0 ]?.length ?? null,
			},
			latencyMs: allLatencies.length
				? {
						n: allLatencies.length,
						min: allLatencies[ 0 ],
						p50: percentile( allLatencies, 50 ),
						p90: percentile( allLatencies, 90 ),
						max: allLatencies[ allLatencies.length - 1 ],
				  }
				: null,
			perUserHour: {
				requests: meanPerHour( 'requests' ),
				kbUp: meanPerHour( 'kbUp' ),
				kbDown: meanPerHour( 'kbDown' ),
				kbWs: meanPerHour( 'kbWs' ),
				server: serverPerUserHour,
			},
			perWindow,
			probes,
			saves,
			minuteSamples,
			wireLogs,
			serverSide,
			consoleErrors,
		};

		console.log( '' );
		console.log(
			`── convergence: ${
				converged
					? `CONVERGED in ${ convergenceMs } ms`
					: 'FAILED (windows disagree after 90s)'
			} ──`
		);
		if ( summary.latencyMs ) {
			console.log(
				`── probe latency (ms, n=${ summary.latencyMs.n }): ` +
					`min ${ summary.latencyMs.min } p50 ${ summary.latencyMs.p50 } ` +
					`p90 ${ summary.latencyMs.p90 } max ${ summary.latencyMs.max } ──`
			);
		}
		console.log( '── per user-hour (measured, mean across windows) ──' );
		console.log(
			`  client wire: ${ summary.perUserHour.requests } requests, ` +
				`up ${ summary.perUserHour.kbUp } KB, ` +
				`down ${ summary.perUserHour.kbDown } KB` +
				( summary.perUserHour.kbWs
					? `, ws ${ summary.perUserHour.kbWs } KB`
					: '' )
		);
		if ( serverPerUserHour ) {
			console.log(
				`  server: ${ serverPerUserHour.requests } requests, ` +
					`dispatch ${ serverPerUserHour.dispatchMs } ms, ` +
					`cpu ${ serverPerUserHour.cpuMs } ms, ` +
					`db ${ serverPerUserHour.dbQueries } queries`
			);
		} else {
			console.log(
				'  server: no diagnostics request log on this site — ' +
					'client wire numbers only'
			);
		}
		for ( const win of perWindow ) {
			console.log(
				`  window ${ win.window }: ${ win.tokensTyped } tokens in ` +
					`${ win.bursts } bursts (${ win.burstErrors } skipped), ` +
					`${ win.requests } requests, up ${ kb(
						win.requestBytes
					) } KB, down ${ kb( win.responseBytes ) } KB`
			);
		}
		const failedSaves = saves.filter( ( save ) => ! save.ok ).length;
		if ( SAVE_SECONDS > 0 ) {
			console.log(
				`── saves: ${ saves.length - failedSaves }/${
					saves.length
				} ok ──`
			);
		}

		if ( JSON_PATH ) {
			fs.writeFileSync( JSON_PATH, JSON.stringify( summary, null, 2 ) );
			console.log( `json written: ${ JSON_PATH }` );
		}
		if ( ! converged ) {
			throw new Error(
				'Convergence FAILED: the windows hold different documents ' +
					'after the soak. Dumped lengths: ' +
					contents.map( ( content ) => content.length ).join( ', ' )
			);
		}
	} catch ( error ) {
		for ( const win of wins ) {
			await win.page
				.screenshot( { path: `soak-fail-${ win.index }.png` } )
				.catch( () => {} );
		}
		error.message += `\n  console errors: ${ JSON.stringify(
			consoleErrors
		) }`;
		throw error;
	} finally {
		const changedSettings =
			settings &&
			( settings.previous.engine !== settings.active.engine ||
				settings.previous.transport !== settings.active.transport );
		if ( changedSettings && wins[ 0 ] ) {
			await restoreSettings( wins[ 0 ].page, settings.previous ).catch(
				( restoreError ) =>
					console.warn(
						`WARNING: failed to restore settings: ${ restoreError }`
					)
			);
		}
		await browser.close();
	}
}

main().catch( ( error ) => {
	console.error( String( error?.message ?? error ) );
	if ( error?.stack ) {
		console.error(
			String( error.stack ).split( '\n' ).slice( 1 ).join( '\n' )
		);
	}
	process.exit( 1 );
} );
