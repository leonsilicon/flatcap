# eslint-plugin-flatcap

Enforce [Flatcap](https://github.com/leonsilicon/flatcap) package architecture with ESLint 9/10, Oxlint, or Vite+. No runtime dependencies and no repository-specific checker script.

```sh
npm install --save-dev eslint-plugin-flatcap
```

Requires Node.js 20.19 or newer. ESLint is an optional peer dependency; Oxlint and Vite+ users do not need to install it.

## ESLint flat config

```js
// eslint.config.js
import flatcap from "eslint-plugin-flatcap";

export default [flatcap.configs.recommended];
```

Use your normal TypeScript parser configuration for `.ts`/`.tsx` files. The plugin does not install or select a parser. Run `eslint .` so the root config participates in workspace validation.

## Vite+

```ts
// vite.config.ts
import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

export default defineConfig({
  lint: {
    ...flatcap.configs.oxlint,
    options: { typeAware: true, typeCheck: true },
  },
});
```

Run `vp check` as usual. All rules execute in Oxlint's JavaScript plugin host. You do not need ESLint, an additional CLI, or a check-flatcap workspace package.

## Oxlint

```json
{
  "jsPlugins": ["eslint-plugin-flatcap"],
  "rules": {
    "flatcap/flat-package-files": "error",
    "flatcap/package-name": "error",
    "flatcap/package-name-matches-path": "error",
    "flatcap/package-manifest": "error",
    "flatcap/no-relative-imports": "error",
    "flatcap/no-encapsulation-violating-imports": "error",
    "flatcap/no-workspace-import-bypass": "error",
    "flatcap/no-undeclared-dependencies": "error",
    "flatcap/no-unresolved-imports": "error",
    "flatcap/no-export-from-private-file": "error",
    "flatcap/private-script-files": "error",
    "flatcap/public-entrypoints": "error"
  }
}
```

JavaScript/TypeScript Oxlint configs can spread `flatcap.configs.oxlint` instead.

## Conventions

By default `packages/org/example/button` must declare `@-/org.example.button`. A leading `+` on a directory marks a detached package and is omitted from its name. Packages use `type: module`, an `imports` object, a public root export, and a README headed with the exact package name. Dependencies on other Flatcap packages use `workspace:` versions.

Code stays beside its manifest. Nested packages, `__tests__/`, `@assets/`, dot folders, and a `+/` public export tree are supported. Tests may use relative imports within their owning package; they still respect dependency declarations and package boundaries. Asset and dot folders skip file/import conventions.

`_` package segments protect a subtree to its parent scope. `__` segments restrict consumption to the parent package. Descendant implementation packages can own their own nested helpers; sibling packages cannot bypass an outer private boundary using a deeper `_` segment. A detached package, including its descendants, cannot consume protected or private packages. Self-imports are allowed.

Import checks cover static imports, re-exports, dynamic string imports (including constant templates), `require`, `require.resolve`, TypeScript import types, and import-equals. They follow `#` aliases, check declared dependencies, prevent filesystem and symlink escapes, and enforce public workspace exports. Imports/exports maps support exact entries, wildcard patterns, nested conditions, fallback arrays, null exclusions, and query suffixes. External npm modules are checked for declaration, not installed-module resolution. Computed module names cannot be statically checked.

Public code exports use `+.ts` (or `+server.ts`) for the root, `+foo.ts` for `/foo`, `+foo__bar.ts` or `+/foo/bar.ts` for `/foo/bar`, with equivalent JS/TS extensions. These files contain only explicit re-exports through `#imports`. npm wrappers under `packages/com/npmjs` may re-export their upstream package with `export *`. An underscore script needs a shebang and executable permission (permission check is skipped on Windows); `_build.ts` also needs a matching `bin._build` entry. Dash-prefixed helpers can export internally but cannot be exposed by public entrypoints.

## Settings

All rules share `settings.flatcap`:

```js
settings: {
  flatcap: {
    rootDir: ".", // optional; normally discovered from the file's workspace ancestors
    packagesDir: "packages", // relative to rootDir
    scope: "@-",
    wrappersDir: "com/npmjs", // relative to packagesDir
    allowSourceDirectory: false, // opt in to framework src/ layouts
  },
}
```

The `allowSourceDirectory` option preserves Haniverse's `src/` exception for flat files, relative imports, and underscore scripts. Package APIs and encapsulation remain checked. Framework adapters outside `packages/` are exempt from layout rules, but imports of Flatcap packages still respect encapsulation, declared dependencies, and public exports.

## Workspace checks and caching

`package-manifest` validates the owning package on every source lint. When a root-level source/config file is linted, it also walks package manifests, including packages with no source files. Include your root `eslint.config.js`/`vite.config.ts` in full checks. A partial lint of one package intentionally cannot validate an unrelated package with no source. Do not enable ESLint's persistent `--cache` for authoritative architecture checks: it does not track changes in dependency manifests or READMEs. Editor checks and repeated uncached runs re-read metadata; the plugin keeps no global "already reported" state.

## Rules

Every rule above is enabled at `error` in `configs.recommended` and `configs.oxlint`. Individual rules can be disabled using standard linter overrides. `flatcapRecommendedRules` exports the severity map; `flatcapPlugin`, `flatcapOxlintPlugin`, and the default export refer to the same plugin.

The rule design originates in ImproveLabs/Haniverse; see NOTICE. This package generalizes those rules for other repositories and adds manifest, public API, dependency, and boundary validation.
