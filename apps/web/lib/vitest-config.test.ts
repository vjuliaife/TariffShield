import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import config, { resolveTsconfigAlias, unitTestInclude } from '../vitest.config';
import { formatUsd } from '@/lib/api';
import { HealthScore } from '@/components/HealthScore';
import { BondTimeline } from '@/components/BondTimeline';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(webRoot, file), 'utf8')) as T;
}

describe('Issue #651 — @/ path alias resolution in Vitest', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeTsconfig(compilerOptions: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsconfig-alias-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'tsconfig.json');
    writeFileSync(file, JSON.stringify({ compilerOptions }));
    return file;
  }

  it('resolves a lib module imported via @/lib/...', () => {
    expect(formatUsd('5000')).toBe('$5,000');
  });

  it('resolves components imported via @/components/...', () => {
    expect(typeof HealthScore).toBe('function');
    expect(typeof BondTimeline).toBe('function');
  });

  it('maps "@" to the apps/web root', () => {
    expect(config.resolve?.alias).toEqual({ '@': webRoot });
  });

  it('matches the tsconfig.json paths entry exactly', () => {
    const tsconfig = readJson<{
      compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
    }>('tsconfig.json');
    const target = tsconfig.compilerOptions.paths['@/*'];

    expect(target).toHaveLength(1);
    expect(path.resolve(webRoot, tsconfig.compilerOptions.baseUrl, target[0].replace(/\/\*$/, ''))).toBe(
      resolveTsconfigAlias(),
    );
  });

  it('honours a non-root baseUrl and target directory', () => {
    const file = writeTsconfig({ baseUrl: 'src', paths: { '@/*': ['./app/*'] } });
    expect(resolveTsconfigAlias(file)).toBe(path.join(path.dirname(file), 'src', 'app'));
  });

  it('throws when tsconfig.json has no @/* paths entry', () => {
    const file = writeTsconfig({ baseUrl: '.' });
    expect(() => resolveTsconfigAlias(file)).toThrow(/paths\["@\/\*"\]/);
  });

  it('throws when @/* has more than one target', () => {
    const file = writeTsconfig({ paths: { '@/*': ['./*', './src/*'] } });
    expect(() => resolveTsconfigAlias(file)).toThrow(/exactly one/);
  });

  it('throws when the @/* target is not a wildcard directory', () => {
    const file = writeTsconfig({ paths: { '@/*': ['./lib'] } });
    expect(() => resolveTsconfigAlias(file)).toThrow(/exactly one/);
  });
});

describe('Issue #650 — unit and e2e suites stay separate', () => {
  it('scopes Playwright to the e2e/ directory', () => {
    const playwrightConfig = readFileSync(path.join(webRoot, 'playwright.config.ts'), 'utf8');
    expect(playwrightConfig).toMatch(/testDir:\s*['"]\.\/e2e['"]/);
  });

  it('scopes Vitest to component and lib sources and excludes e2e/', () => {
    expect(unitTestInclude).toEqual(['components/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}']);
    expect(unitTestInclude.some((glob) => glob.startsWith('e2e'))).toBe(false);
    expect(config.test?.exclude).toContain('e2e/**');
  });

  it('exposes distinct unit and e2e scripts', () => {
    const { scripts } = readJson<{ scripts: Record<string, string> }>('package.json');
    expect(scripts.test).toBe('vitest run');
    expect(scripts['test:e2e']).toBe('playwright test');
  });
});

describe('Issue #649 — unit test scripts and coverage thresholds', () => {
  it('adds test, test:watch and test:coverage scripts', () => {
    const { scripts } = readJson<{ scripts: Record<string, string> }>('package.json');
    expect(scripts['test:watch']).toBe('vitest');
    expect(scripts['test:coverage']).toBe('vitest run --coverage');
  });

  it('uses the v8 provider with text and html reporters', () => {
    const coverage = config.test?.coverage as unknown as { provider: string; reporter: string[] };
    expect(coverage.provider).toBe('v8');
    expect(coverage.reporter).toEqual(expect.arrayContaining(['text', 'html']));
  });

  it('sets a threshold for lines, functions, branches and statements', () => {
    const { thresholds } = config.test?.coverage as unknown as { thresholds: Record<string, number> };
    for (const key of ['lines', 'functions', 'branches', 'statements']) {
      expect(thresholds[key]).toBeGreaterThan(0);
    }
  });
});
