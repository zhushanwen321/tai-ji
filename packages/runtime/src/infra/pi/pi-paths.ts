/**
 * Pi 路径解析（env-var-aware，支持实例隔离）
 *
 * 数据根目录委托 shared 的 getDataDir（SSOT，ADR-0009 隔离）。
 * 其余 pi 子路径在此派生。
 *
 * 目录结构（布局完整对齐 pi 0.84.x，唯一差异是根目录）：
 *   ~/.taiji/                    ← taiji 配置根目录
 *     config.json                    ← taiji 自身配置
 *     extensions/                    ← 用户安装的 extension（local/git + discovery 扫描根）
 *     npm/                           ← npm 安装的 extension（node_modules 平铺布局）
 *     tmp/                           ← extension 安装临时目录
 *     skills/                        ← skill 强制目录（ADR-0021）
 *     agents/                        ← agent 强制目录（ADR-0021）
 *     agent/                         ← pi 的 agent 目录（PI_CODING_AGENT_DIR，≙ ~/.pi/agent）
 *       models.json                  ← Provider & Model 定义
 *       settings.json                ← pi 设置（pi 原生配置，不迁出）
 *       disabled-packages.json       ← extension 启停状态（不迁出）
 *       config/providers.json        ← taiji 扩展域（quota/authMethod/modelStates，pi 不扫描）
 *       sessions/                    ← Session jsonl 文件
 *         <encodeCwd>/               ← pi 按 cwd 自动分子目录（默认布局）
 *       subagents/<encodeCwd>/sessions/  ← subagent session 目录（相对 agentDir 派生不变）
 */

import {
  getDataDir as sharedGetDataDir,
  getExtensionsDir as sharedGetExtensionsDir,
  getNpmDir as sharedGetNpmDir,
  getTmpDir as sharedGetTmpDir,
} from '@taiji/shared/paths'
import { join } from 'node:path'

/** taiji 数据根目录（委托 shared SSOT，读 TAIJI_AGENT_DATA_DIR，缺省 ~/.taiji）。 */
export function getConfigDir(): string {
  return sharedGetDataDir()
}

/**
 * 用户安装的 extension 目录（`<dataDir>/extensions`）。
 * 委托 shared SSOT（@taiji/shared/paths），原在旧布局 agent/ 子树下，已迁出到 dataDir 根层。
 */
export function getExtensionsDir(): string {
  return sharedGetExtensionsDir()
}

/**
 * npm 安装的 extension 目录（`<dataDir>/npm`）。
 * 委托 shared SSOT，原在旧布局 agent/ 子树下，已迁出到 dataDir 根层。
 */
export function getNpmDir(): string {
  return sharedGetNpmDir()
}

/**
 * extension 安装临时目录（`<dataDir>/tmp`）。
 * 委托 shared SSOT，原在旧布局 agent/ 子树下，已迁出到 dataDir 根层。
 */
export function getTmpDir(): string {
  return sharedGetTmpDir()
}

/**
 * pi agent directory（PI_CODING_AGENT_DIR）: `<dataDir>/agent/`。
 * 方案 B 布局对齐 pi（≙ `~/.pi/agent`，唯一差异是根目录）；
 * 旧布局 pi/ 兄弟层已由迁移脚本退役（pi/ 层保留为迁移备份）。
 */
export function getPiAgentDir(): string {
  return join(getConfigDir(), 'agent')
}

export function getModelsPath(): string {
  return join(getPiAgentDir(), 'models.json')
}

export function getSettingsPath(): string {
  return join(getPiAgentDir(), 'settings.json')
}

/**
 * taiji 扩展域 providers.json 路径：`<piAgentDir>/config/providers.json`。
 *
 * 承载自 pi models.json 迁出的 taiji 私有字段（provider 级 quota/authMethod、
 * models[].enabled 转化的 modelStates），models.json 只留 pi schema 内字段
 *（provider-config-quota 架构 D4）。同目录已有先例 config/rename-session-ext-config.json
 *（写者 rename-session-config.ts，P1-7 名实拆分前在 worktree-config-helper），pi 不扫描 agent/config/ 子目录，无冲突。
 *
 * 「pi 不扫描 agent/config/ 子目录」断言锚点（ADR-0063 I4，pi 行为断言须带源码依据）：
 * - 权威源 = 实装 0.84.1（node_modules/@earendil-works/pi-coding-agent/dist）：
 *   dist 全部 JS 中 `join(getAgentDir(), ...)` 家族全集 11 项（auth.json / bin /
 *   keybindings.json / models-store.json / models.json / prompts / sessions /
 *   settings.json / themes / tools / `<APP_NAME>-debug.log`，定义于 dist/config.js）
 *   无 config 子目录；`join(getAgentDir(), "config")` 全 dist 零命中；唯一 readdir
 *   agentDir 的 dist/migrations.js migrateSessionsFromAgentRoot 仅 filter 顶层
 *   `.jsonl`（不进子目录）。
 * - clone TS 参照（~/Code/git-fork/pi-mono-workspace 496185f6，2026-08-19）：
 *   coding-agent/src/config.ts getAgentDir 家族 + migrations.ts
 *   migrateSessionsFromAgentRoot 同语义（clone 与实装的 join 调用点全集核对一致）。
 * 机器防线：`__tests__/pi-paths-config-dir-contract.test.ts`——pi 升级引入 config/
 * 占用时该测试先行红，提示复核本锚点。
 */
export function getProviderExtrasPath(): string {
  return join(getPiAgentDir(), 'config', 'providers.json')
}

/**
 * pi sessions directory: `<agentDir>/sessions/`（对齐 pi 默认派生，
 * 锚点 dist/config.js getSessionsDir）。session jsonl 实际落在其下的
 * `<encodeCwd>/` 子目录（pi 默认布局，按 cwd 分目录）。
 */
export function getSessionsDir(): string {
  return join(getPiAgentDir(), 'sessions')
}

export function getAgentsDir(): string {
  return join(getPiAgentDir(), 'agents')
}

/**
 * 编码 cwd 为目录名（复刻 pi-subagent-workflow 的 path-encoding.ts）。
 *
 * 规则：'--' + cwd 去掉首斜杠 + 所有 / \ : 替换为 - + '--'
 * 例：/Users/x/proj → --Users-x-proj--
 *     C:\Users\x\proj → --C--Users-x-proj--（盘符冒号与反斜杠各替换为一个 -）
 *
 * 用于定位 subagent session 目录：<piAgentDir>/subagents/<encodeCwd(cwd)>/sessions/
 */
export function encodeCwd(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/**
 * 获取 subagent session 目录路径。
 * <piAgentDir>/subagents/<encodeCwd(mainCwd)>/sessions/
 */
export function getSubagentSessionDir(mainCwd: string): string {
  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')
}

/**
 * btw 线会话根目录：`<piAgentDir>/btw/`（btw-question D2）。
 *
 * **目录即关联的持久载体**：`btw/<encodeCwd>/<mainSid>/` 三层布局编码「主会话 → btw 线」
 * 关联（无 sidecar 第二持久面）；不落 `sessions/` 扫描面 ⇒ SessionScanner 磁盘腿构造性
 * 不可见（G4 防线之一，与 active 腿 hidden:true 注册、历史腿不记工作区历史并列）。
 * 线会话文件由 pi 写入（fork 链路 / 首 flush 自建），宿主对线目录的写面 = 扫描重建
 *（只读）+ 通用 outcome sidecar（`.jsonl.meta.json`，onSessionExit/persistSessionOutput
 * 终态链对 btw 线同样生效；显式关线只删 .jsonl，sidecar 残留由主删级联 / 启动孤儿补账
 * 兜底清理）+ 删（主删级联 / 显式关线 / 启动孤儿补账——归 M4-a），零直写红线适用。
 *
 * subagent 先例同构：`pi-paths.ts` subagents/ 独立目录（`getSubagentSessionDir`）。
 */
export function getBtwSessionsRoot(): string {
  return join(getPiAgentDir(), 'btw')
}

/**
 * pi 会话 id 合法值域判定（pi `assertValidSessionId` 同款正则，dist/core/session-manager.js）：
 * 首尾字母数字，中间允许 `[A-Za-z0-9._-]`。真 sid 永不含 `:` ⇒ 本校验同时挡住
 * btw vid 误传（`btw:<sid>` 含冒号必拒——vid 是 runtime/前端路由 key，不直传目录层）。
 */
export function isPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id)
}

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/**
 * btw 线会话目录：`<piAgentDir>/btw/<encodeCwd(mainCwd)>/<mainSid>/`（btw-question D2 布局）。
 *
 * 该目录同时是：pi `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` 的落点值、
 * 启动注册表扫描重建的遍历单元、主删级联的删除单元。
 *
 * mainSid 校验 fail-fast（路径注入防线）：必须是合法 pi 会话 id 形态——挡空串 /
 * 路径分隔符 / `..` / 冒号（vid 误传）等一切非单层目录名输入。
 */
export function getBtwThreadDir(mainCwd: string, mainSid: string): string {
  if (!isPiSessionId(mainSid)) {
    throw new Error(
      `[btw] getBtwThreadDir: mainSid 非法（须为 pi 会话 id 形态，禁路径分隔符/冒号），收到 "${mainSid}"`,
    )
  }
  return join(getBtwSessionsRoot(), encodeCwd(mainCwd), mainSid)
}
