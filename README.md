# Flatcap Monorepo Convention

> Name is a combination of:
> - **flat**: as in packages should have a flat structure (no directories)
> - en**cap**sulation: from the encapsulation concept in OOP where classes can define `protected`/`internal` and `private` variables

Rules for a flatcap monorepo:

- Package names should be in reverse DNS format, and may contain a scope (e.g. `@leonsilicon/com.leonsilicon.myapp.component.ui.button`). The name of the package (after the scope, if present) should reflect its location in the filesystem, where each path segment maps to a folder name.
- To define an internal package, use a path segment that starts with `_`
  - Internal packages may only be imported by packages that start with the same prefix (e.g. `@leonsilicon/com.leonsilicon.myapp._context` may be imported by any package that starts with `@leonsilicon/com.leonsilicon.myapp.`)
- To define a private package, use a path segment that starts with `__`
  - Private packages may only be imported by the parent package (e.g. `@leonsilicon/com.leonsilicon.myapp.component.keyboard.__components.key` may ONLY be imported by `@leonsilicon/com.leonsilicon.myapp.component.keyboard`)
- Packages must be flat. All of a package's code files should be next to the package's `package.json` file.
  - For certain files (such as assets), you can use a folder prefixed with an at sign (e.g. `@assets`) to mark a directory as belonging to the package.
  - Files that are exported from the package must start with a `+`, and must match the exported path in the package.json `"exports"` property. `+.ts` should be used for the root (`"."`) path.
  - For nested path exports, you must use folders that start with `+` for each path segment and where slashes are replaced with double underscores (e.g. `import pkg from "@leonsilicon/com.leonsilicon.myapp.lib.db/sqlite-core/migrator"` -> `com/leonsilicon/myapp/lib/db/+sqlite-core__migrator.ts`. These `+` prefixed files should ONLY contain re-exports.
  - "Internal" subpaths (e.g. exposing an internal function for testing purposes) can use a `+_` prefix, e.g. `+_core.ts` and imported via `my-pkg/_core`
- Relative imports are banned. A package should prefer using `package.json` subpath imports. The convention is to omit the extension for source code files (i.e. JavaScript/TypeScript files), and keep the extension for non-JS files (this is so it's clear when import attributes are needed for importing file extensions like `.json` ).
- The convention for files that are script entrypoints (defined in the package.json `"bin"` property) is to use a single underscore and a unique name (e.g. `_build-ios.ts`) so they can be run with `vpx/bunx/npx _build-ios`. "Internal" scripts that shouldn't be accessible repo-wide (i.e. shouldn't have a bin entry) should use a double underscore prefix (e.g. `__postinstall.ts`).
- The convention for files that should be emphasized as "private" or build-only is to use a dash as the prefix (e.g. `-utils.ts`).

Example structure:

```
<scope>/
  com/leonsilicon/myapp
    components/
      keyboard/
        __components/
          key/
            +.ts
            key.tsx
            package.json
        _context/
          +.ts
          +use.ts
          context.tsx
          package.json
          _build.ts
          -build-utils.ts
          __postinstall.ts
        package.json
        index.ts
        keyboard.tsx
  com/npmjs
    npm-wrapper-package/
      package.json
      +.ts
    scoped__npm-wrapper-package/
      package.json
      +.ts
      +nested.ts
      +double__nested.ts
```

`<scope>` should be equal to the `@scope` you use for your flatcap packages. In this example, it would be `leonsilicon`.
