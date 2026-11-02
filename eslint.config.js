import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'apps/*/dist', 'shared', '**/.wrangler', 'graphify-out']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['worker/**/*.js'],
    languageOptions: { globals: { ...globals.worker, WebSocketPair: 'readonly' } },
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Build/sync scripts run in Node, not the browser - without this they were
    // linted against browser globals and every `process` reference errored.
    files: ['scripts/**/*.js'],
    languageOptions: { globals: globals.node },
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
