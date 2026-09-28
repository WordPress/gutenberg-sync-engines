/**
 * Transport experience benchmark: edit-to-visible propagation latency and
 * wire traffic per collaborator, measured with two real browser clients.
 *
 *   node tests/benchmarks/transport/benchmark-transport.mjs \
 *       transport=http-polling trials=30 idle=30 json=out.json
 *
 * Two browser windows (same logged-in session — separate sessions trip the
 * same-user post-lock takeover flow) collaborate on a fresh post. Window A
 * inserts unique tokens; both windows record —
 * with in-page `Date.now()` stamps taken inside a `wp.data.subscribe`
 * watcher, so no automation IPC skew — when each token lands in their block
 * store. Latency = B's arrival stamp minus A's local-echo stamp. Trial
 * spacing is jittered so arrivals sample the transport's polling phase
 * rather than locking to it.
 *
 * Alongside latency it counts every `/wp-sync/v1/` request and WebSocket
 * frame per window (body bytes only — HTTP headers are not included), both
 * while editing and over a configurable idle phase. The idle numbers are the
 * per-collaborator carrying cost hosts care about.
 *
 * Arguments are bare `key=value` tokens (same convention as the engine
 * benchmark):
 *
 *   transport=  http-polling | sse | websocket | current
 *               Switched via the Settings → Collaboration screen and
 *               restored afterwards. Default: current (no switch).
 *   cache=      none | redis | current: the persistent object cache the
 *               site runs for the run (redis = the Redis Object Cache
 *               drop-in on the env's Redis; this checkout's wp-env sites
 *               only; restored afterwards). Default: current.
 *   wake=       auto | redis | cache | table: what an SSE stream sleeps
 *               on (auto = whatever the site has, Redis when detectable;
 *               cache needs cache=redis, table needs cache=none). The
 *               report records the wait the streams actually got.
 *   engine=     intent-log | yjs-server | current (default: current)
 *   trials=     measured token round-trips (default 30)
 *   warmup=     unmeasured leading trials (default 3)
 *   idle=       seconds of idle-traffic measurement (default 30, 0 skips)
 *   baseline=   ambient-overhead samples before the trials (default 10,
 *               0 skips): unauthenticated GET /wp/v2/types round-trips
 *               (client-timed, keep-alive) plus the same number of tagged
 *               empty RTC polls (scenario=baseline, approach=baseline) —
 *               the community harness's baseline convention, which its
 *               report normalizes every scenario against
 *   json=       write full results as JSON to this path
 *   headed=1    run with a visible browser (debugging)
 *
 * Every /wp-sync/ request the two windows make is tagged with the
 * community RTC performance harness's headers (X-RTC-Test,
 * X-RTC-Scenario: editing|idle), so a site with this plugin's diagnostics
 * enabled (local/development wp-env, or the
 * GUTENBERG_SYNC_ENGINES_DIAGNOSTICS constant) records per-request
 * server-side metrics — dispatch ms, CPU ms, db_queries, db_time (needs
 * SAVEQUERIES), peak memory, concurrency — which this tool clears before
 * the run and folds into the summary afterwards (`serverSide`). Without
 * the diagnostics module the tags are inert and `serverSide` is null.
 *
 * Requires: a running env with the Gutenberg subtree + this plugin active,
 * and an admin login (WP_USERNAME/WP_PASSWORD, default admin/password).
 * WP_BASE_URL defaults to the wp-env tests site (http://localhost:8889).
 * Collaboration is enabled automatically (writing settings) if it is not
 * already. The websocket transport additionally needs the sync-server
 * daemon running on a host-reachable address — see the README.
 *
 * Caveat: if the target site pins the transport via the
 * WP_COLLABORATION_TRANSPORT constant or env var, the settings screen value
 * is ignored; the benchmark detects the actually-negotiated transport from
 * the observed traffic and warns on a mismatch.
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

import {
	BASE,
	attachCounters,
	canvasOf,
	collectServerSide,
	configureHostCache,
	configureSettings,
	diffCounters,
	dismissWelcomeGuide,
	ensureCollaborationEnabled,
	installScenarioTagging,
	installWatcher,
	kb,
	login,
	makeRestClient,
	observeSseWait,
	observeTransport,
	parseCliOptions,
	percentile,
	restoreHostCache,
	restoreSettings,
	runBaseline,
	waitForSyncTraffic,
} from './lib.mjs';

const opts = parseCliOptions();

const TRANSPORT = String( opts.transport ?? 'current' );
const ENGINE = String( opts.engine ?? 'current' );
const CACHE = String( opts.cache ?? 'current' );
const WAKE = String( opts.wake ?? 'auto' );
const TRIALS = Number( opts.trials ?? 30 );
const WARMUP = Number( opts.warmup ?? 3 );
const IDLE_SECONDS = Number( opts.idle ?? 30 );
const BASELINE_POLLS = Number( opts.baseline ?? 10 );
const JSON_PATH = opts.json ? String( opts.json ) : null;
const HEADED = Boolean( opts.headed );

async function main() {
	if ( ! Number.isFinite( TRIALS ) || TRIALS < 1 ) {
		throw new Error( 'trials must be a positive number' );
	}
	// Site-wide, so before any window opens.
	const hostCache = configureHostCache( { cache: CACHE, wake: WAKE } );
	const browser = await chromium.launch( { headless: ! HEADED } );
	let settings = null;
	let pageA = null;
	let pageBRef = null;
	const consoleErrors = { a: [], b: [] };
	try {
		const contextA = await browser.newContext();

		// Tag all /wp-sync/ traffic with the current phase so the plugin's
		// diagnostics request log (when present) attributes rows to it.
		const phase = { value: 'setup' };
		await installScenarioTagging( contextA, phase );

		pageA = await login( contextA );

		// Settings and collaboration are provisioned through window A's
		// session.
		settings = await configureSettings( pageA, ENGINE, TRANSPORT );
		await ensureCollaborationEnabled( pageA );

		// Second collaborator: a separate window in the same context (in
		// headless Chromium both report document.visibilityState ===
		// 'visible', which the tool asserts below — background-tab cadence
		// would invalidate the results).
		const contextB = contextA;

		const countersA = attachCounters( pageA );
		await countersA.ready;

		// Window A creates a fresh post.
		await pageA.goto( `${ BASE }/wp-admin/post-new.php` );
		await dismissWelcomeGuide( pageA );
		const postId = await pageA
			.waitForFunction( () =>
				window.wp?.data?.select( 'core/editor' )?.getCurrentPostId()
			)
			.then( ( handle ) => handle.jsonValue() );
		await waitForSyncTraffic( pageA, countersA, 'A' );

		// Window B joins BEFORE window A types anything. While a client is
		// solo its update queue is paused; content typed pre-join can be
		// clobbered when the joining peer's session initializes the room.
		// Typing only once both sessions are live avoids that race.
		const pageB = await contextB.newPage();
		pageBRef = pageB;
		if ( opts.recovery ) {
			await pageB.addInitScript( () => {
				const nativeFetch = window.fetch.bind( window );
				const active = new Set();
				let offline = false;
				window.__benchSetSyncOffline = ( value ) => {
					offline = value;
					if ( value ) {
						for ( const controller of active ) {
							controller.abort();
						}
						active.clear();
					}
				};
				window.fetch = ( input, init = {} ) => {
					const url =
						typeof input === 'string'
							? input
							: input.url ?? String( input );
					if (
						! decodeURIComponent( url ).includes( '/wp-sync/v1/' )
					) {
						return nativeFetch( input, init );
					}
					if ( offline ) {
						return Promise.reject(
							new TypeError(
								'Benchmark: sync connection interrupted'
							)
						);
					}
					const controller = new AbortController();
					const abort = () => {
						controller.abort();
						active.delete( controller );
					};
					if ( init.signal?.aborted ) {
						abort();
					} else {
						init.signal?.addEventListener( 'abort', abort, {
							once: true,
						} );
					}
					active.add( controller );
					return nativeFetch( input, {
						...init,
						signal: controller.signal,
					} );
				};
			} );
		}

		const countersB = attachCounters( pageB );
		await countersB.ready;
		for ( const [ key, page ] of [
			[ 'a', pageA ],
			[ 'b', pageB ],
		] ) {
			page.on( 'pageerror', ( error ) =>
				consoleErrors[ key ].push( String( error ) )
			);
			page.on( 'console', ( message ) => {
				if ( 'error' === message.type() ) {
					consoleErrors[ key ].push( message.text() );
				}
			} );
		}
		await pageB.goto(
			`${ BASE }/wp-admin/post.php?post=${ postId }&action=edit`
		);
		await dismissWelcomeGuide( pageB );
		await waitForSyncTraffic( pageB, countersB, 'B' );
		await installWatcher( pageA );
		await installWatcher( pageB );

		// Let awareness register both clients: the update queues resume and
		// the transport switches to its with-collaborators cadence.
		await pageA.waitForTimeout( 3000 );

		// Verify the NEGOTIATED transport before measuring anything: a
		// WP_COLLABORATION_TRANSPORT constant/env override or a failed
		// negotiation must fail the run up front, not caveat it afterwards.
		const negotiated = observeTransport( countersA );
		if ( negotiated !== settings.active.transport ) {
			throw new Error(
				`Requested transport "${ settings.active.transport }" but ` +
					`the session negotiated "${ negotiated }" — check for a ` +
					'WP_COLLABORATION_TRANSPORT constant/env override on ' +
					'the site, or a failed client negotiation.'
			);
		}

		// Window A types the anchor paragraph; window B must receive it
		// through the sync stack — this gates on collaboration working.
		// The canvas may or may not be iframed (theme-dependent).
		const canvasA = await canvasOf( pageA );
		try {
			await canvasA
				.getByRole( 'document', { name: 'Add default block' } )
				.click();
		} catch ( error ) {
			await pageA
				.screenshot( { path: 'bench-fail-a.png' } )
				.catch( () => {} );
			await pageB
				.screenshot( { path: 'bench-fail-b.png' } )
				.catch( () => {} );
			throw new Error(
				'Could not click the block appender in window A ' +
					'(screenshots: bench-fail-a.png / bench-fail-b.png): ' +
					String( error ).split( '\n' )[ 0 ] +
					`\n  A console errors: ${ JSON.stringify(
						consoleErrors.a
					) }` +
					`\n  B console errors: ${ JSON.stringify(
						consoleErrors.b
					) }`
			);
		}
		await pageA.keyboard.type( 'benchanchor' );
		try {
			await pageA.waitForFunction(
				() =>
					(
						window.wp?.data
							?.select( 'core/block-editor' )
							?.getBlocks() ?? []
					).some( ( block ) =>
						String( block.attributes?.content ?? '' ).includes(
							'benchanchor'
						)
					),
				{ timeout: 10000 }
			);
		} catch {
			throw new Error(
				'The anchor paragraph did not survive in window A — its ' +
					'sync session may have been reset. Send-side failure; ' +
					'window B was open but never consulted.'
			);
		}
		try {
			await pageB.waitForFunction(
				() => {
					// RichText content is a RichTextData object; coerce with
					// String() rather than JSON-stringifying the block tree.
					const walk = ( blocks ) =>
						blocks.some(
							( block ) =>
								String(
									block.attributes?.content ?? ''
								).includes( 'benchanchor' ) ||
								( block.innerBlocks?.length &&
									walk( block.innerBlocks ) )
						);
					return walk(
						window.wp?.data
							?.select( 'core/block-editor' )
							?.getBlocks() ?? []
					);
				},
				{ timeout: 60000 }
			);
		} catch {
			const dump = async ( page ) =>
				page
					.evaluate( () =>
						window.wp?.data
							?.select( 'core/block-editor' )
							?.getBlocks()
							?.map( ( block ) =>
								String( block.attributes?.content ?? '' )
							)
					)
					.catch( ( error ) => `unreadable: ${ error }` );
			throw new Error(
				'Window B never received the anchor paragraph (60s). ' +
					'Collaboration is not syncing: check that both plugins ' +
					'are active, collaboration is enabled, and — for the ' +
					'websocket transport — that the sync-server daemon is ' +
					'running and reachable from this browser.\n' +
					`  A url: ${ pageA.url() }\n` +
					`  B url: ${ pageB.url() }\n` +
					`  A blocks: ${ JSON.stringify( await dump( pageA ) ) }\n` +
					`  B blocks: ${ JSON.stringify( await dump( pageB ) ) }\n` +
					`  A console errors: ${ JSON.stringify(
						consoleErrors.a
					) }\n` +
					`  B console errors: ${ JSON.stringify( consoleErrors.b ) }`
			);
		}

		const visibility = {
			a: await pageA.evaluate( () => document.visibilityState ),
			b: await pageB.evaluate( () => document.visibilityState ),
		};
		if ( 'visible' !== visibility.a || 'visible' !== visibility.b ) {
			console.warn(
				`WARNING: a window is not visible (A=${ visibility.a }, ` +
					`B=${ visibility.b }); background-tab cadence would ` +
					'invalidate latency results.'
			);
		}

		console.log(
			`transport benchmark: engine=${ settings.active.engine } ` +
				`transport=${ settings.active.transport } trials=${ TRIALS } ` +
				`warmup=${ WARMUP } post=${ postId }`
		);

		// Server-side log + baseline (community-harness conventions). The
		// REST client rides window A's session; a missing nonce or absent
		// diagnostics module degrades to client-side numbers only.
		const rest = await makeRestClient( pageA );
		if ( rest ) {
			// Isolate this run's server-side rows (404 when the site has no
			// diagnostics module — ignored).
			await rest.del( '/rtc-test/v1/log' );
		}
		let baseline = null;
		if ( BASELINE_POLLS > 0 ) {
			console.log( `baseline: ${ BASELINE_POLLS } ambient samples…` );
			baseline = await runBaseline(
				rest,
				`postType/post:${ postId }`,
				BASELINE_POLLS
			);
			console.log(
				`  GET /wp/v2/types total ms: min ${ baseline.restTotalMs.min } ` +
					`p50 ${ baseline.restTotalMs.p50 } mean ${ baseline.restTotalMs.mean } ` +
					`max ${ baseline.restTotalMs.max }`
			);
		}

		// The anchor paragraph, refocused before every insert: ambient
		// focus does not reliably survive the anchor gate (theme/editor
		// differences), and an unfocused insertText lands nowhere.
		const anchorParagraph = canvasA
			.locator( '[data-type="core/paragraph"]' )
			.last();

		phase.value = 'editing';
		const trialStart = Date.now();
		const startA = countersA.snapshot();
		const startB = countersB.snapshot();
		const latencies = [];
		const trials = [];
		const total = WARMUP + TRIALS;
		for ( let i = 0; i < total; i++ ) {
			const token = `bench${ String( i ).padStart( 3, '0' ) }x`;
			await pageA.evaluate( ( t ) => {
				window.__benchTokens = [ t ];
			}, token );
			await pageB.evaluate( ( t ) => {
				window.__benchTokens = [ t ];
			}, token );
			await anchorParagraph.click();
			await pageA.keyboard.press( 'End' );
			await pageA.keyboard.insertText( ` ${ token }` );
			const sentAt = await pageA
				.waitForFunction(
					( t ) => window.__benchSeen[ t ] ?? false,
					token,
					{
						timeout: 5000,
					}
				)
				.then( ( handle ) => handle.jsonValue() );
			const seenAt = await pageB
				.waitForFunction(
					( t ) => window.__benchSeen[ t ] ?? false,
					token,
					{
						timeout: 30000,
						polling: 100,
					}
				)
				.then( ( handle ) => handle.jsonValue() );
			const latency = seenAt - sentAt;
			const measured = i >= WARMUP;
			if ( measured ) {
				latencies.push( latency );
			}
			trials.push( { token, latency, measured } );
			console.log(
				`  ${ measured ? 'trial' : 'warmup' } ${ String( i ).padStart(
					3,
					'0'
				) }: ${ latency } ms`
			);
			// Jittered spacing (deterministic) samples the polling phase.
			await pageA.waitForTimeout( 400 + ( ( i * 137 ) % 1100 ) );
		}
		const trialMs = Date.now() - trialStart;
		const active = {
			a: diffCounters( startA, countersA.snapshot(), trialMs ),
			b: diffCounters( startB, countersB.snapshot(), trialMs ),
		};

		// Optional interruption gate: the receiver misses an accepted edit,
		// then must recover it through the existing session without a reload.
		let recovery = null;
		if ( opts.recovery ) {
			phase.value = 'recovery';

			await pageB.evaluate( () => {
				window.__benchTokens = [ 'benchrecoveryx' ];
			} );
			try {
				await pageB.evaluate( () =>
					window.__benchSetSyncOffline( true )
				);
				await pageA.waitForTimeout( 1000 );
				const accepted = pageA.waitForResponse(
					( response ) => {
						if (
							response.status() !== 200 ||
							response.request().method() !== 'POST'
						) {
							return false;
						}
						const url = decodeURIComponent( response.url() );
						if ( settings.active.engine === 'de-rtc' ) {
							return (
								url.includes( '/autosaves' ) &&
								response
									.request()
									.postData()
									?.includes( 'benchrecoveryx' )
							);
						}
						if ( ! url.includes( '/wp-sync/v1/updates' ) ) {
							return false;
						}
						const body = response.request().postDataJSON();
						return body?.rooms?.some(
							( room ) => room.updates?.length > 0
						);
					},
					{ timeout: 30000 }
				);
				await anchorParagraph.click();
				await pageA.keyboard.press( 'End' );
				await pageA.keyboard.insertText( ' benchrecoveryx' );
				await accepted;
				await pageA.waitForTimeout( 500 );
				if (
					await pageB.evaluate(
						() => !! window.__benchSeen.benchrecoveryx
					)
				) {
					throw new Error(
						'The interruption did not block delivery; recovery was not tested.'
					);
				}
				const resumed = Date.now();
				await pageB.evaluate( () =>
					window.__benchSetSyncOffline( false )
				);
				await pageB.waitForFunction(
					() => !! window.__benchSeen.benchrecoveryx,
					undefined,
					{ timeout: 30000 }
				);
				recovery = { verified: true, catchUpMs: Date.now() - resumed };
				console.log(
					`recovery: disconnected receiver caught up in ${ recovery.catchUpMs } ms`
				);
			} finally {
				await pageB.evaluate( () =>
					window.__benchSetSyncOffline( false )
				);
			}
		}

		// Idle phase: both windows open and visible, nobody typing. This is
		// the steady-state carrying cost per collaborator.
		let idle = null;
		if ( IDLE_SECONDS > 0 ) {
			console.log( `idle phase: ${ IDLE_SECONDS }s…` );
			phase.value = 'idle';
			const idleStartA = countersA.snapshot();
			const idleStartB = countersB.snapshot();
			const idleStart = Date.now();
			await pageA.waitForTimeout( IDLE_SECONDS * 1000 );
			const idleMs = Date.now() - idleStart;
			idle = {
				a: diffCounters( idleStartA, countersA.snapshot(), idleMs ),
				b: diffCounters( idleStartB, countersB.snapshot(), idleMs ),
				seconds: idleMs / 1000,
			};
		}

		phase.value = 'post';

		// Self-label the transport from the traffic actually observed
		// (verified against the requested transport before trials above).
		const observedTransport = observeTransport( countersA );

		// Per-scenario server-side aggregates (community metric names) from
		// the plugin's diagnostics request log, when the site has one.
		const serverSide = await collectServerSide( rest );

		latencies.sort( ( x, y ) => x - y );
		const mean =
			latencies.reduce( ( sum, value ) => sum + value, 0 ) /
			latencies.length;
		const summary = {
			environment: {
				date: new Date().toISOString(),
				baseUrl: BASE,
				engine: settings.active.engine,
				transportRequested: settings.active.transport,
				transportObserved: observedTransport,
				cache: CACHE,
				wake: WAKE,
				sseWaitObserved: observeSseWait( countersA ),
				trials: TRIALS,
				warmup: WARMUP,
				idleSeconds: IDLE_SECONDS,
				visibility,
			},
			latencyMs: {
				min: latencies[ 0 ],
				p50: percentile( latencies, 50 ),
				p90: percentile( latencies, 90 ),
				max: latencies[ latencies.length - 1 ],
				mean: Math.round( mean * 10 ) / 10,
			},
			baseline,
			activePhase: { durationMs: trialMs, ...active },
			idlePhase: idle,
			serverSide,
			trials,
			recovery,
		};

		console.log( '' );
		console.log( '── edit-to-visible latency (ms) ──' );
		console.log(
			`  min ${ summary.latencyMs.min }   p50 ${ summary.latencyMs.p50 }   ` +
				`p90 ${ summary.latencyMs.p90 }   max ${ summary.latencyMs.max }   ` +
				`mean ${ summary.latencyMs.mean }`
		);
		console.log( '── wire traffic (bodies only, per window) ──' );
		for ( const [ label, phaseCounters ] of [
			[ 'editing', active ],
			...( idle ? [ [ 'idle   ', idle ] ] : [] ),
		] ) {
			for ( const key of [ 'a', 'b' ] ) {
				const t = phaseCounters[ key ];
				const line =
					observedTransport === 'websocket'
						? `${ t.wsFramesSent + t.wsFramesReceived } frames, ` +
						  `${ kb( t.wsBytesSent + t.wsBytesReceived ) } KB ` +
						  `(${ kb( t.wsBytesPerMinute ) } KB/min)`
						: `${ t.requests } requests ` +
						  `(${ t.requestsPerMinute.toFixed( 1 ) }/min), ` +
						  `up ${ kb( t.requestBytes ) } KB, ` +
						  `down ${ kb( t.responseBytes ) } KB ` +
						  `(${ kb(
								t.requestBytesPerMinute +
									t.responseBytesPerMinute
						  ) } KB/min)`;
				console.log(
					`  ${ label }  window ${ key.toUpperCase() }: ${ line }`
				);
			}
		}
		if ( serverSide ) {
			console.log(
				'── server-side per-request metrics (per scenario) ──'
			);
			for ( const [ scenario, agg ] of Object.entries( serverSide ) ) {
				console.log(
					`  ${ scenario }: n=${ agg.n } disp_ms=${ agg.ms_avg } ` +
						`cpu_ms=${ agg.cpu_ms_avg } db_q=${ agg.db_queries_avg } ` +
						`db_t_ms=${ agg.db_time_ms_avg } mem_mb=${ agg.peak_memory_mb_avg } ` +
						`conc=${ agg.max_concurrent }`
				);
			}
		} else {
			console.log(
				'── no server-side metrics (site lacks the diagnostics request log; ' +
					'run against a local/development env or define ' +
					'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS) ──'
			);
		}
		console.log(
			`── observed transport: ${ observedTransport } ` +
				`(engine ${ settings.active.engine }) ──`
		);

		if ( JSON_PATH ) {
			fs.writeFileSync( JSON_PATH, JSON.stringify( summary, null, 2 ) );
			console.log( `json written: ${ JSON_PATH }` );
		}
	} catch ( error ) {
		// Enrich any failure with the captured console errors and
		// screenshots — an editor crash (React error boundary) otherwise
		// surfaces only as an opaque timeout.
		await pageA
			?.screenshot( { path: 'bench-fail-a.png' } )
			.catch( () => {} );
		await pageBRef
			?.screenshot( { path: 'bench-fail-b.png' } )
			.catch( () => {} );
		error.message +=
			`\n  A console errors: ${ JSON.stringify( consoleErrors.a ) }` +
			`\n  B console errors: ${ JSON.stringify( consoleErrors.b ) }` +
			'\n  screenshots: bench-fail-a.png / bench-fail-b.png';
		throw error;
	} finally {
		try {
			restoreHostCache( hostCache );
		} catch ( error ) {
			console.warn( `WARNING: failed to restore the object cache: ${ error }` );
		}
		const changedSettings =
			settings &&
			( settings.previous.engine !== settings.active.engine ||
				settings.previous.transport !== settings.active.transport );
		if ( changedSettings && pageA ) {
			await restoreSettings( pageA, settings.previous ).catch(
				( error ) =>
					console.warn(
						`WARNING: failed to restore settings (engine=` +
							`${ settings.previous.engine }, transport=` +
							`${ settings.previous.transport }): ${ error }`
					)
			);
		}
		await browser.close();
	}
}

main().catch( ( error ) => {
	// Message first: the failure paths append diagnostic context to it
	// after the stack string was captured.
	console.error( String( error?.message ?? error ) );
	if ( error?.stack ) {
		console.error(
			String( error.stack ).split( '\n' ).slice( 1 ).join( '\n' )
		);
	}
	process.exit( 1 );
} );
