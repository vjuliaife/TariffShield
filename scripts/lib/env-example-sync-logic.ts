/**
 * Pure helpers behind scripts/check-env-example-sync.ts. apps/api/.env.example
 * is the single source of truth (it is backed by the Zod schema in
 * apps/api/src/config/env.ts); the root .env.example is a generated copy of it.
 */

/**
 * Returns every variable name declared in an .env.example, including optional
 * ones that are shipped commented out (e.g. `# SAML_SP_ENTITY_ID=`). Prose
 * comments are ignored because a variable declaration has no spaces before `=`.
 */
export function extractEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

export interface EnvKeyDiff {
  /** Keys in the source of truth that the root copy is missing. */
  missing: string[];
  /** Keys in the root copy that the source of truth does not define. */
  extra: string[];
}

export function diffEnvKeys(sourceContent: string, rootContent: string): EnvKeyDiff {
  const source = extractEnvKeys(sourceContent);
  const root = extractEnvKeys(rootContent);
  return {
    missing: [...source].filter((k) => !root.has(k)).sort(),
    extra: [...root].filter((k) => !source.has(k)).sort(),
  };
}
