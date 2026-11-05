/**
 * Inert stand-ins for the platform's React controls.
 *
 * The card imports these from `@deepseek-ai/dsh-client-ui-primitives`, which the
 * web shell resolves from its frozen module table at runtime. That package's own
 * UI dependency tree (shiki, katex, simple-icons, …) is not installed in this
 * repo — only its types are, for `pnpm typecheck` — so importing it in a test
 * process would fail on the first transitive import.
 *
 * The client tests never mount the card: they pin the value codecs, the slot
 * registration, and the UUID shim, none of which reach a control. The build
 * keeps the real package external, and typecheck holds the real component
 * contract; this module only keeps the import graph loadable.
 */

/** Stand-in for a primitive React component. */
export const Stub = (): null => null

export const Button = Stub
export const SegmentedControl = Stub
export const SettingsForm = Stub
export const SettingsSecretField = Stub
export const SettingsValueField = Stub
export const Switch = Stub
export const Tag = Stub

/** Stand-in for the staged form model; never constructed by these tests. */
export class SettingsFormModel {}
