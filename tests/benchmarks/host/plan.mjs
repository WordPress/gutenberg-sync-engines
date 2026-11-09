/**
 * Sweep plans: which setups a sweep measures, and in what order.
 *
 * A plan file (tests/benchmarks/host/plans/*.json) names a CENTER setup
 * and a list of VARY groups. Each group changes one or more variables
 * away from the center; every combination of a group's values is one
 * setup. Setups that come out identical (the center usually appears in
 * several groups) are measured once. So
 *
 *   "center": { "engine": "intent-log", "windows": 2, "postSize": "medium" },
 *   "vary": [
 *     { "engine": [ "intent-log", "de-rtc" ], "windows": [ 1, 2, 3 ] },
 *     { "engine": [ "intent-log", "de-rtc" ], "postSize": [ "empty", "large" ] }
 *   ]
 *
 * is 6 + 4 = 10 setups, each with every other variable at its center
 * value. Changing a few variables at a time around one center gives the
 * curves people draw ("cost as people are added, one line per engine")
 * at a fraction of the cost of every combination of every value.
 *
 * Every setup runs `repeat` times. The order of all runs is shuffled
 * with a fixed seed, so slow drift on the machine (a warming disk
 * cache, a growing database) does not line up with one variable, and
 * the same plan always runs in the same order.
 */

import { POST_SIZES, PATTERNS } from './content.mjs';
import { canonical, seededRandom, shortHash } from './record.mjs';

/**
 * Plan variables: the host benchmark argument each one becomes, its
 * default, and what values it accepts.
 */
export const VARIABLES = {
	engine: {
		arg: 'engine',
		check: ( v ) => [ 'intent-log', 'yjs-server', 'de-rtc' ].includes( v ),
	},
	transport: {
		arg: 'transport',
		default: 'http-polling',
		check: ( v ) => [ 'http-polling', 'sse', 'websocket' ].includes( v ),
	},
	cache: {
		arg: 'cache',
		default: 'none',
		check: ( v ) => [ 'none', 'redis' ].includes( v ),
	},
	wake: {
		arg: 'wake',
		default: 'auto',
		check: ( v ) => [ 'auto', 'redis', 'cache', 'table' ].includes( v ),
	},
	windows: {
		arg: 'peers',
		default: 2,
		check: ( v ) => Number.isInteger( v ) && v >= 1 && v <= 5,
	},
	postSize: {
		arg: 'post-size',
		default: 'medium',
		check: ( v ) => POST_SIZES.includes( v ),
	},
	pattern: {
		arg: 'pattern',
		default: 'own-paragraph',
		check: ( v ) => PATTERNS.includes( v ),
	},
	editSeconds: {
		arg: 'edit-seconds',
		default: 60,
		check: ( v ) => Number.isFinite( v ) && v >= 30,
	},
	idleSeconds: {
		arg: 'idle-seconds',
		default: 60,
		check: ( v ) => Number.isFinite( v ) && v >= 0,
	},
	// Absent = leave the site's setting alone (it is recorded either way).
	pollingInterval: {
		arg: 'polling-interval',
		check: ( v ) => Number.isFinite( v ) && v >= 0 && v <= 25,
	},
};

// `windows` is the number of people (the host benchmark's peers=). It
// stops at 5: the advisory channel's peer limit.

/**
 * Validates a plan and expands it into its unique setups.
 *
 * @param {Object} plan Parsed plan file.
 * @return {Array<{ cell: string, setup: Object }>} Setups, in plan order.
 */
export function expandPlan( plan ) {
	if ( ! plan || 'object' !== typeof plan.center ) {
		throw new Error( 'a plan needs a "center" object' );
	}
	// Unknown names are refused here; validateSetup only sees known ones.
	validateSetup(
		Object.fromEntries(
			Object.entries( plan.center ).filter(
				( [ name ] ) => ! VARIABLES[ name ]
			)
		)
	);
	const center = {};
	for ( const [ name, variable ] of Object.entries( VARIABLES ) ) {
		const value = plan.center[ name ] ?? variable.default;
		if ( undefined !== value ) {
			center[ name ] = value;
		}
	}
	if ( undefined === center.engine ) {
		throw new Error( 'the plan center must name an engine' );
	}
	const groups = plan.vary?.length ? plan.vary : [ {} ];
	const seen = new Set();
	const setups = [];
	for ( const group of groups ) {
		const names = Object.keys( group );
		let combinations = [ {} ];
		for ( const name of names ) {
			if ( ! Array.isArray( group[ name ] ) || ! group[ name ].length ) {
				throw new Error(
					`vary: "${ name }" must be a non-empty list of values`
				);
			}
			combinations = combinations.flatMap( ( partial ) =>
				group[ name ].map( ( value ) => ( {
					...partial,
					[ name ]: value,
				} ) )
			);
		}
		for ( const combination of combinations ) {
			const setup = { ...center, ...combination };
			validateSetup( setup );
			const key = canonical( setup );
			if ( ! seen.has( key ) ) {
				seen.add( key );
				setups.push( { cell: shortHash( setup ), setup } );
			}
		}
	}
	return setups;
}

/**
 * Throws on an unknown variable or a value it does not accept, so a
 * typo fails before hours of measuring rather than after.
 *
 * @param {Object} setup Setup.
 */
export function validateSetup( setup ) {
	for ( const [ name, value ] of Object.entries( setup ) ) {
		const variable = VARIABLES[ name ];
		if ( ! variable ) {
			throw new Error(
				`unknown plan variable "${ name }" (known: ${ Object.keys(
					VARIABLES
				).join( ', ' ) })`
			);
		}
		if ( ! variable.check( value ) ) {
			throw new Error(
				`plan variable ${ name } cannot be ${ JSON.stringify( value ) }`
			);
		}
	}
	if ( 'cache' === setup.wake && 'redis' !== setup.cache ) {
		throw new Error( 'wake "cache" needs cache "redis"' );
	}
	if ( 'table' === setup.wake && 'none' !== setup.cache ) {
		throw new Error( 'wake "table" needs cache "none"' );
	}
}

/**
 * Every run of a plan (setups × repeats), shuffled with a fixed seed.
 *
 * @param {Object} plan Parsed plan file.
 * @return {Array<{ cell: string, setup: Object, repeat: number }>} Runs.
 */
export function planRuns( plan ) {
	const repeat = plan.repeat ?? 1;
	if ( ! Number.isInteger( repeat ) || repeat < 1 ) {
		throw new Error( '"repeat" must be a positive integer' );
	}
	const runs = expandPlan( plan ).flatMap( ( entry ) =>
		Array.from( { length: repeat }, ( _, index ) => ( {
			...entry,
			repeat: index + 1,
		} ) )
	);
	// Fisher–Yates with a seeded generator.
	const random = seededRandom( plan.seed ?? 1 );
	for ( let i = runs.length - 1; i > 0; i-- ) {
		const j = Math.floor( random() * ( i + 1 ) );
		[ runs[ i ], runs[ j ] ] = [ runs[ j ], runs[ i ] ];
	}
	return runs;
}

/**
 * The host benchmark arguments for one setup.
 *
 * @param {Object} setup Setup.
 * @return {Array<string>} key=value arguments.
 */
export function setupArgs( setup ) {
	return Object.entries( setup ).map(
		( [ name, value ] ) => `${ VARIABLES[ name ].arg }=${ value }`
	);
}

/**
 * A short readable name for a setup, for progress lines and file names.
 *
 * @param {Object} setup Setup.
 * @return {string} Label.
 */
export function setupLabel( setup ) {
	return [
		setup.engine,
		setup.transport,
		`w${ setup.windows }`,
		setup.postSize,
		setup.pattern,
		`${ setup.editSeconds }s`,
		setup.cache,
	].join( ' ' );
}
