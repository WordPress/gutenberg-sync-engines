/**
 * Collaborator colors.
 *
 * Copied from the editor package's collab-sidebar utils
 * (`getAvatarBorderColor`), which is not exported publicly. Keep in sync so
 * the block outline matches the avatar the header shows for the same person.
 */
const AVATAR_BORDER_COLORS = [
	'#6F42C1',
	'#D94145',
	'#FBBF24',
	'#FF35EE',
	'#879F11',
	'#0F766E',
	'#00CFFF',
];

/**
 * The color for a peer. Keyed by WordPress user id so every session of the
 * same person shares a color; anonymous sessions fall back to the transport
 * client id so they stay distinct from one another.
 *
 * @param userId   WordPress user id, or null.
 * @param clientId Transport client id (fallback key).
 * @return A hex color.
 */
export function getPeerColor(
	userId: number | null,
	clientId: number
): string {
	const key = userId ?? clientId;
	return AVATAR_BORDER_COLORS[
		Math.abs( key ) % AVATAR_BORDER_COLORS.length
	];
}
