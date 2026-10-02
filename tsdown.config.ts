import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@riceawa/dsh-lan-gateway'

/**
 * Module specifiers the dsh web shell shares into its frozen module table
 * (dsh 0.2's `PLATFORM_MODULES`: React, Cordis, and the static UI libraries).
 * The browser half only ever requires `react`/`react/jsx-runtime`; the rest are
 * listed so a future value import from them stays external instead of being
 * bundled into the plugin.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

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
      // schemastery instance; cordis, dsh-tools, and dsh-settings resolve to
      // the runtime's instances at load time.
      neverBundle: [
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    // Browser half: the UUID shim plus the Settings → Plugins card. Emitted
    // in the window.__ModuleLoader__.load closure format the DSH web app
    // expects for client bundles (same shape as official dsh-client-* bundles).
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
      neverBundle: [...CLIENT_EXTERNALS],
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
