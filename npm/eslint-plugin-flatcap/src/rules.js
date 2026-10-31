import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import {
  codeExtension,
  isObject,
  inside,
  cleanSpecifier,
  packageName,
  relativeSpecifier,
  environment,
  leaves,
  mapEntry,
  exportEntry,
  localTarget,
  fileExists,
  specifierVisitors,
} from "./workspace.js";

function rule(description, messages, create) {
  return { meta: { type: "problem", docs: { description }, schema: [], messages }, create };
}
const report = (context, node, messageId, data = {}) => context.report({ node, messageId, data });
const active = (env) => env.managed && !env.ignored;
const reverseDnsName =
  /^(?:@[a-z0-9-][a-z0-9._-]*\/)[a-z][a-z0-9_-]*(?:\.[_]*[a-z0-9][a-z0-9_-]*)+$/;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function validTarget(value) {
  if (typeof value === "string" || value === null) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(validTarget);
  return (
    isObject(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([condition, target]) =>
        !condition.startsWith(".") && !/^\d+$/.test(condition) && validTarget(target),
    )
  );
}

function manifestProblems(env, info) {
  const problems = [];
  const manifest = info.manifest;
  if (!manifest) return ["package.json must contain a valid JSON object"];
  if (!reverseDnsName.test(info.name ?? ""))
    problems.push("name must be a scoped reverse-DNS name");
  if (info.name !== env.expectedName(info.dir))
    problems.push(`name must be ${env.expectedName(info.dir)}`);
  if (manifest.type !== "module") problems.push('type must be "module"');
  if (!isObject(manifest.imports))
    problems.push("imports must be an object (an empty object is allowed)");
  const main = exportEntry(manifest, ".");
  if (!main.found || !main.targets.length)
    problems.push('exports must expose a root entrypoint "."');
  const readme = path.join(info.dir, "README.md");
  try {
    if (
      fs
        .readFileSync(readme, "utf8")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)[0] !== `# ${info.name}`
    )
      problems.push("README.md title must be the package name");
  } catch {
    problems.push("missing README.md");
  }
  for (const field of dependencyFields) {
    if (manifest[field] !== undefined && !isObject(manifest[field])) {
      problems.push(`${field} must be an object`);
      continue;
    }
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (
        name.startsWith(`${env.scope}/`) &&
        (typeof version !== "string" || !version.startsWith("workspace:"))
      )
        problems.push(`${field}.${name} must use workspace:`);
    }
  }
  for (const [key, value] of Object.entries(manifest.imports ?? {})) {
    if (!key.startsWith("#") || key === "#" || key.startsWith("#/"))
      problems.push(`invalid imports key ${key}`);
    if (!validTarget(value)) problems.push(`imports[${key}] has an invalid target`);
    for (const target of leaves(value)) {
      if (target === null) continue;
      if (target.startsWith("./")) {
        const file = localTarget(info.dir, target);
        if (!file) problems.push(`imports[${key}] escapes its package: ${target}`);
        else if (!target.includes("*") && !fileExists(file))
          problems.push(`imports[${key}] target does not exist: ${target}`);
      } else if (relativeSpecifier(target) || path.isAbsolute(target) || target.startsWith("file:"))
        problems.push(`invalid imports target ${target}`);
    }
  }
  const exports = manifest.exports;
  const entries =
    isObject(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? Object.entries(exports)
      : [[".", exports]];
  for (const [key, value] of entries) {
    if (key !== "." && !key.startsWith("./")) problems.push(`invalid exports key ${key}`);
    if (!validTarget(value)) problems.push(`exports[${key}] has an invalid target`);
    for (const target of leaves(value)) {
      if (target === null) continue;
      const file = localTarget(info.dir, target);
      if (!file) {
        problems.push(`invalid exports[${key}] target ${target}`);
        continue;
      }
      if (!target.includes("*") && !fileExists(file))
        problems.push(`exports[${key}] target does not exist: ${target}`);
      if (!codeExtension.test(target)) continue;
      const stem = target.replace(codeExtension, "");
      const expected =
        key === "."
          ? ["./+", "./+server"]
          : [`./+${key.slice(2).replaceAll("/", "__")}`, `./+/${key.slice(2)}`];
      if (!expected.includes(stem))
        problems.push(`exports[${key}] must use ${expected.join(" or ")} with a code extension`);
    }
  }
  if (manifest.bin !== undefined && !isObject(manifest.bin))
    problems.push("bin must map command names to script paths");
  let filenames = [];
  try {
    filenames = fs.readdirSync(info.dir);
  } catch {
    /* Invalid directory is already reported. */
  }
  for (const filename of filenames) {
    if (!/^_[^_]/.test(filename) || !codeExtension.test(filename)) continue;
    const name = filename.replace(codeExtension, "");
    if (manifest.bin?.[name] !== `./${filename}`)
      problems.push(`bin[${name}] must be ./${filename}`);
  }
  return problems;
}

function forSpecifiers(context, callback) {
  const env = environment(context);
  if (!env.owner || env.ignored) return {};
  return specifierVisitors((node, specifier) => {
    // Resolve package-import aliases as well: a #alias must not conceal a forbidden dependency.
    function visit(value, seen = new Set()) {
      value = cleanSpecifier(value);
      if (value.startsWith("#")) {
        if (seen.has(value)) {
          callback(env, node, value, { found: true, targets: [], circular: true });
          return;
        }
        seen.add(value);
        const entry = mapEntry(env.owner.manifest?.imports, value);
        callback(env, node, value, entry);
        for (const target of entry.targets)
          if (!target.startsWith("./")) visit(target, new Set(seen));
      } else callback(env, node, value);
    }
    visit(specifier);
  });
}

function restriction(env, importedName) {
  const current = env.owner.name;
  if (current === importedName) return null;
  const parts = importedName.slice(importedName.indexOf("/") + 1).split(".");
  const scope = importedName.slice(0, importedName.indexOf("/") + 1);
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index].startsWith("_")) continue;
    const parent = scope + parts.slice(0, index).join(".");
    const restrictedTree = scope + parts.slice(0, index + 1).join(".");
    const privatePackage = parts[index].startsWith("__");
    // A private implementation can own further internal packages, but sibling consumers cannot
    // use a deeper protected segment to bypass the outer private boundary.
    const ownsTargetInsidePrivateTree =
      current?.startsWith(`${restrictedTree}.`) && importedName.startsWith(`${current}.`);
    const allowed = privatePackage
      ? current === parent || current === restrictedTree || ownsTargetInsidePrivateTree
      : current === parent || current?.startsWith(`${parent}.`);
    if (env.detached || !allowed)
      return {
        messageId: privatePackage ? "privateImport" : "internalImport",
        parent,
        importedName,
      };
  }
  return null;
}

function crossesPackage(env, file) {
  if (!inside(env.owner.dir, file)) return true;
  for (const candidate of [
    file,
    ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map((ext) => file + ext),
  ]) {
    try {
      if (!inside(fs.realpathSync(env.owner.dir), fs.realpathSync(candidate))) return true;
      break;
    } catch {
      /* Extensionless or unresolved import: still check lexical package boundaries. */
    }
  }
  for (
    let dir = path.dirname(file);
    dir !== env.owner.dir && inside(env.owner.dir, dir);
    dir = path.dirname(dir)
  ) {
    if (fs.existsSync(path.join(dir, "package.json"))) return true;
  }
  return false;
}

export const rules = {
  "flat-package-files": rule(
    "Keep code beside its package.json, in tests, assets, or public export trees.",
    {
      nestedPackageFile:
        "Flatcap code must live beside package.json; move {{file}} into its own package.",
      missingPackage:
        "Source under packages/ must belong to a Flatcap package with its own package.json.",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        if (!inside(env.packages, env.filename) || env.ignored) return;
        if (!env.managed) {
          report(context, node, "missingPackage");
          return;
        }
        if (env.src || env.test || env.folders[0] === "+") return;
        if (path.dirname(env.relative) !== ".")
          report(context, node, "nestedPackageFile", { file: env.relative });
      },
    }),
  ),
  "package-name": rule(
    "Use scoped reverse-DNS Flatcap names.",
    {
      invalidPackageName: "{{name}} is not a scoped Flatcap reverse-DNS package name.",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        if (active(env) && !reverseDnsName.test(env.owner.name ?? ""))
          report(context, node, "invalidPackageName", { name: String(env.owner.name) });
      },
    }),
  ),
  "package-name-matches-path": rule(
    "Derive package names from their path under packagesDir.",
    {
      packageNameDoesNotMatchPath: "{{name}} must be named {{expected}} to match its directory.",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        if (active(env) && env.owner.name !== env.expectedName(env.owner.dir))
          report(context, node, "packageNameDoesNotMatchPath", {
            name: String(env.owner.name),
            expected: env.expectedName(env.owner.dir),
          });
      },
    }),
  ),
  "package-manifest": rule(
    "Validate manifests, README titles, imports, exports, and script declarations.",
    {
      invalidManifest: "{{manifest}}: {{detail}}.",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        // Linting a root config also checks packages with NO code (which a source-only rule misses).
        const packages =
          path.dirname(env.filename) === env.root
            ? env.allPackages()
            : active(env)
              ? [env.owner]
              : [];
        const names = new Map();
        for (const info of packages) {
          if (names.has(info.name)) names.get(info.name).push(info.dir);
          else names.set(info.name, [info.dir]);
        }
        for (const info of packages) {
          const problems = manifestProblems(env, info);
          if (info.name && names.get(info.name).length > 1)
            problems.push(`duplicate workspace name ${info.name}`);
          if (problems.length)
            report(context, node, "invalidManifest", {
              manifest: path.relative(env.root, path.join(info.dir, "package.json")),
              detail: problems.join("; "),
            });
        }
      },
    }),
  ),
  "no-relative-imports": rule(
    "Use package imports instead of relative imports.",
    {
      relativeImport: "Use a package import or #import instead of {{specifier}}.",
    },
    (context) =>
      forSpecifiers(context, (env, node, specifier) => {
        if (active(env) && !env.test && !env.src && relativeSpecifier(specifier))
          report(context, node, "relativeImport", { specifier });
      }),
  ),
  "no-encapsulation-violating-imports": rule(
    "Enforce protected, private, and detached package boundaries.",
    {
      internalImport:
        "{{specifier}} is protected to {{parent}} and its descendants; detached packages cannot import it.",
      privateImport: "{{specifier}} is private to {{parent}}; detached packages cannot import it.",
    },
    (context) =>
      forSpecifiers(context, (env, node, specifier) => {
        if (!specifier.startsWith(`${env.scope}/`)) return;
        const violation = restriction(env, packageName(specifier));
        if (violation)
          report(context, node, violation.messageId, { specifier, parent: violation.parent });
      }),
  ),
  "no-workspace-import-bypass": rule(
    "Prevent filesystem imports and aliases from bypassing package APIs.",
    {
      bypass: "{{specifier}} bypasses a package boundary; import the package's public exports.",
    },
    (context) =>
      forSpecifiers(context, (env, node, specifier, entry) => {
        if (!active(env) && !inside(env.root, env.filename)) return;
        if (path.isAbsolute(specifier) || specifier.startsWith("file:")) {
          report(context, node, "bypass", { specifier });
          return;
        }
        if (relativeSpecifier(specifier)) {
          const target = path.resolve(path.dirname(env.filename), specifier);
          if (crossesPackage(env, target) && (env.managed || inside(env.packages, target)))
            report(context, node, "bypass", { specifier });
        }
        if (entry)
          for (const target of entry.targets.filter((s) => s.startsWith("./"))) {
            const file = localTarget(env.owner.dir, target);
            if (!file || crossesPackage(env, file)) {
              report(context, node, "bypass", { specifier });
              break;
            }
          }
      }),
  ),
  "no-undeclared-dependencies": rule(
    "Declare dependencies in the importing package, including imports behind #aliases.",
    {
      undeclaredDependency:
        "Declare {{name}} in this package's dependencies (workspace: for local packages).",
    },
    (context) =>
      forSpecifiers(context, (env, node, specifier) => {
        if (
          (!active(env) && !specifier.startsWith(`${env.scope}/`)) ||
          relativeSpecifier(specifier) ||
          specifier.startsWith("#") ||
          path.isAbsolute(specifier) ||
          isBuiltin(specifier) ||
          specifier === "bun:test"
        )
          return;
        const name = packageName(specifier);
        if (name === env.owner.name) return;
        if (
          !dependencyFields.some((field) => Object.hasOwn(env.owner.manifest?.[field] ?? {}, name))
        )
          report(context, node, "undeclaredDependency", { name });
      }),
  ),
  "no-unresolved-imports": rule(
    "Resolve #imports and enforce workspace public subpaths.",
    {
      unresolvedImport: "{{specifier}} has no existing target in this package's imports map.",
      unknownPackage: "{{specifier}} does not resolve to a Flatcap workspace package.",
      unexportedSubpath: "{{specifier}} is not exposed by the target package's exports.",
      missingExportTarget: "{{specifier}} is exported but its target file does not exist.",
    },
    (context) =>
      forSpecifiers(context, (env, node, specifier, entry) => {
        if (entry && active(env)) {
          const targets = entry.targets;
          if (
            !entry.found ||
            !targets.length ||
            !targets.some(
              (target) =>
                !target.startsWith("./") || fileExists(localTarget(env.owner.dir, target) ?? ""),
            )
          )
            report(context, node, "unresolvedImport", { specifier });
        }
        if (!specifier.startsWith(`${env.scope}/`)) return;
        const name = packageName(specifier);
        const target = env.resolvePackage(name);
        if (!target) {
          report(context, node, "unknownPackage", { specifier });
          return;
        }
        const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
        const exported = exportEntry(target.manifest, subpath);
        if (!exported.found || !exported.targets.length)
          report(context, node, "unexportedSubpath", { specifier });
        else if (
          !exported.targets.some((value) => fileExists(localTarget(target.dir, value) ?? ""))
        )
          report(context, node, "missingExportTarget", { specifier });
      }),
  ),
  "no-export-from-private-file": rule(
    "Keep underscore script entrypoints private.",
    {
      exportFromPrivateFile:
        "Underscore script files cannot export; move reusable code into another module.",
    },
    (context) => {
      const env = environment(context);
      if (!active(env) || env.src || env.test || !path.basename(env.filename).startsWith("_"))
        return {};
      const check = (node) => {
        // `export {}` is the TypeScript module marker, not a public API.
        if (
          node.type === "ExportNamedDeclaration" &&
          !node.declaration &&
          !node.source &&
          node.specifiers.length === 0
        )
          return;
        report(context, node, "exportFromPrivateFile");
      };
      return {
        ExportAllDeclaration: check,
        ExportDefaultDeclaration: check,
        ExportNamedDeclaration: check,
        TSExportAssignment: check,
      };
    },
  ),
  "private-script-files": rule(
    "Require executable underscore scripts with shebangs.",
    {
      missingShebang: "Underscore script files must start with a shebang.",
      notExecutable: "Underscore script files must be executable (chmod +x).",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        if (!active(env) || env.test || env.src || !path.basename(env.filename).startsWith("_"))
          return;
        if (!env.sourceCode.text.startsWith("#!")) report(context, node, "missingShebang");
        if (process.platform !== "win32") {
          try {
            if ((fs.statSync(env.filename).mode & 0o111) === 0)
              report(context, node, "notExecutable");
          } catch {
            report(context, node, "notExecutable");
          }
        }
      },
    }),
  ),
  "public-entrypoints": rule(
    "Keep + APIs as explicit re-exports and npm wrapper re-exports.",
    {
      implementationInEntrypoint:
        "Public + entrypoints must contain only re-exports; move implementation into another module.",
      wildcardExport:
        "List named public exports explicitly; export * is reserved for npm wrappers.",
      nonSubpathExport:
        "Re-export local implementation through #imports; only npm wrappers may re-export upstream packages.",
      privateHelper: "A public entrypoint cannot expose a private dash-prefixed helper.",
    },
    (context) => ({
      Program(node) {
        const env = environment(context);
        if (!active(env)) return;
        const entry = path.basename(env.filename).startsWith("+") || env.folders[0] === "+";
        for (const statement of node.body) {
          if (statement.type === "ExportAllDeclaration" && !env.wrapper)
            report(context, statement, "wildcardExport");
          if (!entry) continue;
          if (
            !(
              ["ExportNamedDeclaration", "ExportAllDeclaration"].includes(statement.type) &&
              statement.source &&
              !statement.declaration
            )
          ) {
            report(context, statement, "implementationInEntrypoint");
            continue;
          }
          const specifier = statement.source.value;
          if (!specifier.startsWith("#") && !(env.wrapper && !relativeSpecifier(specifier)))
            report(context, statement.source, "nonSubpathExport");
          if (specifier.startsWith("#")) {
            for (const target of mapEntry(env.owner.manifest?.imports, specifier).targets)
              if (path.basename(target).startsWith("-")) {
                report(context, statement.source, "privateHelper");
                break;
              }
          }
        }
      },
    }),
  ),
};
