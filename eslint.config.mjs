import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'node_modules/**', 'esbuild.config.mjs', 'src/sim.worker.js'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.*'] } } },
  },
]);
