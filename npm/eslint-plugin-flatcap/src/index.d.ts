export interface FlatcapSettings {
  /** Defaults to the nearest ancestor with workspaces or a packages/ directory. */
  rootDir?: string;
  /** Relative to rootDir; default: packages. */
  packagesDir?: string;
  /** npm scope; default: @-. */
  scope?: string;
  /** Relative to packagesDir; default: com/npmjs. */
  wrappersDir?: string;
  /** Permit a framework src/ tree; default: false. */
  allowSourceDirectory?: boolean;
}
export interface FlatcapRule {
  meta: {
    type: "problem";
    docs: { description: string };
    schema: [];
    messages: Record<string, string>;
  };
  create(context: unknown): Record<string, (node: unknown) => void>;
}
export interface FlatcapPlugin {
  meta: { name: string; version: string };
  rules: Record<string, FlatcapRule>;
  configs: {
    recommended: {
      name: string;
      plugins: { flatcap: FlatcapPlugin };
      rules: Record<string, "error">;
    };
    oxlint: { jsPlugins: string[]; rules: Record<string, "error"> };
  };
}
export const flatcapRecommendedRules: Record<string, "error">;
declare const plugin: FlatcapPlugin;
export { plugin as flatcapPlugin, plugin as flatcapOxlintPlugin };
export default plugin;
