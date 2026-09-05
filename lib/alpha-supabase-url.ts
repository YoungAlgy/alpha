export const ALPHA_SUPABASE_HOST = "xpqxhdciaoicsnyyfshy.supabase.co";

export function exactAlphaSupabaseOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Alpha Supabase URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ALPHA_SUPABASE_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Alpha Supabase URL does not match the dedicated project");
  }
  return `https://${ALPHA_SUPABASE_HOST}`;
}

export function isExactAlphaSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    exactAlphaSupabaseOrigin(value);
    return true;
  } catch {
    return false;
  }
}
