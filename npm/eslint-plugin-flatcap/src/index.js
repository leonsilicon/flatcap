import { rules } from "./rules.js";

export const flatcapRecommendedRules = Object.fromEntries(
  Object.keys(rules).map((name) => [`flatcap/${name}`, "error"]),
);
const plugin = {
  meta: { name: "eslint-plugin-flatcap", version: "0.1.0" },
  rules,
  configs: {},
};
plugin.configs.recommended = {
  name: "flatcap/recommended",
  plugins: { flatcap: plugin },
  rules: flatcapRecommendedRules,
};
plugin.configs.oxlint = { jsPlugins: ["eslint-plugin-flatcap"], rules: flatcapRecommendedRules };
export const flatcapPlugin = plugin;
export const flatcapOxlintPlugin = plugin;
export default plugin;
