export default [
  {
    ignores: ["**/node_modules/**", "**/coverage/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.js"],
    rules: {
      "no-unused-vars": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "valid-typeof": "error",
    },
  },
];
