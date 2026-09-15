#!/usr/bin/env node
/**
 * taiji-settings CLI — 操作 taiji 自身的设置。
 * 通过 WS 复用 runtime 的 config.* 消息，逻辑单一真值源在 ConfigService。
 *
 * Usage:
 *   taiji-settings list-providers [--json]
 *   taiji-settings get-default-model
 *   taiji-settings set-default-model --provider <p> --model <m>
 *   taiji-settings switch-session-model --session <id> --provider <p> --model <m>
 *   taiji-settings set-thinking --session <id> --level <level>
 */
import { parseArgs, executeCommand } from './commands.js'

async function main(): Promise<void> {
  // eslint-disable-next-line no-magic-numbers -- argv[0]=node、argv[1]=script 路径，slice(2) 跳过是惯用写法
  const args = parseArgs(process.argv.slice(2))

  if (!args.command || args.command === '--help' || args.command === '-h') {
    console.log(`taiji-settings — operate taiji settings via CLI

Read commands:
  list-providers [--json]          List configured providers
  get-default-model                Get current default model
  discover-models --base-url <url> [--name <id>] [--provider <type>]
                                   Fetch models from provider API

Write commands:
  set-default-model --provider <p> --model <m>
  switch-session-model --session <id> --provider <p> --model <m>
  set-thinking --session <id> --level <off|minimal|low|medium|high|xhigh>
  set-provider --name <id> --provider <type> [--api-key-stdin]
  set-skill-dirs --skill-dirs <path1,path2,...>
  set-agent-dirs --agent-dirs <path1,path2,...>
  delete-provider --name <id>

Options:
  --json              Output as JSON
  --api-key-stdin     Read apiKey from stdin (never from CLI args)
  --help              Show this help`)
    process.exit(0)
  }

  try {
    const output = await executeCommand(args)
    console.log(output)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}

main().catch((err) => {
  // main 内部已 catch 业务异常；此兜底仅处理未预期的 reject（如 main 同步 throw）
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
