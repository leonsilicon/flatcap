import fs from "node:fs";
import path from "node:path";

export const codeExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
export const segments = (file) => file.split(path.sep).filter(Boolean);
export const cleanSpecifier = (specifier) => specifier.split("?")[0];
export const packageName = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
export const relativeSpecifier = (specifier) => /^(?:\.{1,2})(?:\/|$)/.test(specifier);
export function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return isObject(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function findRoot(cwd, filename) {
  // Starting at the file also supports editor integrations and ESLint v10's per-file config lookup.
  let dir = path.dirname(filename);
  let fallback;
  while (true) {
    const manifest = readManifest(dir);
    if (manifest?.workspaces) return dir;
    if (fs.existsSync(path.join(dir, "packages"))) fallback ??= dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback ?? cwd;
    dir = parent;
  }
}

// Metadata lives only for this rule invocation. Oxlint reuses SourceCode/context proxies across
// files, and editors can lint unchanged source again after editing its package.json or README.
// Neither proxy identity nor source text is a safe key for a persistent filesystem cache.
const defaultSettings = Object.freeze({});
export function environment(context) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const settings = context.settings?.flatcap ?? defaultSettings;
  const cwd = context.cwd ?? context.getCwd();
  const filename = path.resolve(cwd, context.filename ?? context.getFilename());
  const root = settings.rootDir ? path.resolve(cwd, settings.rootDir) : findRoot(cwd, filename);
  const packages = path.resolve(root, settings.packagesDir ?? "packages");
  const scope = (settings.scope ?? "@-").replace(/\/$/, "");
  const manifests = new Map();
  function info(dir) {
    if (!manifests.has(dir)) {
      const manifest = readManifest(dir);
      manifests.set(dir, { dir, manifest, name: manifest?.name ?? null });
    }
    return manifests.get(dir);
  }
  let owner = null;
  for (let dir = path.dirname(filename); inside(root, dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      owner = info(dir);
      break;
    }
    if (dir === root) break;
  }
  const managed = owner !== null && inside(packages, owner.dir);
  const relative = owner ? path.relative(owner.dir, filename) : "";
  const folders = segments(path.dirname(relative));
  const ignored = folders.some((s) => s.startsWith("@") || (s.startsWith(".") && s !== "."));
  const test =
    folders.includes("__tests__") ||
    (owner && segments(path.relative(packages, owner.dir)).includes("__tests__"));
  const src = settings.allowSourceDirectory === true && folders[0] === "src";
  const wrapper =
    owner && inside(path.resolve(packages, settings.wrappersDir ?? "com/npmjs"), owner.dir);
  const detached =
    managed && segments(path.relative(packages, owner.dir)).some((s) => s.startsWith("+"));
  function expectedName(dir) {
    return `${scope}/${segments(path.relative(packages, dir))
      .map((s) => s.replace(/^[+@]/, ""))
      .join(".")}`;
  }
  function resolvePackage(name) {
    if (!name.startsWith(`${scope}/`)) return null;
    const parts = name.slice(scope.length + 1).split(".");
    // Never let malformed names or subpaths escape packagesDir.
    if (parts.some((s) => !s || /[/\\]/.test(s) || s === "..")) return null;
    let candidates = [packages];
    for (const part of parts) {
      candidates = candidates
        .flatMap((dir) => [part, `+${part}`, `@${part}`].map((s) => path.join(dir, s)))
        .filter((dir) => {
          try {
            return fs.statSync(dir).isDirectory();
          } catch {
            return false;
          }
        });
    }
    return candidates.map(info).find((p) => p.name === name) ?? null;
  }
  function allPackages() {
    const result = [];
    function visit(dir) {
      if (fs.existsSync(path.join(dir, "package.json"))) result.push(info(dir));
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Do not traverse symlinks, generated output, fixtures, or package asset trees.
        if (
          entry.isDirectory() &&
          !["node_modules", "dist", "build", "coverage", "+"].includes(entry.name) &&
          !/^[.@]/.test(entry.name)
        )
          visit(path.join(dir, entry.name));
      }
    }
    visit(packages);
    return result;
  }
  const env = {
    settings,
    sourceCode,
    text: sourceCode.text,
    cwd,
    filename,
    root,
    packages,
    scope,
    owner,
    managed,
    relative,
    folders,
    ignored,
    test,
    src,
    wrapper,
    detached,
    info,
    expectedName,
    resolvePackage,
    allPackages,
  };
  return env;
}

export function leaves(value) {
  if (typeof value === "string" || value === null) return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (isObject(value)) return Object.values(value).flatMap(leaves);
  return [];
}

// Node's exact match, then most-specific pattern semantics. A null exact entry blocks patterns.
export function mapEntry(map, key) {
  if (!isObject(map)) return { found: false, targets: [] };
  if (Object.hasOwn(map, key))
    return { found: true, targets: leaves(map[key]).filter((s) => s !== null) };
  const patterns = Object.keys(map)
    .filter((pattern) => pattern.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");
    if (
      key.startsWith(prefix) &&
      key.endsWith(suffix) &&
      key.length >= prefix.length + suffix.length
    ) {
      const match = key.slice(prefix.length, suffix.length ? -suffix.length : undefined);
      return {
        found: true,
        targets: leaves(map[pattern])
          .filter((s) => s !== null)
          .map((s) => s.replaceAll("*", match)),
      };
    }
  }
  return { found: false, targets: [] };
}

export function exportEntry(manifest, subpath) {
  const value = manifest?.exports;
  if (
    typeof value === "string" ||
    value === null ||
    Array.isArray(value) ||
    (isObject(value) && !Object.keys(value).some((s) => s.startsWith(".")))
  ) {
    return subpath === "."
      ? { found: value !== undefined, targets: leaves(value).filter((s) => s !== null) }
      : { found: false, targets: [] };
  }
  return mapEntry(value, subpath);
}

export function localTarget(dir, target) {
  if (!target.startsWith("./")) return null;
  const parts = cleanSpecifier(target).slice(2).split(/[\\/]/);
  if (
    parts.some((s) => s === ".." || s === "." || s === "node_modules") ||
    /%2f|%5c|%2e/i.test(target)
  )
    return null;
  const file = path.resolve(dir, cleanSpecifier(target));
  if (!inside(dir, file)) return null;
  try {
    if (!inside(fs.realpathSync(dir), fs.realpathSync(file))) return null;
  } catch {
    /* Nonexistent targets are reported by the caller. */
  }
  return file;
}

export function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function specifierVisitors(callback) {
  function literal(node) {
    if (node?.type === "TSLiteralType") {
      literal(node.literal);
      return;
    }
    if (typeof node?.value === "string") callback(node, node.value);
    else if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
      callback(node, node.quasis[0].value.cooked);
  }
  return {
    ImportDeclaration: (node) => literal(node.source),
    ExportNamedDeclaration: (node) => literal(node.source),
    ExportAllDeclaration: (node) => literal(node.source),
    ImportExpression: (node) => literal(node.source),
    CallExpression(node) {
      if (
        (node.callee.type === "Identifier" && node.callee.name === "require") ||
        (node.callee.type === "MemberExpression" &&
          node.callee.object.name === "require" &&
          node.callee.property.name === "resolve")
      )
        literal(node.arguments[0]);
    },
    TSImportType: (node) => literal(node.argument ?? node.source ?? node.parameter),
    TSExternalModuleReference: (node) => literal(node.expression),
  };
}
