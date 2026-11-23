# eslint-config-tariffshield

Shared ESLint configuration for TariffShield workspaces. `apps/api`, `apps/web`, and
`packages/sdk` all use this config so TypeScript lint rules stay consistent across
the monorepo. New workspace packages should do the same.

## Usage

This is an [ESLint shareable config](https://eslint.org/docs/latest/extend/shareable-configs)
in the [flat config](https://eslint.org/docs/latest/use/configure/configuration-files) format
(ESLint 9). It exports a config array, so include it in an `eslint.config.mjs`:

```js
import { defineConfig, globalIgnores } from 'eslint/config';
import tariffshield from 'eslint-config-tariffshield';

export default defineConfig([globalIgnores(['**/dist/']), tariffshield]);
```

The repository root `eslint.config.mjs` does exactly this, and ESLint 9 resolves the config
from the working directory upwards, so `npm run lint --workspace=<your-workspace>` picks it up
with no per-workspace file. A workspace that needs framework rules adds its own
`eslint.config.mjs` and layers them after this config so they can override it — see
`apps/web/eslint.config.mjs`:

```js
import { defineConfig } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tariffshield from 'eslint-config-tariffshield';

export default defineConfig([tariffshield, nextVitals]);
```

Then add a `lint` script to the workspace's `package.json`, matching the existing apps:

```json
{
  "scripts": {
    "lint": "eslint --max-warnings 0 src"
  }
}
```

and run it with `npm run lint --workspace=<your-workspace>`.

## Peer dependencies

The config relies on these peers, pinned once in the root `package.json` devDependencies —
workspaces using it do not need to declare them:

| Package             | Required version |
| ------------------- | ---------------- |
| `eslint`            | `>= 9`           |
| `@eslint/js`        | `>= 9`           |
| `typescript-eslint` | `>= 8`           |

## What's included

- `@eslint/js` `recommended` and `typescript-eslint` `recommended` (parser + plugin).
- Project rule tweaks: `@typescript-eslint/no-explicit-any` and
  `@typescript-eslint/no-non-null-assertion` are off, and `@typescript-eslint/no-unused-vars`
  allows `_`-prefixed arguments, variables, and caught errors.

## Adding a new workspace

1. Nothing to configure if the root `eslint.config.mjs` is enough; otherwise add a workspace
   `eslint.config.mjs` as shown above.
2. Add a `lint` script (see above) and, if you want it enforced in CI, add the workspace
   to the matrix in `.github/workflows/lint.yml`.
