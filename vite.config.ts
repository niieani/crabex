import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["packages/proxy/src/routing/models-fixture.json"] },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
