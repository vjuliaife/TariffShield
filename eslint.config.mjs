import { defineConfig, globalIgnores } from 'eslint/config';
import tariffshield from 'eslint-config-tariffshield';

export default defineConfig([
  globalIgnores(['**/dist/', '**/.next/', '**/playwright-report/']),
  tariffshield,
]);
