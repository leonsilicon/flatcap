# Flatcap Monorepo Convention

> Name is a combination of:
> - **flat**: as in packages should have a flat structure (no directories)
> - en**cap**sulation: from the encapsulation concept in OOP where classes can define `protected`/`internal` and `private` variables

Rules for a flatcap monorepo:

- Package names should be in reverse DNS format, and may contain a scope (e.g. `@leonsilicon/com.leonsilicon.myapp.component.ui.button`). The name of the package (after the scope, if present) should reflect its location in the filesystem, where each path segment maps to a folder name.
- To define an internal package, use a path segment that starts with `-`
  - Internal packages may only be imported by packages that start with the same prefix (e.g. `@leonsilicon/com.leonsilicon.myapp.-context` may be imported by any package that starts with `@leonsilicon/com.leonsilicon.myapp.`)
- To define a private package, use a path segment that starts with `--`
  - Private packages may only be imported by the parent package (e.g. `@leonsilicon/com.leonsilicon.myapp.component.keyboard.--components.key` may ONLY be imported by `@leonsilicon/com.leonsilicon.myapp.component.keyboard`)
- Packages must be flat. All of a package's code files should be next to the package's `package.json` file.
  - For certain files (such as assets), you can use a folder prefixed with an underscore (e.g. `_assets`) to mark a directory as belonging to the package.
  - Files that are exported from the package must start with a `+`, and must match the exported path in the package.json `"exports"` property. `+main.ts` should be used for the root (`"."`) path.
  - For nested path exports, you must use folders that start with `+` for each path segment (e.g. `import pkg from "@leonsilicon/com.leonsilicon.myapp.lib.db/sqlite-core/migrator"` -> `com/leonsilicon/myapp/lib/db/+sqlite-core/migrator.ts`
- Relative imports are banned. A package should prefer using extension-less `package.json` subpath imports.

Example structure:

```
packages/
  com/leonsilicon/myapp
    components/
      keyboard/
        --components/
          key/
            +main.ts
            key.tsx
            index.ts
            package.json
        -context/
          +main.ts
          +use.ts
          context.tsx
          package.json
        package.json
        index.ts
        keyboard.tsx
  com/npmjs
    npm-wrapper-package/
      package.json
      index.js
      index.d.ts
    scoped__npm-wrapper-package/
      package.json
      index.js
      index.d.ts
      nested.js
      nested.d.js
      double__nested.js
      double__nested.d.js
```
