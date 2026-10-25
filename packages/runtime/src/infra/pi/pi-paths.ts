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
 *       subagents/<encodeCwd>/sessions/  ← subagent session 目录（旧布局残余读取面——
 *           仅 subagent-extractor legacy 降级链读 W16 前旧 session 存量；新会话数据在
 *           <dataDir>/ext-sessions/<rootSessionId>/subagents/，见 getSubagentSessionDir）
 */

import {
  getDataDir as sharedGetDataDir,
  getExtensionsDir as sharedGetExtensionsDir,
  getNpmDir as sharedGetNpmDir,
  getTmpDir as sharedGetTmpDir,
  getSessionBtwDir as sharedGetSessionBtwDir,
  encodeCwd,
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
 * pi MCP 服务器配置（pi 1.0 起内置 MCP 扩展在会话启动时读取，taiji 经 pi-mcp-store
 * 唯一读写）：`<agentDir>/mcp.json`。用户级文件；pi 另读项目级 `<cwd>/.pi/mcp.json`，
 * 后者不经本 store（设计裁决 I4，taiji 不管理项目级）。
 */
export function getMcpConfigPath(): string {
  return join(getPiAgentDir(), 'mcp.json')
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
 * 归档根目录（session-archive 设计 D1）：`<agentDir>/archive/`——与 sessions/ 平级，
 * 内部镜像 sessions 布局（`archive/<encodeCwd>/<原主文件名>…` + `assets/<sessionId>/`
 * 附件三目录），树段登记见 shared PI_SESSION_TREE_SEGMENTS 的 'archive' 段（加入后
 * staging 期归档目录内明文 .jsonl 可过 main 侧会话导出的路径安全校验
 * isInsideSessionTrees）。
 */
export function getArchiveDir(): string {
  return join(getPiAgentDir(), 'archive')
}

/**
 * 编码 cwd 为目录名（pi 布局 SSOT = @taiji/shared/paths encodeCwd，本处仅 re-export 保持
 * 既有 import 面；规则与例见 shared 实现——main 侧会话项目 .tmp 准入接入时两份平行
 * 实现收敛为单源）。
 *
 * 用于定位 subagent session 目录：<piAgentDir>/subagents/<encodeCwd(cwd)>/sessions/
 */
export { encodeCwd }

/**
 * subagent session 目录（旧布局残余读取面）：`<piAgentDir>/subagents/<encodeCwd(mainCwd)>/sessions/`。
 *
 * [session-store-layout-inversion] 布局反转后新会话的 subagent 会话 jsonl 落
 * `<dataDir>/ext-sessions/<rootSessionId>/subagents/sessions/`（subagent-core
 * path-encoding.ts 的同名 getSubagentSessionDir，分区键 = rootSessionId）。与该同名函数
 * 的语义分叉：本函数参数是 mainCwd、读旧布局；core 版参数是 rootSessionId、产新树落点。
 *
 * 本函数现役唯一消费方 = services/session/subagent-extractor.ts 的 legacy 降级链
 * （W16 前创建的旧 session 的 sessionFile 回退查找；其存量 subagent jsonl 未迁移仍在
 * 旧布局，按存量保留裁决静置，读旧布局即存量数据的正确来源，新会话数据不在此）。
 *
 * 本函数公式是对拍机检 check-artifact-dir-formula-sync.mjs 第四组 RUNTIME_TREE_FNS
 * 的对位锚点（pi 宿主树段 'subagents' ↔ shared PI_SESSION_TREE_SEGMENTS[1]），
 * 改公式须同步该机检与 shared 常量。
 */
export function getSubagentSessionDir(mainCwd: string): string {
  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')
}

/**
 * btw 线会话根目录（旧布局树段锚点）：`<piAgentDir>/btw/`。
 *
 * [session-store-layout-inversion] btw 线已换根至 `<dataDir>/ext-sessions/<mainSid>/btw/`
 * （getSessionBtwDir / getBtwThreadDir）；本函数是旧布局树段锚点——对拍机检
 * check-artifact-dir-formula-sync.mjs RUNTIME_TREE_FNS 以本函数字面量逐位对拍、shared
 * PI_SESSION_TREE_SEGMENTS[2] 喂 main isInsideSessionTrees 消费；无现役读取方
 * （D6 裁决旧 btw 线不可对话），指向的旧布局目录按存量保留裁决静置，
 * 新读写一律走新公式。
 */
export function getBtwSessionsRoot(): string {
  return join(getPiAgentDir(), 'btw')
}

/**
 * pi 会话 id 合法值域判定（pi `assertValidSessionId` 同款正则，
 * dist/core/session-manager.js 正则字面量；语义登记 pi-semantics PS-52，verifiedWith 以该登记为准）：
 * 首尾字母数字，中间允许 `[A-Za-z0-9._-]`。真 sid 永不含 `:` ⇒ 本校验同时挡住
 * btw 线 id 误传（旧 `btw:<sid>` 两段式含冒号必拒——线 id 是 runtime/前端路由 key，不直传目录层）。
 */
export function isPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id)
}

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/**
 * btw 线会话目录：`<sessionStoreRoot>/<mainSid>/btw/`（session-store-layout-inversion
 * 布局反转后的终态；委托 shared getSessionBtwDir SSOT 公式，encodeCwd 层已消除——
 * mainSid 即分区键，线 jsonl 挂主树内域、随主树消亡）。
 *
 * 该目录同时是：pi `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` 的落点值、
 * 启动注册表扫描重建的遍历单元。
 *
 * mainSid 校验 fail-fast（路径注入防线）由 shared getSessionBtwDir 内建（同域校验，
 * 挡空串 / 路径分隔符 / `..` / 冒号（虚拟 id 误传）等一切非单层目录名输入）。
 */
export function getBtwThreadDir(mainSid: string): string {
  return sharedGetSessionBtwDir(mainSid)
}
