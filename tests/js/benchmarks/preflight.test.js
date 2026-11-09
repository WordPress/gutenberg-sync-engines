/** @jest-environment node */
/* eslint jsdoc/check-tag-names: ["error", {"definedTags": ["jest-environment"]}] */
import { checkMeasurementSupport } from '../../benchmarks/host/preflight.mjs';

it( 'accepts a supported clock probe', async () => {
	await expect(
		checkMeasurementSupport( 'http://site', async () => ( {
			ok: true,
			json: async () => ( {
				timeline_version: 1,
				at_ms: 123,
				clock_id: 'server',
			} ),
		} ) )
	).resolves.toBeUndefined();
} );

it.each( [
	null,
	{},
	{ timeline_version: 0 },
	{ timeline_version: 1, at_ms: 123, clock_id: '' },
] )( 'rejects missing or obsolete measurement support: %s', async ( data ) => {
	await expect(
		checkMeasurementSupport( 'http://site', async () => ( {
			ok: true,
			json: async () => data,
		} ) )
	).rejects.toThrow( 'before any site changes' );
} );

it( 'explains an HTML response without printing its contents', async () => {
	await expect(
		checkMeasurementSupport( 'http://site', async () => ( {
			ok: true,
			json: async () => {
				throw new Error( 'private response' );
			},
		} ) )
	).rejects.toThrow( 'Check the target URL and WP_BASE_URL' );
} );
