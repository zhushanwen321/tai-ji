#!/usr/bin/env node
/**
 * verify-taiji faux 数据目录预置：一步写全 faux LLM 装配所需的四类文件并打印启动命令。
 *
 * 用法：node seed-faux.mjs <repo> <dataDir> [responses.json] [--force]
 *   <repo>            worktree 根
 *   <dataDir>         目标数据目录（值域 = ~/.taiji-dev/ 树内非保留目录，与启动时 --data-dir 一致）
 *   [responses.json]  faux 响应脚本（FauxStep 数组，每 assistant 轮出队一个）；省略写默认单轮演示脚本
 *   --force           覆盖已存在的预置（settings.json 在场时默认拒绝）
 *
 * 写入物（形态与 e2e/fixtures/launch-app-real.ts seedFauxDataDir 同构）：
 *   <dataDir>/agent/settings.json        defaultProvider=faux / defaultModel=faux-1
 *   <dataDir>/agent/models.json          providers.faux（4 个演员模型）
 *   <dataDir>/agent/extensions/faux-llm-ext.ts   pi 孙进程自动发现装载用
 *   <dataDir>/agent/subagents/config.json        L3 引擎注册（pi 引擎 → pi-subagent-cli）
 *   <dataDir>/agent/faux-responses.json  响应脚本（TAIJI_FAUX_SCRIPT 指向它）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const repo = positional[0]
const dataDirArg = positional[1]
const responsesFile = positional[2] && !positional[2].startsWith('--') ? positional[2] : undefined
const force = argv.includes('--force')

if (!repo || !dataDirArg) {
  console.error('用法: node seed-faux.mjs <repo> <dataDir> [responses.json] [--force]')
  process.exit(2)
}
if (!fs.existsSync(path.join(repo, 'e2e', 'fixtures', 'faux-provider-ext'))) {
  console.error(`[seed-faux] ${repo} 下无 e2e/fixtures/faux-provider-ext——repo 路径不对或仓结构已变`)
  process.exit(1)
}

// 值域校验走仓库权威实现（单一来源，不重复实现规则）
const libUrl = pathToFileURL(path.join(repo, 'apps/electron/scripts/dev-instance-lib.mjs')).href
const { resolveCustomDataDir } = await import(libUrl)
let dataDir
try {
  dataDir = resolveCustomDataDir(dataDirArg)
} catch (e) {
  console.error(`[seed-faux] 数据目录值域校验失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const agentDir = path.join(dataDir, 'agent')
const settingsPath = path.join(agentDir, 'settings.json')

// 响应脚本先解析（任何写入之前 fail-fast，防半成品预置）
const responses = responsesFile
  ? JSON.parse(fs.readFileSync(responsesFile, 'utf8'))
  : [{ text: 'faux 演示回复（默认单轮脚本；多轮验收请自备 responses.json）', stopReason: 'stop' }]

if (fs.existsSync(settingsPath) && !force) {
  console.error(`[seed-faux] ${settingsPath} 已存在（可能已被预置或被模板种子创建）——确认后加 --force 覆盖`)
  process.exit(1)
}
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true })
fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true })

const ACTORS = [
  { id: 'faux-1', name: 'Faux 1 (reasoning off)', reasoning: false },
  { id: 'faux-1-reasoning', name: 'Faux 1 Reasoning (reasoning on)', reasoning: true },
  { id: 'faux-1-b', name: 'Faux 1 B (slot actor)', reasoning: false },
  { id: 'faux-1-c', name: 'Faux 1 C (slot actor)', reasoning: false },
]
fs.writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      defaultProvider: 'faux',
      defaultModel: 'faux-1',
      enabledModels: ACTORS.map((a) => `faux/${a.id}`),
      retry: { enabled: false },
    },
    null,
    2,
  ),
)
fs.writeFileSync(
  path.join(agentDir, 'models.json'),
  JSON.stringify(
    {
      providers: {
        faux: {
          name: 'faux',
          api: 'faux',
          apiKey: 'not-needed',
          models: ACTORS.map((a) => ({
            id: a.id,
            name: a.name,
            reasoning: a.reasoning,
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
          })),
        },
      },
    },
    null,
    2,
  ),
)
fs.copyFileSync(
  path.join(repo, 'packages', 'runtime', 'src', '__tests__', 'fixtures', 'faux-llm-ext.ts'),
  path.join(agentDir, 'extensions', 'faux-llm-ext.ts'),
)
fs.writeFileSync(
  path.join(agentDir, 'subagents', 'config.json'),
  JSON.stringify(
    {
      engines: {
        pi: {
          command: process.execPath,
          args: [path.join(repo, 'packages', 'pi-subagent-cli', 'bin', 'pi-subagent-cli.mjs')],
          enabled: true,
        },
      },
    },
    null,
    2,
  ),
)
const scriptPath = path.join(agentDir, 'faux-responses.json')
fs.writeFileSync(scriptPath, JSON.stringify(responses, null, 2))

// 预置最近工作区（runtime 侧 <dataDir>/recent-workspaces.json，形态 = RecentWorkspaceRecord[]）：
// 全新数据目录里工作区列表为空，选目录只能走 OS 原生对话框（不可自动驱动）——预置后
// directory chip 浮层有可点项，新建任务旅程可全程自动驱动。默认登记 <repo> 自身。
fs.writeFileSync(
  path.join(dataDir, 'recent-workspaces.json'),
  JSON.stringify([{ cwd: repo, lastUsedAt: Date.now() }], null, 2),
)

console.log(`[seed-faux] 预置完成: ${dataDir}`)
console.log(`[seed-faux] 响应脚本: ${scriptPath}（${Array.isArray(responses) ? responses.length : '?'} step）`)
console.log('\n启动命令（在 worktree 根执行，background 模式派发）：\n')
console.log(
  [
    'TAIJI_DEV_BACKGROUND=1 \\',
    `TAIJI_FAUX_SCRIPT=${scriptPath} \\`,
    `TAIJI_EXTENSION_PATHS=${path.join(repo, 'e2e', 'fixtures', 'faux-provider-ext')} \\`,
    `node apps/electron/scripts/dev-instance.mjs --data-dir ${dataDir}`,
  ].join('\n'),
)
