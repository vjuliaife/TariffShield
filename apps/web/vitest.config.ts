import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

type TsconfigWithPaths = {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
};

/**
 * Resolves the directory that `@/*` points at in tsconfig.json.
 *
 * Vitest resolves imports independently of the TypeScript compiler and the
 * Next.js bundler, so the `@` alias is derived from tsconfig.json instead of
 * being duplicated by hand. This keeps the two configs from drifting (#651).
 */
export function resolveTsconfigAlias(tsconfigPath = path.join(webRoot, 'tsconfig.json')): string {
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as TsconfigWithPaths;
  const { baseUrl = '.', paths = {} } = tsconfig.compilerOptions ?? {};
  const targets = paths['@/*'];

  if (!targets || targets.length !== 1 || !targets[0].endsWith('/*')) {
    throw new Error(
      `${tsconfigPath}: expected compilerOptions.paths["@/*"] to contain exactly one "<dir>/*" target`,
    );
  }

  return path.resolve(path.dirname(tsconfigPath), baseUrl, targets[0].slice(0, -2));
}

/** Source directories covered by the Vitest unit suite. Playwright owns e2e/ (#650). */
export const unitTestInclude = ['components/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'];

export default defineConfig({
  resolve: {
    alias: {
      '@': resolveTsconfigAlias(),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: unitTestInclude,
    exclude: [...configDefaults.exclude, 'e2e/**', '.next/**', 'playwright-report/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}'],
      // Initial baseline for a brand-new suite. Raise these as coverage grows (#649).
      thresholds: {
        lines: 5,
        statements: 5,
        functions: 3,
        branches: 5,
      },
    },
  },
});
