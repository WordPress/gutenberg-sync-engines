/**
 * The conflict review cards, as the collaboration specs drive them: find
 * the window a card appeared in, open a card's review dialog, and accept
 * every card's merged result.
 */

/**
 * External dependencies
 */
import type { FrameLocator, Locator, Page } from '@playwright/test';

/**
 * Internal dependencies
 */
import { expect } from './collaboration-fixtures';

/** The text of a conflict card in the canvas. */
export const CONFLICT_CARD = /has conflicting edits/;

interface EditorWindow {
	page: Page;
	editor: { canvas: FrameLocator };
}

/**
 * Waits until a conflict card shows in one of the windows, and returns
 * that window. Which window the engine sets an edit aside in is not
 * fixed, so a spec asks rather than assumes.
 *
 * @param windows The windows, in order of preference.
 */
export async function findConflictCard< T extends EditorWindow >(
	windows: T[]
): Promise< T > {
	let found = windows[ 0 ];
	await expect( async () => {
		const counts = await Promise.all(
			windows.map( ( { editor } ) =>
				editor.canvas.getByText( CONFLICT_CARD ).count()
			)
		);
		const index = counts.findIndex( ( count ) => count > 0 );
		expect( index ).toBeGreaterThanOrEqual( 0 );
		found = windows[ index ];
	} ).toPass( { timeout: 20000 } );

	return found;
}

/**
 * Opens the review dialog of the first conflict card in a window and
 * returns the dialog once it is visible.
 *
 * @param page   The window.
 * @param canvas The window's editor canvas.
 */
export async function openConflictDialog(
	page: Page,
	canvas: FrameLocator
): Promise< Locator > {
	await canvas
		.getByRole( 'button', { name: 'Review conflict', exact: true } )
		.first()
		.click();
	const dialog = page.getByRole( 'dialog', {
		name: 'Review conflicting edits',
	} );
	await expect( dialog ).toBeVisible( { timeout: 10000 } );

	return dialog;
}

/**
 * Decides every conflict card in one editor window: opens each card's
 * review dialog and accepts its merged result, which starts as the
 * current version, so accepting keeps the document as it is and closes
 * the record for every collaborator. Returns how many were decided.
 *
 * @param page   The window.
 * @param canvas The window's editor canvas.
 */
export async function decideConflictCards(
	page: Page,
	canvas: FrameLocator
): Promise< number > {
	let decided = 0;
	for ( let i = 0; i < 40; i++ ) {
		const review = canvas
			.getByRole( 'button', { name: 'Review conflict', exact: true } )
			.first();
		if ( ( await review.count() ) === 0 ) {
			break;
		}
		const dialog = await openConflictDialog( page, canvas );
		await expect(
			dialog.getByText( 'Merged result', { exact: true } )
		).toBeVisible();
		await dialog
			.getByRole( 'button', { name: 'Accept', exact: true } )
			.click();
		await expect( dialog ).toBeHidden( { timeout: 10000 } );
		decided++;
	}
	return decided;
}
