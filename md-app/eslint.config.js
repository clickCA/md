import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config([
  globalIgnores(["dist", "src-tauri/target", "playwright-report", "test-results"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // react-hooks v6 strict mode: the codebase still uses the
      // reset-state-on-input-change idiom in a few effects. Migrating to the
      // key-based / during-render patterns is a follow-up refactor — tracked
      // as UI tech debt, warnings must not grow.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);
