import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv[2] === 'production';
const banner = '/* Cortex Graph – MIT License – bundles three.js (MIT, © 2010-2023 three.js authors) */';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.js'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  loader: { '.worker.js': 'text' },
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: 'main.js',
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
