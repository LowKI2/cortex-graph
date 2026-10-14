/* worker sources are compiled separately by the esbuild plugin and imported as plain text */
declare module 'cortex-worker:*' { const src: string; export default src; }
