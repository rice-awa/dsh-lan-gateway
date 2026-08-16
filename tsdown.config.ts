import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-lan-gateway'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      // The Loader validates the plugin's `Config` schema and must see its own
      // schemastery instance; cordis is type-only in this bundle.
      neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
    },
  },
  {
    // Browser half: the insecure-origin UUID shim. Emitted in the
    // window.__ModuleLoader__.load closure format the DSH web app expects for
    // client bundles (same shape as official dsh-client-* bundles).
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: ['@deepseek-ai/cordis'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
