import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { ESLint as ESLint9 } from "eslint9";
import parser from "@typescript-eslint/parser";
import plugin from "../npm/eslint-plugin-flatcap/src/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flatcap-tests-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const json = (file, value) => write(file, JSON.stringify(value));
json(path.join(root, "package.json"), {
  private: true,
  type: "module",
  workspaces: ["packages/**", "apps/*"],
});
write(path.join(root, "eslint.config.js"), "export default [];\n");

function pkg(location, patch = {}) {
  const dir = path.join(root, "packages", location);
  const name = `@-/${location
    .split("/")
    .map((s) => s.replace(/^[+@]/, ""))
    .join(".")}`;
  const manifest = {
    name,
    type: "module",
    imports: { "#impl": "./impl.ts" },
    exports: { ".": "./+.ts" },
    ...patch,
  };
  json(path.join(dir, "package.json"), manifest);
  write(path.join(dir, "README.md"), `# ${name}\n`);
  write(path.join(dir, "+.ts"), 'export { value } from "#impl";');
  write(path.join(dir, "impl.ts"), "export const value = 1;");
  return { dir, name, manifest, file: (name = "impl.ts") => path.join(dir, name) };
}
const app = pkg("org/example/app");
const other = pkg("org/example/other");
const protectedPackage = pkg("org/example/app/_context");
const privatePackage = pkg("org/example/app/__parts/key");
const nestedRestricted = pkg("org/example/app/__parts/key/_helpers");
const detached = pkg("org/example/app/+entry");
const detachedChild = pkg("org/example/app/+entry/child");
const child = pkg("org/example/app/child");
const wrapper = pkg("com/npmjs/example", { imports: {}, dependencies: { example: "catalog:" } });

function engine(rule, Engine = ESLint, settings = {}) {
  return new Engine({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
        languageOptions: { parser },
        plugins: { flatcap: plugin },
        settings: { flatcap: settings },
        rules: typeof rule === "string" ? { [`flatcap/${rule}`]: "error" } : rule,
      },
    ],
  });
}
async function lint(rule, code, file = app.file(), Engine = ESLint, settings = {}) {
  const results = await engine(rule, Engine, settings).lintText(code, { filePath: file });
  assert.equal(results[0].fatalErrorCount, 0, JSON.stringify(results[0].messages));
  return results[0].messages;
}
async function expect(rule, code, ids, file, Engine, settings) {
  const messages = await lint(rule, code, file, Engine, settings);
  assert.deepEqual(
    messages.map((m) => m.messageId),
    ids,
    JSON.stringify(messages),
  );
}

for (const [version, Engine] of [
  ["ESLint 9", ESLint9],
  ["ESLint 10", ESLint],
]) {
  test(`${version}: flat recommended config is directly usable`, async () => {
    const instance = new Engine({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ["**/*.ts"], languageOptions: { parser } },
        plugin.configs.recommended,
      ],
    });
    const result = await instance.lintText('export { value } from "#impl";', {
      filePath: app.file("+.ts"),
    });
    assert.deepEqual(result[0].messages, []);
  });
  for (const code of [
    'import "./local";',
    'export { value } from "../local";',
    'export * from "./local";',
    'import("./local");',
    "import(`./local`);",
    'require("./local");',
    'require.resolve("./local");',
    'type T = import("./local").T;',
    'import value = require("./local");',
  ])
    test(`${version}: relative syntax ${code}`, () =>
      expect("no-relative-imports", code, ["relativeImport"], app.file(), Engine));
  test(`${version}: dynamic unknown imports do not crash`, () =>
    expect(
      "no-relative-imports",
      "import(variable); require(variable); import(`./${variable}`);",
      [],
      app.file(),
      Engine,
    ));
  test(`${version}: comments and strings are not imports`, () =>
    expect(
      "no-relative-imports",
      'const text = \'import "./x"\'; // import "./x"',
      [],
      app.file(),
      Engine,
    ));
}

test("relative test imports stay inside their package", async () => {
  await expect(
    "no-relative-imports",
    'import "../impl.ts";',
    [],
    app.file("__tests__/app.test.ts"),
  );
  await expect(
    "no-workspace-import-bypass",
    'import "../impl.ts";',
    [],
    app.file("__tests__/app.test.ts"),
  );
  await expect(
    "no-workspace-import-bypass",
    'import "../../other/impl.ts";',
    ["bypass"],
    app.file("__tests__/app.test.ts"),
  );
});
test("framework src exception is opt-in", async () => {
  await expect(
    "no-relative-imports",
    'import "./x";',
    ["relativeImport"],
    app.file("src/screen.tsx"),
  );
  await expect("no-relative-imports", 'import "./x";', [], app.file("src/screen.tsx"), ESLint, {
    allowSourceDirectory: true,
  });
});
test("asset and dot folders skip source conventions", async () => {
  for (const folder of ["@assets/nested", ".storybook"])
    await expect("no-relative-imports", 'import "./x";', [], app.file(`${folder}/data.ts`));
});
test("flat files, nested packages, tests, and + export trees", async () => {
  await expect("flat-package-files", "", [], app.file());
  await expect("flat-package-files", "", ["nestedPackageFile"], app.file("nested/orphan.ts"));
  await expect("flat-package-files", "", [], protectedPackage.file());
  await expect("flat-package-files", "", [], app.file("__tests__/fixtures/deep.test.ts"));
  await expect("flat-package-files", "", [], app.file("+/nested/api.ts"));
  await expect(
    "flat-package-files",
    "",
    ["missingPackage"],
    path.join(root, "packages/org/orphan.ts"),
  );
});
test("protected package boundaries include separator and scope", async () => {
  await expect(
    "no-encapsulation-violating-imports",
    `import "${protectedPackage.name}";`,
    [],
    app.file(),
  );
  await expect(
    "no-encapsulation-violating-imports",
    `export * from "${protectedPackage.name}/subpath";`,
    [],
    child.file(),
  );
  await expect(
    "no-encapsulation-violating-imports",
    `require("${protectedPackage.name}");`,
    ["internalImport"],
    other.file(),
  );
  const similarlyNamed = pkg("org/example/application");
  await expect(
    "no-encapsulation-violating-imports",
    `import "${protectedPackage.name}";`,
    ["internalImport"],
    similarlyNamed.file(),
  );
});
test("private packages only admit their owner and themselves", async () => {
  await expect(
    "no-encapsulation-violating-imports",
    `import "${privatePackage.name}";`,
    [],
    app.file(),
  );
  await expect(
    "no-encapsulation-violating-imports",
    `import "${privatePackage.name}";`,
    [],
    privatePackage.file(),
  );
  await expect(
    "no-encapsulation-violating-imports",
    `import "${privatePackage.name}";`,
    ["privateImport"],
    child.file(),
  );
});
test("nested protected segments cannot conceal outer private boundaries", async () => {
  await expect(
    "no-encapsulation-violating-imports",
    `import "${nestedRestricted.name}";`,
    ["privateImport"],
    other.file(),
  );
  await expect(
    "no-encapsulation-violating-imports",
    `import "${nestedRestricted.name}";`,
    [],
    privatePackage.file(),
  );
});
test("detached restriction is inherited by descendants", async () => {
  for (const owner of [detached, detachedChild])
    await expect(
      "no-encapsulation-violating-imports",
      `import "${protectedPackage.name}";`,
      ["internalImport"],
      owner.file(),
    );
  await expect("package-name-matches-path", "", [], detached.file());
});
test("#alias cannot conceal protected dependency", async () => {
  const alias = pkg("org/example/aliased", { imports: { "#secret": protectedPackage.name } });
  await expect(
    "no-encapsulation-violating-imports",
    'import "#secret";',
    ["internalImport"],
    alias.file(),
  );
  await expect(
    "no-undeclared-dependencies",
    'import "#secret";',
    ["undeclaredDependency"],
    alias.file(),
  );
});
test("apps cannot import private packages", async () => {
  const file = write(path.join(root, "apps/web/index.ts"), "");
  json(path.join(path.dirname(file), "package.json"), { name: "web" });
  await expect(
    "no-encapsulation-violating-imports",
    `import "${protectedPackage.name}";`,
    ["internalImport"],
    file,
  );
});
test("relative, absolute, and file URL imports cannot cross boundaries", async () => {
  for (const specifier of ["../other/impl.ts", other.file(), `file://${other.file()}`])
    await expect("no-workspace-import-bypass", `import ${JSON.stringify(specifier)};`, ["bypass"]);
});
test("imports map cannot reach into a nested package", async () => {
  const parent = pkg("org/nested", { imports: { "#secret": "./child/impl.ts" } });
  pkg("org/nested/child");
  await expect("no-workspace-import-bypass", 'import "#secret";', ["bypass"], parent.file());
});
test("symlink imports cannot leave their package", async () => {
  const alias = pkg("org/symlink", { imports: { "#secret": "./linked.ts" } });
  fs.symlinkSync(other.file(), alias.file("linked.ts"));
  await expect("no-workspace-import-bypass", 'import "#secret";', ["bypass"], alias.file());
  await expect("no-workspace-import-bypass", 'import "./linked.ts";', ["bypass"], alias.file());
  await expect("no-workspace-import-bypass", 'import "./linked";', ["bypass"], alias.file());
});
test("dependency declarations include peers, optional, dev and self; builtins need none", async () => {
  const deps = pkg("org/deps", {
    dependencies: { one: "catalog:" },
    peerDependencies: { two: "*" },
    optionalDependencies: { three: "*" },
    devDependencies: { four: "*" },
  });
  await expect(
    "no-undeclared-dependencies",
    `import "one"; import "two/subpath"; import "three"; import "four"; import "node:fs"; import "fs"; import "bun:test"; import "${deps.name}";`,
    [],
    deps.file(),
  );
  await expect(
    "no-undeclared-dependencies",
    'import "missing/subpath";',
    ["undeclaredDependency"],
    deps.file(),
  );
});
test("#imports resolve exact, conditional, pattern, and blocked targets", async () => {
  const mapped = pkg("org/mapped", {
    imports: {
      "#exact": "./impl.ts",
      "#conditional": { types: "./impl.ts", default: "./impl.ts" },
      "#parts/*": "./*.ts",
      "#parts/blocked": null,
    },
  });
  await expect(
    "no-unresolved-imports",
    'import "#exact"; import "#conditional"; import "#parts/impl";',
    [],
    mapped.file(),
  );
  for (const key of ["#missing", "#parts/missing", "#parts/blocked"])
    await expect("no-unresolved-imports", `import "${key}";`, ["unresolvedImport"], mapped.file());
});
test("circular #aliases are reported instead of recursing forever", async () => {
  const cyclic = pkg("org/cyclic", { imports: { "#a": "#b", "#b": "#a" } });
  await expect("no-unresolved-imports", 'import "#a";', ["unresolvedImport"], cyclic.file());
});
test("workspace exports resolve root, subpath, query, patterns, and conditional targets", async () => {
  const exported = pkg("org/exported", {
    exports: {
      ".": { types: "./+.ts", import: "./+.ts" },
      "./server": "./+server.ts",
      "./*": "./+*.ts",
      "./blocked": null,
    },
  });
  write(exported.file("+server.ts"), 'export { value } from "#impl";');
  await expect(
    "no-unresolved-imports",
    `import "${exported.name}"; import "${exported.name}/server?raw";`,
    [],
  );
  await expect("no-unresolved-imports", `import "${exported.name}/blocked";`, [
    "unexportedSubpath",
  ]);
  await expect("no-unresolved-imports", `import "${other.name}/impl.ts";`, ["unexportedSubpath"]);
  await expect("no-unresolved-imports", `import "${exported.name}/missing";`, [
    "missingExportTarget",
  ]);
  await expect("no-unresolved-imports", 'import "@-/org.not-found";', ["unknownPackage"]);
  await expect("no-unresolved-imports", `import "${detached.name}";`, []);
});
test("private scripts require shebangs and executable mode", async () => {
  const file = write(app.file("__build.ts"), "console.log(1);");
  fs.chmodSync(file, 0o644);
  await expect(
    "private-script-files",
    "console.log(1);",
    process.platform === "win32" ? ["missingShebang"] : ["missingShebang", "notExecutable"],
    file,
  );
  fs.chmodSync(file, 0o755);
  await expect("private-script-files", "#!/usr/bin/env node\nconsole.log(1);", [], file);
});
test("private scripts cannot export, but can declare a TypeScript module marker", async () => {
  await expect(
    "no-export-from-private-file",
    "export const value = 1;",
    ["exportFromPrivateFile"],
    app.file("__build.ts"),
  );
  await expect("no-export-from-private-file", "export {};", [], app.file("__build.ts"));
  await expect(
    "no-export-from-private-file",
    "export const helper = 1;",
    [],
    app.file("-helper.ts"),
  );
});
test("public APIs only re-export; wrappers may use export *", async () => {
  await expect("public-entrypoints", 'export { value } from "#impl";', [], app.file("+.ts"));
  await expect(
    "public-entrypoints",
    'export * from "#impl";',
    ["wildcardExport"],
    app.file("+.ts"),
  );
  await expect(
    "public-entrypoints",
    "export const value = 1;",
    ["implementationInEntrypoint"],
    app.file("+.ts"),
  );
  await expect(
    "public-entrypoints",
    'import "#impl"; export { value } from "#impl";',
    ["implementationInEntrypoint"],
    app.file("+.ts"),
  );
  await expect(
    "public-entrypoints",
    'export { value } from "upstream";',
    ["nonSubpathExport"],
    app.file("+.ts"),
  );
  await expect("public-entrypoints", 'export * from "example";', [], wrapper.file("+.ts"));
  await expect(
    "public-entrypoints",
    "export const value = 1;",
    ["implementationInEntrypoint"],
    wrapper.file("+.ts"),
  );
});
test("public API may not expose dash-prefixed helpers", async () => {
  const helper = pkg("org/helper", { imports: { "#private": "./-impl.ts" } });
  write(helper.file("-impl.ts"), "export const value = 1;");
  await expect(
    "public-entrypoints",
    'export { value } from "#private";',
    ["privateHelper"],
    helper.file("+.ts"),
  );
});
test("manifest covers +server, README CRLF, wildcard and nested exports", async () => {
  const valid = pkg("org/manifest", {
    exports: {
      ".": "./+server.ts",
      "./foo/bar": "./+foo__bar.ts",
      "./nested/x": "./+/nested/x.ts",
      "./items/*": "./+items__*.ts",
    },
  });
  for (const file of ["+server.ts", "+foo__bar.ts", "+/nested/x.ts"])
    write(valid.file(file), 'export { value } from "#impl";');
  write(valid.file("README.md"), `# ${valid.name}\r\n`);
  await expect("package-manifest", "", [], valid.file());
});
test("manifest reports malformed JSON, missing README, imports, exports, and dependency protocols", async () => {
  const invalid = pkg("org/invalid", {
    imports: {},
    exports: { ".": "./impl.ts" },
    dependencies: { [app.name]: "*" },
  });
  fs.unlinkSync(invalid.file("README.md"));
  const messages = await lint("package-manifest", "", invalid.file());
  assert.equal(messages.length, 1);
  for (const detail of ["missing README.md", "must use workspace:", "must use ./+"])
    assert.ok(messages[0].message.includes(detail), messages[0].message);
  write(invalid.file("package.json"), "{");
  await expect("package-manifest", "", ["invalidManifest"], invalid.file());
});
test("manifest rejects path traversal and missing targets", async () => {
  const bad = pkg("org/targets", {
    imports: { "#escape": "../impl.ts", "#missing": "./missing.ts" },
    exports: { ".": "./../+.ts" },
  });
  const messages = await lint("package-manifest", "", bad.file());
  for (const detail of ["invalid imports target", "does not exist", "invalid exports"])
    assert.ok(messages[0].message.includes(detail), messages[0].message);
});
test("manifest rejects invalid nested conditional targets", async () => {
  const invalid = pkg("org/invalid-condition", {
    imports: { "#impl": { types: 42, default: "./impl.ts" } },
    exports: { ".": { types: false, default: "./+.ts" } },
  });
  const messages = await lint("package-manifest", "", invalid.file());
  assert.match(messages[0].message, /imports\[#impl\] has an invalid target/);
  assert.match(messages[0].message, /exports\[\.\] has an invalid target/);
});
test("manifest requires single underscore bin entries", async () => {
  const script = pkg("org/script");
  write(script.file("_build.ts"), "#!/usr/bin/env node\n");
  assert.match((await lint("package-manifest", "", script.file()))[0].message, /bin\[_build\]/);
  json(script.file("package.json"), { ...script.manifest, bin: { _build: "./_build.ts" } });
  await expect("package-manifest", "", [], script.file());
});
test("root config finds invalid packages without source files", async () => {
  json(path.join(root, "packages/org/empty/package.json"), { name: "wrong" });
  const messages = await lint("package-manifest", "", path.join(root, "eslint.config.js"));
  assert.ok(messages.some((m) => m.message.includes("org/empty/package.json")));
});
test("root config reports duplicate detached and normal package names", async () => {
  pkg("org/duplicate");
  pkg("org/+duplicate");
  const messages = await lint("package-manifest", "", path.join(root, "eslint.config.js"));
  assert.ok(messages.some((m) => m.message.includes("duplicate workspace name @-/org.duplicate")));
});
test("repeat linting and manifest edits never suppress diagnostics", async () => {
  const target = pkg("org/repeated", { name: "wrong" });
  const instance = engine("package-name-matches-path");
  for (let i = 0; i < 2; i++)
    assert.equal((await instance.lintText("", { filePath: target.file() }))[0].messages.length, 1);
  json(target.file("package.json"), { ...target.manifest, name: "@-/org.repeated" });
  assert.equal((await instance.lintText("", { filePath: target.file() }))[0].messages.length, 0);
  json(target.file("package.json"), { ...target.manifest, name: "wrong-again" });
  assert.equal((await instance.lintText("", { filePath: target.file() }))[0].messages.length, 1);
});
test("root detection works when ESLint cwd is a nested package", async () => {
  const instance = new ESLint({
    cwd: app.dir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: { parser },
        plugins: { flatcap: plugin },
        rules: { "flatcap/package-name-matches-path": "error" },
      },
    ],
  });
  assert.deepEqual((await instance.lintText("", { filePath: app.file() }))[0].messages, []);
});
test("non-Haniverse paths and custom roots/scopes are supported", async () => {
  const custom = path.join(root, "custom");
  const dir = path.join(custom, "modules/net/example/lib");
  json(path.join(dir, "package.json"), { name: "@example/net.example.lib" });
  await expect("package-name-matches-path", "", [], path.join(dir, "impl.ts"), ESLint, {
    rootDir: custom,
    packagesDir: "modules",
    scope: "@example",
  });
});

test("Oxlint loads the npm plugin and executes AST and manifest rules", () => {
  const require = createRequire(import.meta.url);
  const binary = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  const pluginPath = fileURLToPath(
    new URL("../npm/eslint-plugin-flatcap/src/index.js", import.meta.url),
  );
  const config = json(path.join(root, ".oxlintrc.json"), {
    jsPlugins: [{ name: "flatcap", specifier: pluginPath }],
    rules: { "flatcap/no-relative-imports": "error", "flatcap/package-name-matches-path": "error" },
  });
  const file = write(
    app.file("oxlint-test.ts"),
    'import "./impl"; type T = import("./impl").Value; import value = require("./impl"); import(`./impl`);',
  );
  const result = spawnSync(binary, ["-c", config, file], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /relativeImport|Use a package import/);
  assert.equal((result.stdout.match(/Use a package import/g) ?? []).length, 4, result.stdout);
  write(file, 'import "#impl";');
  const passing = spawnSync(binary, ["-c", config, file], { cwd: root, encoding: "utf8" });
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
});

test("Oxlint multi-file checks never reuse another file's package or entrypoint state", () => {
  const require = createRequire(import.meta.url);
  const binary = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  const pluginPath = fileURLToPath(
    new URL("../npm/eslint-plugin-flatcap/src/index.js", import.meta.url),
  );
  const first = pkg("net/multifile/first", { dependencies: { first: "*" } });
  const second = pkg("net/multifile/second", { dependencies: { second: "*" } });
  write(first.file(), 'import "first"; export const value = 1;');
  write(second.file(), 'import "second"; export const value = 1;');
  const config = json(path.join(root, "multi.oxlintrc.json"), {
    jsPlugins: [{ name: "flatcap", specifier: pluginPath }],
    rules: plugin.configs.oxlint.rules,
  });
  const result = spawnSync(binary, ["-c", config, first.dir, second.dir], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("npm tarball contains all runtime files and no monorepo-only imports", () => {
  const dir = fileURLToPath(new URL("../npm/eslint-plugin-flatcap", import.meta.url));
  const output = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }),
  );
  const files = output[0].files.map((entry) => entry.path);
  for (const file of [
    "src/index.js",
    "src/index.d.ts",
    "src/rules.js",
    "src/workspace.js",
    "README.md",
    "LICENSE",
    "NOTICE",
  ])
    assert.ok(files.includes(file), file);
  assert.ok(!files.some((file) => file.startsWith("tests/")));
});

test("published types work without ESLint and are assignable to an ESLint flat config", () => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  const declaration = fileURLToPath(
    new URL("../npm/eslint-plugin-flatcap/src/index.js", import.meta.url),
  );
  const isolated = write(
    path.join(root, "typecheck.mts"),
    `import plugin from ${JSON.stringify(declaration)}; const config: { jsPlugins: string[] } = plugin.configs.oxlint; void config;`,
  );
  execFileSync(
    process.execPath,
    [tsc, "--noEmit", "--module", "nodenext", "--target", "es2022", isolated],
    { encoding: "utf8" },
  );
  const eslintTypes = path.join(
    path.dirname(require.resolve("eslint/package.json")),
    "lib/types/index.d.ts",
  );
  write(
    isolated,
    `import plugin from ${JSON.stringify(declaration)}; import type { Linter } from ${JSON.stringify(eslintTypes)}; const config: Linter.Config = plugin.configs.recommended; void config;`,
  );
  execFileSync(
    process.execPath,
    [tsc, "--noEmit", "--module", "nodenext", "--target", "es2022", isolated],
    { encoding: "utf8" },
  );
});
