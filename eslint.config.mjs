import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

// same rule set the Obsidian community directory runs (type-aware for TypeScript)
export default defineConfig([
  { ignores: ['main.js', 'node_modules/**', 'esbuild.config.mjs', 'eslint.config.mjs', 'tools/**', 'docs/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
]);
