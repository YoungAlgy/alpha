export const PROVIDER_ENV_NAMES = [
  "BRAVE_SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "YOU_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export type ProviderEnvName = (typeof PROVIDER_ENV_NAMES)[number];
export type ProviderEnvSnapshot = ReadonlyMap<ProviderEnvName, string | undefined>;

export function snapshotProviderEnv(): Map<ProviderEnvName, string | undefined> {
  return new Map(
    PROVIDER_ENV_NAMES.map((name) => [name, process.env[name]] as const)
  );
}

export function clearProviderEnv(): void {
  for (const name of PROVIDER_ENV_NAMES) delete process.env[name];
}

export function restoreProviderEnv(snapshot: ProviderEnvSnapshot): void {
  for (const name of PROVIDER_ENV_NAMES) {
    const value = snapshot.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
