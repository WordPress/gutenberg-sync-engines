/**
 * The slice of `@wordpress/block-editor` this plugin uses. The package
 * ships no usable type declarations in the pinned subtree, so the exports
 * the review UI reads are declared here; at runtime they come from the
 * wp-block-editor script.
 */
declare module '@wordpress/block-editor' {
	import type { ReduxStoreConfig, StoreDescriptor } from '@wordpress/data';

	interface BlockEditorSelectors {
		getBlockOrder: ( state: unknown, rootClientId?: string ) => string[];
		getClientIdsWithDescendants: ( state: unknown ) => string[];
		getBlockAttributes: (
			state: unknown,
			clientId: string
		) =>
			| ( Record< string, unknown > & {
					metadata?: { syncId?: unknown };
			  } )
			| null;
	}

	interface BlockEditorActions {
		selectBlock: ( clientId: string, initialPosition?: number ) => void;
		flashBlock: ( clientId: string, duration?: number ) => void;
	}

	export const store: StoreDescriptor<
		ReduxStoreConfig< unknown, BlockEditorActions, BlockEditorSelectors >
	>;
	export const privateApis: Record< string, unknown >;
}
