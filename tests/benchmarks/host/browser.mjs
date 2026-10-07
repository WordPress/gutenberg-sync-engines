// Install the public filter immediately after wp-hooks loads, before the
// editor creates its sync manager. A timer in addInitScript can arrive late.
export async function allowPeers( context, peers ) {
	await context.route(
		/\/(?:hooks|hooks\/index)(?:\.min)?\.js(?:\?|$)/,
		async ( route ) => {
			const response = await route.fetch();
			await route.fulfill( {
				response,
				body:
					( await response.text() ) +
					`\n;window.wp.hooks.addFilter(
				'sync.pollingProvider.maxClientsPerRoom', 'host-benchmark',
				function () { return ${ peers }; }, 1000
			); window.__hostBenchmarkLimit = ${ peers };`,
			} );
		}
	);
}

// All pages use the same machine clock. Arrival means present in the editor
// block store, not painted on screen. Send time is the browser beforeinput event.
export async function installMeasurements( page ) {
	await page.evaluate( () => {
		window.__hostBench = { seen: {}, sent: {} };
		window.wp.data.subscribe( () => {
			const blocks = window.wp.data
				.select( 'core/block-editor' )
				.getBlocks();
			for ( const block of blocks ) {
				const tokens =
					String( block.attributes.content ?? '' ).match(
						/\bw\d+t\d+x\b/g
					) ?? [];
				for ( const token of tokens ) {
					window.__hostBench.seen[ token ] ??= Date.now();
				}
			}
		} );
	} );
}

export async function readEditors( pages ) {
	return Promise.all(
		pages.map( ( page ) =>
			page.evaluate( () => {
				const state = window.wpSync?.advisory?.();
				return {
					...window.__hostBench,
					advisory: state
						? {
								channel: state.channel,
								active: state.active,
								overCap: state.overCap ?? false,
						  }
						: null,
					content: window.wp.data
						.select( 'core/editor' )
						.getEditedPostContent(),
				};
			} )
		)
	);
}
