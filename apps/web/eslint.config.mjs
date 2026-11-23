import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tariffshield from 'eslint-config-tariffshield';

export default defineConfig([
  globalIgnores(['playwright-report/']),
  tariffshield,
  nextVitals,
  {
    name: 'tariffshield/web/react-compiler',
    // React Compiler diagnostics added to react-hooks/recommended in eslint-plugin-react-hooks v7
    // (eslint-config-next 16). The app does not enable the compiler; rules-of-hooks and
    // exhaustive-deps stay enforced.
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
]);
