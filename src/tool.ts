/**
 * The model-facing `lan_gateway` management tool: status, enable/disable, set
 * password, rotate the cookie secret. Mirrors the harness convention of
 * persistent plugins exposing runtime control through registered tools (as
 * dsh-super-injector does with its `dev_*` tools). The password is passed as
 * an explicit argument and never echoed back.
 *
 * @module @dsh-external/dsh-lan-gateway/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GatewayController } from './index.ts'

export const LAN_GATEWAY_TOOL_NAME = 'lan_gateway'

type ToolCommand = 'status' | 'enable' | 'disable' | 'set-password' | 'rotate-secret'

/**
 * Build the `lan_gateway` tool over a controller interface implemented by the
 * plugin entry. Split so the tool stays testable and the plugin decides how
 * the controller mutates state.
 */
export function lanGatewayTool(control: GatewayController): ToolDefinition {
  return defineTool({
    name: LAN_GATEWAY_TOOL_NAME,
    description:
      'Manage the LAN/internet gateway for this DeepSeek Harness web GUI. '
      + '`status` shows whether the gateway is listening, on which port, toward which dsh port, '
      + 'whether a password is set, and the trusted LAN CIDRs. `enable` starts listening on 0.0.0.0 '
      + '(loopback and LAN sources need no password; anything else must sign in). '
      + '`disable` stops listening. `set-password` sets (or, with an empty password, clears) the '
      + 'gateway password for non-LAN access. `rotate-secret` invalidates every issued login cookie.',
    parameters: {
      command: {
        type: 'string',
        enum: ['status', 'enable', 'disable', 'set-password', 'rotate-secret'],
        description:
          '`status` (default) — report gateway state. `enable` / `disable` — start or stop the '
          + 'listener. `set-password` — set or clear the login password. `rotate-secret` — '
          + 'invalidate all existing sessions.',
      },
      password: {
        type: 'string',
        description:
          'Required for `set-password`: the new password (min 8 chars). Omit or pass empty to clear.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, _exec) {
      const command = (args.command ?? 'status') as ToolCommand
      switch (command) {
        case 'status':
          return control.status()
        case 'enable':
          return control.enable()
        case 'disable':
          return control.disable()
        case 'set-password': {
          const password = args.password
          return control.setPassword(typeof password === 'string' ? password : undefined)
        }
        case 'rotate-secret':
          return control.rotateSecret()
      }
    },
  })
}
