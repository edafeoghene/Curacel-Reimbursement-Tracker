export const THEME_COOKIE = "curacel-theme";

/**
 * User's stored theme preference.
 *   - "light" / "dark" — explicit override; ignore prefers-color-scheme
 *   - "system"        — follow the OS preference
 *
 * The cookie is only set when the user picks an explicit override.
 * Absence of the cookie means "system" — and the inline script in
 * the root layout reads prefers-color-scheme to decide whether to add
 * the `.dark` class to <html>.
 */
export type Theme = "light" | "dark" | "system";

export function parseTheme(raw: string | undefined): Theme {
  if (raw === "light" || raw === "dark") return raw;
  return "system";
}
