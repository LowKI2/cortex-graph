import esbuild from 'esbuild';
import process from 'process';
import path from 'path';

const prod = process.argv[2] === 'production';
const banner = '/* Cortex Graph – MIT License – bundles three.js (MIT, © 2010-2023 three.js authors) */';

/* the force layout runs in a Web Worker: compile src/*.worker.ts on its own and import it as a string */
const workerAsText = {
  name: 'worker-as-text',
  setup(build) {
    build.onResolve({ filter: /^cortex-worker:/ }, (args) => ({ path: path.resolve('src', args.path.slice('cortex-worker:'.length) + '.worker.ts'), namespace: 'worker-text' }));
    build.onLoad({ filter: /.*/, namespace: 'worker-text' }, async (args) => {
      const out = await esbuild.build({ entryPoints: [args.path], bundle: true, write: false, format: 'iife', target: 'es2020', minifyWhitespace: prod, minifySyntax: prod });
      return { contents: out.outputFiles[0].text, loader: 'text', watchFiles: [args.path] };
    });
  },
};

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  plugins: [workerAsText],
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minifyWhitespace: prod, minifySyntax: prod, minifyIdentifiers: false, // readable names: avoids false positives in the directory's code scan (e.g. a variable named fs)
  outfile: 'main.js',
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
