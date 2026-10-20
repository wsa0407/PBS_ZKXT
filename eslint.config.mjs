// The app owns lint dependencies; this configuration covers every executable layer.
import js from "./app/node_modules/@eslint/js/src/index.js";
import globals from "./app/node_modules/globals/index.js";
export default [
  { ignores: ["**/node_modules/**", "app/data/**", "app/.cache/**", "runtime/.state/**", "output/**"] },
  js.configs.recommended,
  { files: ["**/*.mjs", "app/server/**/*.js"], languageOptions: { globals: globals.node } },
  { files: ["app/web/**/*.js", "app/web/**/*.mjs"], languageOptions: { globals: globals.browser } },
  { rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] } },
];
