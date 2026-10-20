import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "data/", ".cache/"] },
  js.configs.recommended,
  {
    files: ["engine/**", "lib/**", "server/**", "scripts/**", "test/**", "eslint.config.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["web/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
];
