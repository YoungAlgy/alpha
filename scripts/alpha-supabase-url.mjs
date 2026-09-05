// Shared guard for scripts that use Alpha's Supabase service-role key.
// Keep this module pure so it can be exercised without loading env files or
// contacting Supabase.

export const ALPHA_SUPABASE_HOST = "xpqxhdciaoicsnyyfshy.supabase.co";

export function isExactAlphaSupabaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = new URL(value.trim());
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === ALPHA_SUPABASE_HOST &&
      parsed.port === "" &&
      (parsed.pathname === "/" || parsed.pathname === "") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function requireExactAlphaSupabaseUrl(value, label = "SUPABASE_URL") {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!isExactAlphaSupabaseUrl(raw)) {
    throw new Error(
      `${label} must be the dedicated Alpha Supabase HTTPS host (value withheld)`
    );
  }
  return new URL(raw);
}
