import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // See tests/stubs/ui-primitives.ts: the platform package is resolved from
      // the web shell's module table at runtime, and its UI dependency tree is
      // not installed here. Typecheck compiles against the real types.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/stubs/ui-primitives.ts', import.meta.url),
      ),
    },
  },
})
