#!/usr/bin/env node
/**
 * check-artifact-dir-formula-sync.mjs —— 会话产物目录公式对拍守卫（公式双实现 +
 * sessionId 校验正则三方 + session 存储树段）。
 * （设计：chat-html-support 设计 §6.7 D7 / §11 检查点 8 / §10 u-artifacts（设计档案已随 .tmp
 *   清理，git 可追溯）；session 存储树扩展：session-store-layout-inversion 设计 §3.3 D1/D8）
 *
 * 背景：产物目录公式 `<dataDir>/ext-sessions/<sessionId>/artifacts` 有两份实现，跨包
 * 不可 import（extensions 包不依赖 @taiji/shared，且 shared getDataDir 对打包态 pi 进程
 * 直接 throw）：
 *   ① 权威侧 shared：`packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`
 *      （runtime / main 消费）；
 *   ② 镜像侧 system-prompt 扩展：`extensions/taiji/system-prompt/src/index.ts` 的
 *      `SESSION_STORE_DIR_SEGMENT` + `SESSION_ARTIFACTS_DIR_SEGMENT` +
 *      `resolveSessionArtifactsDir`（每 turn 注入产物目录绝对路径）。
 * 两侧任一漂移（段名改了 / 校验正则松紧不一）= agent 收到的路径与实际目录不符（写偏或
 * 预览 404）。跨包不可 import 不是豁免机检的理由——本守卫与 u1 的
 * check-capability-allowlist-sync.mjs 同为**源文件字面量对拍**形态（强度对称）：
 * 读双侧源文本，提取段名字面量与 sessionId 校验正则字面量，断言逐字一致。
 *
 * sessionId 校验正则另对拍第三源（2026-10-11 branch-review minor 残余补登）：runtime
 * `packages/runtime/src/infra/pi/pi-paths.ts` 的 `PI_SESSION_ID_PATTERN`（`const <名> =
 * /正则/` 声明形态，isPiSessionId 消费）——该正则决定产物目录名合法性判据（isPiSessionId
 * 挡虚拟 id / 路径注入），漂移时公式两侧一致也会判错目录名。三方断言 = shared ↔ 镜像 +
 * shared ↔ runtime（镜像 ↔ runtime 由等价传递覆盖）。shared 侧校验收敛在模块私有
 * helper assertPiSessionId（同名 `PI_SESSION_ID_PATTERN` 常量声明，不再内联在各推导
 * 函数内）。
 *
 * 第四组对拍（2026-10-14 branch-review minor 残余收编）：pi 会话树段——shared
 * `PI_SESSION_TREE_SEGMENTS`（跨进程消费 SSOT：main 不能 import runtime，树内包含
 * 判定如会话导出路径安全校验经它推导）↔ runtime pi-paths.ts 布局权威三函数
 * （getSessionsDir / getSubagentSessionDir / getBtwSessionsRoot）join 首段字面量。
 * 此前两处仅注释互指，runtime 改树名时 shared 常量漂移无红灯。
 * session-store-layout-inversion 扩展：常量末位段 'ext-sessions' ↔ shared
 * `SESSION_STORE_DIR_SEGMENT` 常量 ↔ 镜像侧同名常量，三方对拍（存储树根段一致性）。
 *
 * 【第五组断言（域 5，已启用）】base-tool-enhance 登记目录公式（换根随 u-ext-tasks-views
 * 同批接线）：`extensions/universal/base-tool-enhance/src/background/registry.ts` 的
 * `getRegistryPath` 现为新布局 `join(dataDir, SESSION_STORE_DIR_SEGMENT, sessionId,
 * BACKGROUND_TASKS_DIR_SEGMENT, 'registry.json')`（`<dataDir>/ext-sessions/<sid>/
 * background-tasks/`，dataDir = taiji 数据根）。对拍三字面量：树根段常量
 * SESSION_STORE_DIR_SEGMENT ↔ shared 同名常量；域段常量 BACKGROUND_TASKS_DIR_SEGMENT
 * ↔ shared `getSessionBackgroundTasksDir` 的 join 段；assertPiSessionId 的 sessionId
 * 校验正则 ↔ shared PI_SESSION_ID_PATTERN。任一漂移 = runtime 读侧（reaper /
 * BackgroundTaskService 经 shared 函数推导）与 extension 写侧落点错位（收殓读不到、
 * 任务清单空转）。
 *
 * 【第六组断言（域 6）】session-reader 导出文件公式：`extensions/universal/session-reader/
 * src/tool-handler.ts` 的 doExport 落盘段自述「零 shared 依赖……公式与 shared
 * getSessionViewPath 同字面镜像」，裸字面量形态（树根段 'ext-sessions' + 导出文件段
 * 'session-view.md' + 内联 sessionId 校验正则，与第一/五组的常量声明形态不同）。对拍三字面量
 * ↔ shared：树根段 ↔ SESSION_STORE_DIR_SEGMENT；文件段 ↔ `getSessionViewPath` 的 join 末段；
 * 内联正则 ↔ shared PI_SESSION_ID_PATTERN。任一漂移 = 导出 md 落到树外错误位置（随会话删除
 * 不回收、布局规约破坏）。
 *
 * 【第七组断言（域 9）】session-reader discovery 存储树公式：`extensions/universal/
 * session-reader/src/discovery/roots.ts` 自述「extension 不 import shared，常量同字面
 * 镜像」的读侧存储树推导（subagent 根 / records manifest 扫描根）。对拍三字面量 ↔ shared：
 * 树根段常量 SESSION_STORE_DIR_SEGMENT ↔ shared 同名常量；subagent 域段常量
 * SUBAGENTS_DIRNAME ↔ shared `getSessionSubagentsDir` 的 join 段；分区名校验正则
 * PI_SESSION_ID_PATTERN ↔ shared 同名常量。任一漂移 = session-reader 读侧与写侧
 * （subagent-core 经 shared 函数族落盘）错位——subagent 会话/记录发现为空（agent 面
 * family/find/result 静默丢数据）。
 *
 * 【第八组断言（域 10 扩展，dmg-r1-9）】归档镜像对拍扩为字段级 + D7 四字面：①簿记
 * schema 双解析器（shared parseArchiveLedger 两态完备校验 ↔ extension
 * parseArchiveLedgerText 消费子集）的字段级对拍——status 词表（shared
 * ARCHIVE_LEDGER_STATUSES 元组 ↔ extension 守卫字面量）与 summary.turns 成员名
 * （shared ArchiveSummaryTurn ↔ extension ArchiveLedgerTurn interface 逐字比对 + 两端
 * parse 块消费同名校验），词表/成员漂移时 extension 静默拒收全部簿记且无红灯；
 * ②D7 归档态返回正文四字面（ARCHIVED_HEADER / RESTORE_NOTE /
 * USER_ATTACHMENT_PLACEHOLDER / AGENT_NO_TEXT_PLACEHOLDER）的 renderer 预检正文
 * （agent-reference-format.ts）↔ extension 真实返回正文（archive-ledger.ts）逐字比对——
 * 漂移 = 用户预检与 agent 实见正文不一致且无红灯；③簿记 sessionId 同域正则（shared
 * session-store-paths.ts PI_SESSION_ID_PATTERN 权威〔paths.ts 经转发暴露〕↔ shared
 * archive.ts bundle 隔离镜像，dmg-r2-1 防线）逐字比对——镜像漂移 = 归档簿记解析侧与 pi
 * 会话 id 权威域收窄口径分裂，穿越形态 id 一经簿记固化即流向 assets/ 分区与 purge 删除原语。
 *
 * 【第九组断言（retry-rules ext-config 路径公式，dmg-r1-2）】同一相对路径
 * `config/retry-rules-ext-config.json` 四处独立承载的逐字对拍：runtime 写侧
 * `packages/runtime/src/services/remote-config/remote-retry-rules.ts` 的
 * `RETRY_RULES_CONFIG_REL`（join 单引号形态）↔ 引擎读侧
 * `packages/pi-subagent-cli/src/retry-rules-classification.ts` 同名常量（path.join
 * 双引号形态）↔ extension 读侧 `extensions/shared/llm-shared/src/config.ts` 的
 * getConfigPath 泛化公式（`join(getAgentDir(), "config", \`${pkg}-ext-config.json\`)`
 * 模板形态，pkg 实参 = retry-rules extension 的 CONFIG_PKG）↔
 * `extensions/universal/retry-rules/package.json` 的 taiji.startupConfig[0].path
 * （extension 启动占位写点）。任一漂移 = runtime 写的 ext-config 与两侧读侧落点错位
 * （retry-rules message_end 改写静默空转 + 引擎失败分类静默回落内置层）。
 *
 * 形态照搬 scripts/check-capability-allowlist-sync.mjs（读源文件文本、零散文解析、
 * 提取失败一律 fail、`--self-test` 纯函数自检）。
 *
 * 用法：
 *   node scripts/check-artifact-dir-formula-sync.mjs               # 常规校验（pre-commit 按路径触发）
 *   node scripts/check-artifact-dir-formula-sync.mjs --self-test   # 纯函数轻量自检
 *
 * 退出码：0 = 通过；1 = 存在 fail。
 */
import { join } from 'node:path'
import {
  fail,
  ok,
  guardExit,
  exitIfFailed,
  readSourcesOrFail,
  runSelfTest,
  repoRootFrom,
  isDirectRun,
  extractFunctionBlock,
} from './lib/guard-report.mjs'

const ROOT = repoRootFrom(import.meta.url)
const SHARED_PATHS_SRC = join(ROOT, 'packages', 'shared', 'src', 'paths.ts')
/** shared 存储树纯公式模块（SESSION_STORE_DIR_SEGMENT / PI_SESSION_ID_PATTERN 与
 *  存储树函数族 join 域段的提取源——公式本体自 C-ext-31 拆分起在此文件）。 */
const SHARED_STORE_SRC = join(ROOT, 'packages', 'shared', 'src', 'session-store-paths.ts')
const SYSTEM_PROMPT_SRC = join(ROOT, 'extensions', 'taiji', 'system-prompt', 'src', 'index.ts')
const RUNTIME_PI_PATHS_SRC = join(ROOT, 'packages', 'runtime', 'src', 'infra', 'pi', 'pi-paths.ts')
const BASE_TOOL_ENHANCE_REGISTRY_SRC = join(
  ROOT, 'extensions', 'universal', 'base-tool-enhance', 'src', 'background', 'registry.ts',
)
const SESSION_READER_TOOL_HANDLER_SRC = join(
  ROOT, 'extensions', 'universal', 'session-reader', 'src', 'tool-handler.ts',
)
const SESSION_READER_ARCHIVE_LEDGER_SRC = join(
  ROOT, 'extensions', 'universal', 'session-reader', 'src', 'discovery', 'archive-ledger.ts',
)
const RUNTIME_ARCHIVE_PATHS_SRC = join(
  ROOT, 'packages', 'runtime', 'src', 'services', 'archive', 'archive-paths.ts',
)
/** shared 归档簿记 schema 源文件（域 10 字段级对拍 shared 端：status 词表元组 + turn 成员名）。 */
export const SHARED_ARCHIVE_SCHEMA_SRC = join(ROOT, 'packages', 'shared', 'src', 'archive.ts')
/** renderer 归档态预检正文源文件（D7 四字面镜像的 renderer 端，bundle 隔离对侧）。 */
export const RENDERER_ARCHIVE_REFERENCE_SRC = join(
  ROOT, 'packages', 'renderer', 'src', 'components', 'archive', 'agent-reference-format.ts',
)

/** 权威侧函数名（shared）。 */
export const SHARED_FN = 'getSessionArtifactsDir'
/** 镜像侧函数名（system-prompt）。 */
export const MIRROR_FN = 'resolveSessionArtifactsDir'
/** 镜像侧段名常量名。 */
export const MIRROR_SEGMENT_CONST = 'SESSION_ARTIFACTS_DIR_SEGMENT'
/** 第三源（runtime pi-paths）sessionId 正则常量名。 */
export const RUNTIME_PATTERN_CONST = 'PI_SESSION_ID_PATTERN'
/** 第四组对拍：shared pi 会话树段 SSOT 常量名。 */
export const SHARED_TREE_CONST = 'PI_SESSION_TREE_SEGMENTS'
/** runtime 侧四棵树布局权威函数（数组位 ↔ shared 常量元素位，pi 宿主段）。 */
export const RUNTIME_TREE_FNS = ['getSessionsDir', 'getSubagentSessionDir', 'getBtwSessionsRoot', 'getArchiveDir']
/** 归档根布局函数名（runtime 侧，shared 树段 'archive' 的对位函数）。 */
export const RUNTIME_ARCHIVE_DIR_FN = 'getArchiveDir'
/** session-reader 归档目录名常量（不 import shared 的镜像字面量）。 */
export const SR_ARCHIVE_DIRNAME_CONST = 'ARCHIVE_DIRNAME'
/** shared 侧 status 词表元组常量名（域 10 字段级对拍第一轴）。 */
export const SHARED_ARCHIVE_STATUS_CONST = 'ARCHIVE_LEDGER_STATUSES'
/** shared 侧摘要 turn 接口锚（域 10 字段级对拍第二轴的 shared 端）。 */
export const SHARED_TURN_INTERFACE = 'interface ArchiveSummaryTurn'
/** extension 侧摘要 turn 接口锚（同上，extension 端）。 */
export const MIRROR_TURN_INTERFACE = 'interface ArchiveLedgerTurn'
/** D7 归档态返回正文四字面常量名（renderer ↔ extension 同名镜像，dmg-r1-9 对拍轴 ③）。 */
export const D7_LITERAL_CONSTS = ['ARCHIVED_HEADER', 'RESTORE_NOTE', 'USER_ATTACHMENT_PLACEHOLDER', 'AGENT_NO_TEXT_PLACEHOLDER']
/** session 存储树根段常量名（shared 与镜像侧同名，三方对拍：shared ↔ 镜像 ↔ 树段常量末位）。 */
export const STORE_SEGMENT_CONST = 'SESSION_STORE_DIR_SEGMENT'
/** shared 侧 sessionId 校验正则常量名（assertPiSessionId 消费，与 runtime 同名）。 */
export const SHARED_PATTERN_CONST = 'PI_SESSION_ID_PATTERN'

// ── 第五组对拍（域 5）符号 ──────────────────────────────────────────
/** 镜像侧源文件（base-tool-enhance registry）。 */
export const BTE_REGISTRY_SRC = BASE_TOOL_ENHANCE_REGISTRY_SRC
/** shared 侧后台任务域函数（域段对拍权威）。 */
export const SHARED_BG_TASKS_FN = 'getSessionBackgroundTasksDir'
/** 镜像侧树根段常量名（与 shared 同名）。 */
export const BTE_STORE_SEGMENT_CONST = 'SESSION_STORE_DIR_SEGMENT'
/** 镜像侧域段常量名。 */
export const BTE_DOMAIN_SEGMENT_CONST = 'BACKGROUND_TASKS_DIR_SEGMENT'
/** 镜像侧函数块锚点。 */
export const BTE_REGISTRY_FN_ANCHOR = 'export function getRegistryPath'
/** 镜像侧 sessionId 校验函数块锚点（正则所在函数）。 */
export const BTE_ASSERT_FN_ANCHOR = 'function assertPiSessionId'

// ── 第六组对拍（域 6）符号 ──────────────────────────────────────────
/** shared 侧会话导出文件函数（域段对拍权威）。 */
export const SHARED_VIEW_FN = 'getSessionViewPath'
/** 镜像侧源文件（session-reader tool-handler）。 */
export const SR_TOOL_HANDLER_SRC = SESSION_READER_TOOL_HANDLER_SRC
/** 镜像侧导出函数块锚点（落盘段所在函数）。 */
export const SR_VIEW_FN_ANCHOR = 'async function doExport('

// ── 第七组对拍（域 9）符号 ──────────────────────────────────────────
/** shared 侧 subagent 域函数（域段对拍权威）。 */
export const SHARED_SUBAGENTS_FN = 'getSessionSubagentsDir'
/** 镜像侧源文件（session-reader discovery roots）。 */
export const SR_DISCOVERY_ROOTS_SRC = join(
  ROOT, 'extensions', 'universal', 'session-reader', 'src', 'discovery', 'roots.ts',
)
/** 镜像侧树根段常量名（与 shared 同名）。 */
export const SR_DISCOVERY_STORE_SEGMENT_CONST = 'SESSION_STORE_DIR_SEGMENT'
/** 镜像侧 subagent 域段常量名。 */
export const SR_DISCOVERY_SUBAGENTS_CONST = 'SUBAGENTS_DIRNAME'
/** 镜像侧分区名校验正则常量名（与 shared 同名）。 */
export const SR_DISCOVERY_PATTERN_CONST = 'PI_SESSION_ID_PATTERN'

// ── 第九组对拍（retry-rules ext-config 路径公式，dmg-r1-2）符号 ──────────────
/** runtime 写侧源文件（remote-config 域 retry-rules，ext-config 唯一写方）。 */
export const RUNTIME_RETRY_RULES_SRC = join(
  ROOT, 'packages', 'runtime', 'src', 'services', 'remote-config', 'remote-retry-rules.ts',
)
/** 引擎读侧源文件（pi-subagent-cli 失败分类读侧，行为镜像复制体）。 */
export const ENGINE_RETRY_RULES_SRC = join(
  ROOT, 'packages', 'pi-subagent-cli', 'src', 'retry-rules-classification.ts',
)
/** extension 读侧泛化公式源文件（llm-shared getConfigPath，<pkg>-ext-config.json 模板）。 */
export const LLM_SHARED_CONFIG_SRC = join(ROOT, 'extensions', 'shared', 'llm-shared', 'src', 'config.ts')
/** retry-rules extension 包清单（taiji.startupConfig 启动占位写点声明）。 */
export const RETRY_RULES_EXT_PKG_JSON = join(ROOT, 'extensions', 'universal', 'retry-rules', 'package.json')
/** 写侧 / 引擎读侧同名的 ext-config 相对路径常量名。 */
export const RETRY_RULES_CONFIG_REL_CONST = 'RETRY_RULES_CONFIG_REL'
/** 本域 pkg 名（extension 读侧 loadConfig 实参 = 文件名前缀，与包目录名一致）。 */
export const RETRY_RULES_EXT_PKG_NAME = 'retry-rules'
/** retry-rules extension 启动占位写点的声明位（JSON 路径，报错文案用）。 */
export const RETRY_RULES_STARTUP_CONFIG_PATH = 'taiji.startupConfig[0].path'

/** 函数体截取锚点（含 `export function` 前缀，避免匹配到调用点）。 */
const SHARED_ANCHOR = `export function ${SHARED_FN}`
const MIRROR_ANCHOR = `export function ${MIRROR_FN}`

// 函数体截取原语与 POSIX resolve 镜像守卫同款收敛：scripts/lib/guard-report.mjs。
// re-export 保持单测（scripts/__tests__/check-artifact-dir-formula-sync.test.mjs）的既有 import 面。
export { extractFunctionBlock }

/** 从 shared 函数块提取 `join(getSessionStoreDir(…), sessionId, '<域段>')` 的域段字面量。 */
export function extractJoinSegment(blockText) {
  const m = blockText.match(/join\(getSessionStoreDir\([^)]*\),\s*sessionId,\s*'([^']+)'\)/)
  if (!m) return { error: `函数块内未找到 join(getSessionStoreDir(…), sessionId, '<域段>') 形态（字面量段名缺失 / 公式形态变化？）` }
  return { value: m[1] }
}

/** 从函数块提取 sessionId 校验正则字面量（`/..../.test(sessionId)` 形态，取正则字面量本体）。 */
export function extractSessionIdRegex(blockText) {
  const m = blockText.match(/(\/\^[^/\n]*\/)\.test\(sessionId\)/)
  if (!m) return { error: `函数块内未找到 /^.../.test(sessionId) 校验正则字面量` }
  return { value: m[1] }
}

/**
 * 从源文本提取 `const <name> = '<字面量>'` 的段名字面量（单/双引号均收——shared 与
 * system-prompt 镜像为单引号形态，base-tool-enhance 镜像按包内 prettier 为双引号）。
 */
export function extractConstLiteral(text, constName) {
  const m = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*(['"])([^'"]+)\\1`))
  if (!m) return { error: `未找到 const ${constName} = '<字面量>'（改名 / 形态变化？）` }
  return { value: m[2] }
}

/**
 * 从源文本提取 `const <name> = /正则字面量/` 的正则字面量本体（第三源 runtime
 * `PI_SESSION_ID_PATTERN` 的声明形态；行尾分号可选）。按行匹配（multiline `$`），
 * 正则字面量内含未转义 `/` 时提取失败一律 fail（守卫原则：形态变化宁可误报不可漏报）。
 */
export function extractConstRegex(text, constName) {
  const m = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*(/[^/\\n]+/)\\s*;?\\s*$`, 'm'))
  if (!m) return { error: `未找到 const ${constName} = /正则字面量/ 声明（改名 / 形态变化？）` }
  return { value: m[1] }
}

/**
 * 从源文本提取 `const <name> = ['a', 'b', …] as const` 的字符串元素组（第四组对拍：
 * shared `PI_SESSION_TREE_SEGMENTS` 的声明形态；元素缺失 / 形态变化一律 fail）。
 */
export function extractConstStringArray(text, constName) {
  const decl = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\[[^\\]]*\\])\\s*as\\s+const`))
  if (!decl) return { error: `未找到 const ${constName} = ['…'] as const 声明（改名 / 形态变化？）` }
  const items = decl[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1)) ?? []
  if (items.length === 0) return { error: `${constName} 数组内未提取到字符串字面量` }
  return { value: items }
}

/** 从 runtime 布局函数块提取 `join(getPiAgentDir(), '<树根段>', …)` 的首段字面量。 */
export function extractTreeRootSegment(blockText) {
  const m = blockText.match(/join\(getPiAgentDir\(\),\s*'([^']+)'/)
  if (!m) return { error: `函数块内未找到 join(getPiAgentDir(), '<树根段>', …) 形态（字面量缺失？）` }
  return { value: m[1] }
}

/**
 * 从 extension parseArchiveLedgerText 守卫行提取 status 词表字面量（域 10 字段级对拍：
 * `obj.status !== 'a' && obj.status !== 'b'` 形态，与 shared ARCHIVE_LEDGER_STATUSES
 * 元组逐字比对）。守卫改写（switch / includes 数组等）时提取失败一律 fail。
 */
export function extractMirrorStatusLiterals(text) {
  const m = text.match(/obj\.status !== '([^']+)' && obj\.status !== '([^']+)'/)
  if (!m) return { error: `未找到 obj.status !== '<词表值>' && obj.status !== '<词表值>' 守卫形态（status 词表判定改写？）` }
  return { value: [m[1], m[2]] }
}

/**
 * 从 TS interface 块提取两空格缩进成员名序列（域 10 字段级对拍：summary.turns 成员名
 * 在 shared 与 extension 两端逐字比对）。doc 注释行（` * ` 前缀）不匹配成员形态；
 * 成员零提取 = 形态变化报 error。
 */
export function extractInterfaceMembers(blockText) {
  const names = [...blockText.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1])
  if (names.length === 0) return { error: 'interface 块内未提取到成员声明（形态变化？）' }
  return { value: names }
}

/** 镜像侧函数块是否经两个段常量（根段 + 域段，而非重写字面量）拼路径。 */
export function mirrorUsesSegmentConst(blockText) {
  return /join\([^,]+,\s*SESSION_STORE_DIR_SEGMENT\s*,\s*sessionId\s*,\s*SESSION_ARTIFACTS_DIR_SEGMENT\)/.test(blockText)
}

// ── 第六组（域 6）提取器：session-reader 裸字面量形态（非常量声明，逐字锁定调用形态——
// 镜像公式结构变化时提取失败一律 fail，防对拍面静默失效）。

/** 从 doExport 函数块提取 `join(dirname(agentDir), '<树根段>', resolved.sessionId)` 的树根段字面量。 */
export function extractViewTreeRootSegment(blockText) {
  const m = blockText.match(/join\(dirname\(agentDir\),\s*(['"])([^'"]+)\1,\s*resolved\.sessionId\)/)
  if (!m) return { error: `函数块内未找到 join(dirname(agentDir), '<树根段>', resolved.sessionId) 形态（字面量段名缺失 / 公式形态变化？）` }
  return { value: m[2] }
}

/** 从 doExport 函数块提取 `join(outDir, '<导出文件段>')` 的文件段字面量。 */
export function extractViewFileSegment(blockText) {
  const m = blockText.match(/join\(outDir,\s*(['"])([^'"]+)\1\)/)
  if (!m) return { error: `函数块内未找到 join(outDir, '<导出文件段>') 形态（字面量段名缺失 / 公式形态变化？）` }
  return { value: m[2] }
}

/** 从 doExport 函数块提取内联 sessionId 校验正则（`/..../.test(resolved.sessionId)` 形态）。 */
export function extractViewSessionIdRegex(blockText) {
  const m = blockText.match(/(\/\^[^/\n]*\/)\.test\(resolved\.sessionId\)/)
  if (!m) return { error: `函数块内未找到 /^.../.test(resolved.sessionId) 校验正则字面量` }
  return { value: m[1] }
}

// ── 第九组（retry-rules 路径公式）提取器：runtime 写侧单引号 join / 引擎读侧双引号
// path.join（带分号）两形态均收；泛化模板 / startupConfig path 各一。提取失败一律 fail。

/**
 * 从源文本提取 `const <name> = (path.)?join('<段1>', '<段2>')` 双段字面量（单/双引号
 * 均收，分号可选——runtime 写侧与引擎读侧的声明形态）。返回 { configSeg, fileSeg }。
 */
export function extractConfigRelJoinSegments(text, constName) {
  const m = text.match(
    new RegExp(`const\\s+${constName}\\s*=\\s*(?:path\\.)?join\\((['"])([^'"]+)\\1,\\s*(['"])([^'"]+)\\3\\)\\s*;?`),
  )
  if (!m) return { error: `未找到 const ${constName} = (path.)join('<段1>', '<段2>') 形态（改名 / 公式形态变化？）` }
  return { value: { configSeg: m[2], fileSeg: m[4] } }
}

/**
 * 从 getConfigPath 函数块提取泛化公式 `join(getAgentDir(), '<段>', \`${param}<后缀>\`)`
 * （模板字面量形态——llm-shared 读侧按 pkg 参数化）。返回 { configSeg, pkgParam, fileSuffix }。
 */
export function extractConfigPathTemplateSegments(blockText) {
  const m = blockText.match(/join\(getAgentDir\(\),\s*(['"])([^'"]+)\1,\s*`\$\{(\w+)\}([^`]*)`\)/)
  if (!m) {
    return { error: `函数块内未找到 join(getAgentDir(), '<段>', \`\${pkg}<后缀>\`) 泛化公式形态（公式形态变化？）` }
  }
  return { value: { configSeg: m[2], pkgParam: m[3], fileSuffix: m[4] } }
}

/** 从 extension package.json 文本提取 taiji.startupConfig[0].path（JSON.parse 后取值，形态变化/缺失一律 error）。 */
export function extractStartupConfigPath(pkgJsonText) {
  let pkg
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch (e) {
    return { error: `package.json 非法 JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  const startupPath = pkg?.taiji?.startupConfig?.[0]?.path
  if (typeof startupPath !== 'string' || startupPath === '') {
    return { error: `${RETRY_RULES_STARTUP_CONFIG_PATH} 缺失或非字符串（startupConfig 形态变化？）` }
  }
  return { value: startupPath }
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────
// assert 骨架与尾部出口收敛在 scripts/lib/guard-report.mjs 的 runSelfTest；断言体按
// 对拍组拆三函数（公式双侧 / 树段三方 / 提取失败形态），单函数圈复杂度守低。

function selfTestFormulaPairing(assert) {
  const sharedText = `/**
 * session 存储树根段。
 */
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/**
 * pi 会话 id 同域校验正则（注释里的窄集 \`^[A-Za-z0-9_-]+$\` 形态不干扰提取）。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function getSessionArtifactsDir(sessionId: string, dataDir?: string): string {
  // 校验注释：允许 [A-Za-z0-9._-]
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'artifacts')
}
export function nextOne() {}`

  const mirrorText = `export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

export const SESSION_ARTIFACTS_DIR_SEGMENT = 'artifacts'

/**
 * 镜像推导。
 */
export function resolveSessionArtifactsDir(sessionId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(\`invalid sessionId: \${sessionId}\`)
  }
  return path.join(resolveDataDir(), SESSION_STORE_DIR_SEGMENT, sessionId, SESSION_ARTIFACTS_DIR_SEGMENT)
}
function other() {}`

  const runtimeText = `/**
 * pi 会话 id 合法值域判定。
 */
export function isPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id)
}

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`

  const sb = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  assert(sb.text && sb.text.includes('getSessionArtifactsDir') && !sb.text.includes('nextOne'), '函数块截取到行首 } 为止')
  assert(extractJoinSegment(sb.text).value === 'artifacts', 'shared join 域段提取（注释里的窄集正则不干扰）')
  assert(
    extractConstRegex(sharedText, SHARED_PATTERN_CONST).value === '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/',
    'shared sessionId 正则常量提取（assertPiSessionId 收敛形态；注释内反引号形态不误提取）',
  )
  assert(extractConstLiteral(sharedText, STORE_SEGMENT_CONST).value === 'ext-sessions', 'shared 树根段常量提取')

  const mb = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  assert(extractSessionIdRegex(mb.text).value === extractConstRegex(sharedText, SHARED_PATTERN_CONST).value, '两侧正则一致（样例）')
  assert(extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST).value === 'artifacts', '常量域段字面量提取')
  assert(extractConstLiteral(mirrorText, STORE_SEGMENT_CONST).value === 'ext-sessions', '镜像树根段常量提取')
  assert(mirrorUsesSegmentConst(mb.text), '镜像侧 join 经根段+域段两常量拼路径')

  assert(extractConstRegex(runtimeText, RUNTIME_PATTERN_CONST).value === extractSessionIdRegex(mb.text).value, '第三源 const 正则声明提取（.test 调用行不误匹配）')
  assert(extractConstRegex('const OTHER = /x/;', RUNTIME_PATTERN_CONST).error !== undefined, '常量名不符报 error')
}

function selfTestTreePairing(assert) {
  const treeSharedText = `export const PI_SESSION_TREE_SEGMENTS = ['sessions', 'subagents', 'btw', 'archive', 'ext-sessions'] as const
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'`
  const treeRuntimeText = `export function getSessionsDir(): string {
  return join(getPiAgentDir(), 'sessions')
}

export function getSubagentSessionDir(mainCwd: string): string {
  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')
}

export function getBtwSessionsRoot(): string {
  return join(getPiAgentDir(), 'btw')
}

export function getArchiveDir(): string {
  return join(getPiAgentDir(), 'archive')
}`
  const treeSegs = extractConstStringArray(treeSharedText, SHARED_TREE_CONST)
  assert(treeSegs.value && treeSegs.value.join(',') === 'sessions,subagents,btw,archive,ext-sessions', '树段常量数组元素提取（含存储树末位段）')
  assert(
    compareTreeSegmentsShape(treeSegs.value, RUNTIME_TREE_FNS.length, 'ext-sessions').error === undefined,
    '树段形态断言（宿主段数 + 存储树末位段）通过（样例）',
  )
  assert(
    compareTreeSegmentsShape(['sessions', 'subagents', 'btw'], RUNTIME_TREE_FNS.length, 'ext-sessions').error !== undefined,
    '缺存储树末位段报 error',
  )
  for (const [i, fn] of RUNTIME_TREE_FNS.entries()) {
    const b = extractFunctionBlock(treeRuntimeText, `export function ${fn}`)
    assert(!b.error && extractTreeRootSegment(b.text).value === treeSegs.value[i], `pi 宿主树根段对位提取（${fn}）`)
  }
  assert(extractConstStringArray('const OTHER = 1', SHARED_TREE_CONST).error !== undefined, '树段常量缺失报 error')
  assert(extractTreeRootSegment('return join(other(), x)').error !== undefined, '树根段字面量缺失报 error')
}

function selfTestExtractionErrors(assert) {
  const sharedText = `export function getSessionArtifactsDir(sessionId: string): string {
  return join(getDataDir(), 'artifacts', sessionId)
}`
  assert(extractFunctionBlock(sharedText, 'export function missing').error !== undefined, '函数缺失报 error')
  assert(extractJoinSegment('return join(x, y, sessionId)').error !== undefined, '无字面量段名报 error')
  assert(extractSessionIdRegex('const x = 1').error !== undefined, '无校验正则报 error')
}

/** 第五组（域 5）纯函数自检：双引号常量提取 + registry 函数块三字面量对拍。 */
function selfTestBaseToolEnhanceRegistry(assert) {
  const sharedText = `export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function getSessionBackgroundTasksDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'background-tasks')
}`

  // 镜像侧双引号形态（base-tool-enhance 包 prettier 风格）
  const registryText = `export const SESSION_STORE_DIR_SEGMENT = "ext-sessions"

export const BACKGROUND_TASKS_DIR_SEGMENT = "background-tasks"

function assertPiSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		throw new Error(\`invalid sessionId: \${sessionId}\`)
	}
}

export function getRegistryPath(dataDir: string, sessionId: string): string {
	assertPiSessionId(sessionId);
	return join(dataDir, SESSION_STORE_DIR_SEGMENT, sessionId, BACKGROUND_TASKS_DIR_SEGMENT, "registry.json");
}
function other() {}`

  assert(extractConstLiteral(registryText, BTE_STORE_SEGMENT_CONST).value === 'ext-sessions', '镜像双引号树根段常量提取')
  assert(extractConstLiteral(registryText, BTE_DOMAIN_SEGMENT_CONST).value === 'background-tasks', '镜像双引号域段常量提取')
  const sharedBgBlock = extractFunctionBlock(sharedText, `export function ${SHARED_BG_TASKS_FN}`)
  assert(extractJoinSegment(sharedBgBlock.text).value === 'background-tasks', 'shared 后台任务域段提取')
  const assertBlock = extractFunctionBlock(registryText, BTE_ASSERT_FN_ANCHOR)
  assert(
    extractSessionIdRegex(assertBlock.text).value ===
      extractConstRegex(sharedText, SHARED_PATTERN_CONST).value,
    '域 5 两侧 sessionId 正则一致（样例）',
  )
  assert(extractFunctionBlock(registryText, BTE_REGISTRY_FN_ANCHOR).error === undefined, '镜像 getRegistryPath 函数块截取')
  assert(extractConstLiteral(registryText, 'MISSING_CONST').error !== undefined, '镜像常量缺失报 error')
}

/** 第六组（域 6）纯函数自检：session-reader 裸字面量三字面量对拍提取。 */
function selfTestSessionReaderView(assert) {
  const sharedText = `export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function getSessionViewPath(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'session-view.md')
}`

  // 镜像侧裸字面量形态（tool-handler.ts doExport 落盘段）
  const handlerText = `async function doExport(
  params: SessionReadParams,
  agentDir: string,
): Promise<ToolResult> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(resolved.sessionId)) {
    throw err('导出拒绝')
  }
  const outDir = join(dirname(agentDir), 'ext-sessions', resolved.sessionId)
  const outPath = join(outDir, 'session-view.md')
  await mkdir(outDir, { recursive: true })
}
function other() {}`

  const sharedViewBlock = extractFunctionBlock(sharedText, `export function ${SHARED_VIEW_FN}`)
  assert(extractJoinSegment(sharedViewBlock.text).value === 'session-view.md', 'shared 会话导出文件段提取')
  const viewBlock = extractFunctionBlock(handlerText, SR_VIEW_FN_ANCHOR)
  assert(extractViewTreeRootSegment(viewBlock.text).value === 'ext-sessions', '镜像树根段提取（dirname(agentDir) 基址形态）')
  assert(extractViewFileSegment(viewBlock.text).value === 'session-view.md', '镜像导出文件段提取')
  assert(
    extractViewSessionIdRegex(viewBlock.text).value === extractConstRegex(sharedText, SHARED_PATTERN_CONST).value,
    '域 6 两侧 sessionId 正则一致（样例）',
  )
  assert(extractViewTreeRootSegment('const outDir = join(dataRoot(), "ext-sessions", id)').error !== undefined, '镜像树根段形态不符报 error（调用形态锁定防漏检）')
  assert(extractViewFileSegment('const outPath = join(target, "x.md")').error !== undefined, '镜像文件段变量名不符报 error')
  assert(extractViewSessionIdRegex('if (!/^x$/.test(sessionId))').error !== undefined, '镜像正则 .test 目标不符报 error')
}

/** 第七组（域 9）纯函数自检：session-reader discovery 常量镜像三字面量对拍提取。 */
function selfTestSessionReaderDiscovery(assert) {
  const sharedText = `export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function getSessionSubagentsDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'subagents')
}`

  // 镜像侧形态（roots.ts 常量声明：树根段 / subagent 域段 / 分区名正则）
  const rootsText = `const SESSIONS_DIRNAME = 'sessions'
const SUBAGENTS_DIRNAME = 'subagents'

const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`

  const sharedSubagentsBlock = extractFunctionBlock(sharedText, `export function ${SHARED_SUBAGENTS_FN}`)
  assert(extractJoinSegment(sharedSubagentsBlock.text).value === 'subagents', 'shared subagent 域段提取')
  assert(extractConstLiteral(rootsText, SR_DISCOVERY_STORE_SEGMENT_CONST).value === 'ext-sessions', '镜像 discovery 树根段常量提取')
  assert(extractConstLiteral(rootsText, SR_DISCOVERY_SUBAGENTS_CONST).value === 'subagents', '镜像 discovery subagent 域段常量提取')
  assert(
    extractConstRegex(rootsText, SR_DISCOVERY_PATTERN_CONST).value ===
      extractConstRegex(sharedText, SHARED_PATTERN_CONST).value,
    '域 9 两侧 sessionId 正则一致（样例）',
  )
  assert(extractConstLiteral(rootsText, 'MISSING_CONST').error !== undefined, '镜像 discovery 常量缺失报 error')
}

/** 域 10 扩展（dmg-r1-9）纯函数自检：status 词表 / turn 成员名 / D7 四字面三对拍轴的提取。 */
function selfTestArchiveMirrorFields(assert) {
  const sharedSchemaText = `export const ARCHIVE_LEDGER_STATUSES = [
  'staging',
  'archived',
] as const satisfies readonly ArchiveLedgerStatus[]

export interface ArchiveSummaryTurn { // oe-exempt 注释不干扰成员提取
  /**
   * doc 注释行（asterisk 前缀）不匹配成员形态。
   */
  user: string
  agent: string | null
}

function parseSummaryTurn(raw: unknown, index: number): ArchiveSummaryTurn | string {
  const user = (raw as Record<string, unknown>).user
  const agent = (raw as Record<string, unknown>).agent
  return { user, agent }
}
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
function other() {}`

  const ledgerText = `export interface ArchiveLedgerTurn {
  user: string
  agent: string | null
}

const ARCHIVED_HEADER = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要'
const RESTORE_NOTE = '注: 如需完整历史，请让用户在归档列表中恢复该会话。'
const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'
const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'

function parseArchiveLedgerText(text: string) {
  if (obj.status !== 'staging' && obj.status !== 'archived') return undefined
}
function parseSummary(raw: unknown) {
  if (typeof obj.user !== 'string') return undefined
  if (obj.agent !== null && typeof obj.agent !== 'string') return undefined
}
function other() {}`

  const rendererText = `const ARCHIVED_HEADER = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要'
const RESTORE_NOTE = '注: 如需完整历史，请让用户在归档列表中恢复该会话。'
const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'
const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'`

  assert(
    JSON.stringify(extractConstStringArray(sharedSchemaText, SHARED_ARCHIVE_STATUS_CONST).value) === '["staging","archived"]',
    'shared status 词表元组提取（as const satisfies 形态）',
  )
  assert(
    JSON.stringify(extractMirrorStatusLiterals(ledgerText).value) === '["staging","archived"]',
    '镜像 status 守卫字面量提取',
  )
  assert(extractMirrorStatusLiterals("if (obj.status === 'staging') return").error !== undefined, '镜像 status 守卫形态不符报 error')
  assert(
    JSON.stringify(extractInterfaceMembers(extractFunctionBlock(sharedSchemaText, SHARED_TURN_INTERFACE).text).value) === '["user","agent"]',
    'shared turn 接口成员提取（doc 注释不误提取）',
  )
  assert(
    JSON.stringify(extractInterfaceMembers(extractFunctionBlock(ledgerText, MIRROR_TURN_INTERFACE).text).value) ===
      JSON.stringify(extractInterfaceMembers(extractFunctionBlock(sharedSchemaText, SHARED_TURN_INTERFACE).text).value),
    '两侧 turn 成员名一致（样例）',
  )
  assert(extractInterfaceMembers('interface X {\n  member\n}').error !== undefined, 'interface 成员零提取报 error')
  const sharedPatternText = `const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`
  assert(
    extractConstRegex(sharedSchemaText, SHARED_PATTERN_CONST).value === extractConstRegex(sharedPatternText, SHARED_PATTERN_CONST).value,
    '域 10 簿记 sessionId 正则两侧一致（shared paths 权威 ↔ archive 镜像，样例）',
  )
  for (const name of D7_LITERAL_CONSTS) {
    assert(
      extractConstLiteral(ledgerText, name).value === extractConstLiteral(rendererText, name).value,
      `D7 字面 ${name} 两侧一致（样例）`,
    )
  }
}

/** 第九组（retry-rules 路径公式，dmg-r1-2）纯函数自检：双形态 join 常量 / 泛化模板 / startupConfig path 提取。 */
function selfTestRetryRulesConfigFormula(assert) {
  const runtimeText = `const ${RETRY_RULES_CONFIG_REL_CONST} = join('config', 'retry-rules-ext-config.json')`
  const engineText = `const ${RETRY_RULES_CONFIG_REL_CONST} = path.join("config", "retry-rules-ext-config.json");`

  const runtimeSegs = extractConfigRelJoinSegments(runtimeText, RETRY_RULES_CONFIG_REL_CONST)
  assert(
    runtimeSegs.value && runtimeSegs.value.configSeg === 'config' && runtimeSegs.value.fileSeg === 'retry-rules-ext-config.json',
    'runtime 写侧单引号 join 双段提取',
  )
  const engineSegs = extractConfigRelJoinSegments(engineText, RETRY_RULES_CONFIG_REL_CONST)
  assert(
    engineSegs.value && engineSegs.value.configSeg === 'config' && engineSegs.value.fileSeg === 'retry-rules-ext-config.json',
    '引擎读侧 path.join 双引号带分号形态提取',
  )
  assert(extractConfigRelJoinSegments('const OTHER = join("a", "b")', RETRY_RULES_CONFIG_REL_CONST).error !== undefined, '常量名不符报 error')
  assert(
    extractConfigRelJoinSegments(`const ${RETRY_RULES_CONFIG_REL_CONST} = join(cfgDir, 'x.json')`, RETRY_RULES_CONFIG_REL_CONST).error !== undefined,
    '首段非字面量报 error（宁可误报不可漏报）',
  )

  const llmSharedBlock = `export function getConfigPath(pkgName: string): string {
\treturn join(getAgentDir(), "config", \`\${pkgName}-ext-config.json\`);
}`
  const template = extractConfigPathTemplateSegments(llmSharedBlock)
  assert(
    template.value && template.value.configSeg === 'config' && template.value.pkgParam === 'pkgName' && template.value.fileSuffix === '-ext-config.json',
    'getConfigPath 泛化模板三段提取（tab 缩进函数块内）',
  )
  assert(extractConfigPathTemplateSegments('return join(getAgentDir(), "config", file)').error !== undefined, '泛化公式非模板形态报 error')

  const pkgJson = JSON.stringify({ taiji: { startupConfig: [{ path: 'config/retry-rules-ext-config.json' }] } })
  assert(extractStartupConfigPath(pkgJson).value === 'config/retry-rules-ext-config.json', 'startupConfig path 提取')
  assert(extractStartupConfigPath('{}').error !== undefined, 'startupConfig 缺席报 error')
  assert(extractStartupConfigPath('{bad json').error !== undefined, '非法 JSON 报 error')
}

function selfTestCases(assert) {
  selfTestFormulaPairing(assert)
  selfTestTreePairing(assert)
  selfTestExtractionErrors(assert)
  selfTestBaseToolEnhanceRegistry(assert)
  selfTestSessionReaderView(assert)
  selfTestSessionReaderDiscovery(assert)
  selfTestArchiveMirrorFields(assert)
  selfTestRetryRulesConfigFormula(assert)
}

if (process.argv.includes('--self-test')) runSelfTest('artifact-dir-formula-sync', selfTestCases)

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

// 呈报骨架（✓/✗ 行 + 失败旗标 + 汇总出口 + 源文件读取 + self-test 骨架）与 scripts 家族
// 共享：scripts/lib/guard-report.mjs

/** 提取阶段①：双侧公式函数块（shared / system-prompt 镜像）。失败 → ✗ + fail-fast。 */
function extractFormulaBlocksOrFail(sharedText, mirrorText) {
  const sharedBlock = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  const mirrorBlock = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  if (sharedBlock.error) fail(`权威侧 ${SHARED_FN} 提取失败: ${sharedBlock.error}`)
  if (mirrorBlock.error) fail(`镜像侧 ${MIRROR_FN} 提取失败: ${mirrorBlock.error}`)
  exitIfFailed('产物目录公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')
  return { sharedBlock, mirrorBlock }
}

/** 提取阶段②：公式对拍全部字面量（域段 ×2 / 树根段 ×2 / sessionId 正则 ×3 源）。失败 → ✗ + fail-fast。 */
function extractFormulaLiteralsOrFail(storeText, sharedBlock, mirrorBlock, mirrorText, runtimeText) {
  const extracted = {
    sharedSegment: extractJoinSegment(sharedBlock.text),
    sharedStoreSegment: extractConstLiteral(storeText, STORE_SEGMENT_CONST),
    sharedRegex: extractConstRegex(storeText, SHARED_PATTERN_CONST),
    mirrorStoreSegment: extractConstLiteral(mirrorText, STORE_SEGMENT_CONST),
    mirrorSegment: extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST),
    mirrorRegex: extractSessionIdRegex(mirrorBlock.text),
    runtimeRegex: extractConstRegex(runtimeText, RUNTIME_PATTERN_CONST),
  }
  for (const [label, r] of [
    ['shared join 域段', extracted.sharedSegment],
    [`shared 树根段常量 ${STORE_SEGMENT_CONST}`, extracted.sharedStoreSegment],
    [`shared sessionId 正则常量 ${SHARED_PATTERN_CONST}`, extracted.sharedRegex],
    [`镜像树根段常量 ${STORE_SEGMENT_CONST}`, extracted.mirrorStoreSegment],
    [`镜像常量 ${MIRROR_SEGMENT_CONST}`, extracted.mirrorSegment],
    ['镜像 sessionId 正则', extracted.mirrorRegex],
    [`runtime ${RUNTIME_PATTERN_CONST} 正则`, extracted.runtimeRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('产物目录公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')
  return extracted
}

/** ① 域段字面量一致（shared join ↔ 镜像常量）。 */
function compareSegmentLiteral(sharedSegment, mirrorSegment) {
  if (sharedSegment === mirrorSegment) {
    ok(`域段字面量一致（'${sharedSegment}'，shared join ↔ 镜像常量）`)
  } else {
    fail(
      `域段字面量漂移: shared='${sharedSegment}' vs 镜像='${mirrorSegment}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_FN} 与 ${SYSTEM_PROMPT_SRC} 的 ${MIRROR_SEGMENT_CONST}`,
    )
  }
}

/** ①b 存储树根段字面量一致（shared 常量 ↔ 镜像常量）。 */
function compareStoreSegmentLiteral(sharedStoreSegment, mirrorStoreSegment) {
  if (sharedStoreSegment === mirrorStoreSegment) {
    ok(`存储树根段字面量一致（'${sharedStoreSegment}'，shared ${STORE_SEGMENT_CONST} ↔ 镜像）`)
  } else {
    fail(
      `存储树根段字面量漂移: shared='${sharedStoreSegment}' vs 镜像='${mirrorStoreSegment}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 与 ${SYSTEM_PROMPT_SRC} 的 ${STORE_SEGMENT_CONST}`,
    )
  }
}

/** ② + ②b：sessionId 校验正则字面量三方一致（shared ↔ 镜像；shared ↔ runtime）。 */
function compareSessionIdRegexes(sharedRegex, mirrorRegex, runtimeRegex) {
  if (sharedRegex === mirrorRegex) {
    ok(`sessionId 校验正则字面量一致（${sharedRegex}）`)
  } else {
    fail(
      `sessionId 校验正则漂移: shared=${sharedRegex} vs 镜像=${mirrorRegex}` +
        `——恢复动作：人工核对两侧正则（规则须与 isPiSessionId 同域：允许 . 与 _，禁 :）`,
    )
  }
  // 镜像 ↔ runtime 由等价传递覆盖；该正则同时是产物目录名合法性判据 isPiSessionId 的源头，
  // 漂移即判错目录名
  if (sharedRegex === runtimeRegex) {
    ok(`runtime ${RUNTIME_PATTERN_CONST} 与 shared sessionId 正则一致（${runtimeRegex}）`)
  } else {
    fail(
      `sessionId 校验正则漂移: shared=${sharedRegex} vs runtime ${RUNTIME_PATTERN_CONST}=${runtimeRegex}` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${RUNTIME_PI_PATHS_SRC} 的 ${RUNTIME_PATTERN_CONST}` +
        `（同域规则：首尾字母数字，中间允许 [A-Za-z0-9._-]，禁 :）`,
    )
  }
}

/** ③ 镜像侧须经根段+域段两常量拼路径（防常量保留而函数内重写死字面量）。 */
function checkMirrorConstUsage(mirrorBlock) {
  if (mirrorUsesSegmentConst(mirrorBlock.text)) {
    ok(`镜像 ${MIRROR_FN} 经 ${STORE_SEGMENT_CONST} + ${MIRROR_SEGMENT_CONST} 拼路径（无旁路字面量）`)
  } else {
    fail(
      `镜像 ${MIRROR_FN} 未经段常量拼路径` +
        `——恢复动作：改为 path.join(resolveDataDir(), ${STORE_SEGMENT_CONST}, sessionId, ${MIRROR_SEGMENT_CONST})` +
        '（重写死字面量会被本守卫漏掉漂移）',
    )
  }
}

/**
 * ④ pi 会话树段对拍：shared PI_SESSION_TREE_SEGMENTS（跨进程消费 SSOT）↔ runtime
 * 布局权威三函数的树根段字面量——runtime 改树名而 shared 常量未跟 = 树内包含判定
 * （如会话导出路径安全校验）跨进程判据漂移。末位段为 taiji 存储树根段（基址
 * `<dataDir>`，非 piAgentDir），与 shared `SESSION_STORE_DIR_SEGMENT` 一致。
 */

/**
 * 树段数组形态断言（纯函数，self-test 直测）：前 `hostSegmentCount` 位为 pi 宿主段，
 * 末位须为存储树根段 `storeSegment`。
 */
export function compareTreeSegmentsShape(treeSegments, hostSegmentCount, storeSegment) {
  if (treeSegments.length < hostSegmentCount + 1 || treeSegments[treeSegments.length - 1] !== storeSegment) {
    return {
      error:
        `${SHARED_TREE_CONST} 须含 pi 宿主 ${hostSegmentCount} 段 + 末位存储树根段 '${storeSegment}'，` +
        `实际 [${treeSegments.join(', ')}]——恢复动作：树布局增删时同批更新 shared 常量与本守卫`,
    }
  }
  return { value: true }
}

/** ④ 逐步（循环体）：提取 runtime 布局函数树根段，与 shared 常量对位比对。 */
function compareTreeRootSegment(runtimeText, treeSegments, i, fn) {
  const block = extractFunctionBlock(runtimeText, `export function ${fn}`)
  if (block.error) {
    fail(`runtime ${fn} 提取失败: ${block.error}`)
    return
  }
  const seg = extractTreeRootSegment(block.text)
  if (seg.error) {
    fail(`runtime ${fn} 树根段提取失败: ${seg.error}`)
  } else if (seg.value !== treeSegments[i]) {
    fail(
      `pi 会话树段漂移: ${SHARED_TREE_CONST}[${i}]='${treeSegments[i]}' vs runtime ${fn}()='${seg.value}'` +
        `——恢复动作：树名变更时同批改 ${SHARED_PATHS_SRC} 常量与 ${RUNTIME_PI_PATHS_SRC} 布局函数`,
    )
  } else {
    ok(`pi 会话树段一致（runtime ${fn}() → '${seg.value}'，对应 ${SHARED_TREE_CONST}[${i}]）`)
  }
}

function compareTreeSegments(sharedText, runtimeText, sharedStoreSegment) {
  const treeSegments = extractConstStringArray(sharedText, SHARED_TREE_CONST)
  if (treeSegments.error) {
    fail(`shared ${SHARED_TREE_CONST} 提取失败: ${treeSegments.error}`)
    return
  }
  const shape = compareTreeSegmentsShape(treeSegments.value, RUNTIME_TREE_FNS.length, sharedStoreSegment)
  if (shape.error) {
    fail(shape.error)
    return
  }
  for (const [i, fn] of RUNTIME_TREE_FNS.entries()) {
    compareTreeRootSegment(runtimeText, treeSegments.value, i, fn)
  }
  ok(`存储树末位段一致（${SHARED_TREE_CONST} 末位 ↔ shared ${STORE_SEGMENT_CONST}='${sharedStoreSegment}'）`)
}

/**
 * ⑤ base-tool-enhance registry 公式对拍（域 5，u-ext-tasks-views 换根同批启用）：树根段 /
 * 域段 / sessionId 校验正则三字面量逐字一致——runtime 读侧经 shared 函数推导，镜像漂移
 * 即收殓读不到、任务清单空转。
 */
function compareBaseToolEnhanceRegistry(storeText, registryText, sharedStoreSegment, sharedRegex) {
  const registryBlock = extractFunctionBlock(registryText, BTE_REGISTRY_FN_ANCHOR)
  const assertBlock = extractFunctionBlock(registryText, BTE_ASSERT_FN_ANCHOR)
  const sharedBgTasksBlock = extractFunctionBlock(storeText, `export function ${SHARED_BG_TASKS_FN}`)
  if (registryBlock.error) fail(`镜像 ${BTE_REGISTRY_FN_ANCHOR} 提取失败: ${registryBlock.error}`)
  if (assertBlock.error) fail(`镜像 ${BTE_ASSERT_FN_ANCHOR} 提取失败: ${assertBlock.error}`)
  if (sharedBgTasksBlock.error) fail(`shared ${SHARED_BG_TASKS_FN} 提取失败: ${sharedBgTasksBlock.error}`)
  exitIfFailed('域 5 registry 公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')

  const extracted = {
    bteStoreSegment: extractConstLiteral(registryText, BTE_STORE_SEGMENT_CONST),
    bteDomainSegment: extractConstLiteral(registryText, BTE_DOMAIN_SEGMENT_CONST),
    sharedDomainSegment: extractJoinSegment(sharedBgTasksBlock.text),
    bteRegex: extractSessionIdRegex(assertBlock.text),
  }
  for (const [label, r] of [
    [`镜像树根段常量 ${BTE_STORE_SEGMENT_CONST}`, extracted.bteStoreSegment],
    [`镜像域段常量 ${BTE_DOMAIN_SEGMENT_CONST}`, extracted.bteDomainSegment],
    [`shared ${SHARED_BG_TASKS_FN} join 域段`, extracted.sharedDomainSegment],
    ['镜像 sessionId 校验正则', extracted.bteRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('域 5 registry 公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  if (extracted.bteStoreSegment.value === sharedStoreSegment) {
    ok(`域 5 存储树根段一致（'${extracted.bteStoreSegment.value}'，shared ↔ base-tool-enhance 镜像）`)
  } else {
    fail(
      `域 5 存储树根段漂移: shared='${sharedStoreSegment}' vs 镜像='${extracted.bteStoreSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${STORE_SEGMENT_CONST} 与 ${BTE_REGISTRY_SRC} 的 ${BTE_STORE_SEGMENT_CONST}`,
    )
  }
  if (extracted.bteDomainSegment.value === extracted.sharedDomainSegment.value) {
    ok(`域 5 后台任务域段一致（'${extracted.bteDomainSegment.value}'，shared ${SHARED_BG_TASKS_FN} ↔ 镜像常量）`)
  } else {
    fail(
      `域 5 域段漂移: shared='${extracted.sharedDomainSegment.value}' vs 镜像='${extracted.bteDomainSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${SHARED_BG_TASKS_FN} 与 ${BTE_REGISTRY_SRC} 的 ${BTE_DOMAIN_SEGMENT_CONST}`,
    )
  }
  if (extracted.bteRegex.value === sharedRegex) {
    ok(`域 5 sessionId 校验正则一致（${extracted.bteRegex.value}）`)
  } else {
    fail(
      `域 5 sessionId 校验正则漂移: shared=${sharedRegex} vs 镜像=${extracted.bteRegex.value}` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${BTE_REGISTRY_SRC} 的 ${BTE_ASSERT_FN_ANCHOR}`,
    )
  }
}

/**
 * ⑥ session-reader 导出公式对拍（域 6）：doExport 落盘段树根段 / 导出文件段 / 内联
 * sessionId 校验正则三字面量与 shared 逐字一致——导出落点两侧各有一份推导（shared 侧
 * 供 runtime/测试消费，镜像侧供 extension 写入），漂移即导出 md 落到树外错误位置
 * （随会话删除不回收、布局规约破坏）。
 */
function compareSessionReaderView(storeText, handlerText, sharedStoreSegment, sharedRegex) {
  const viewBlock = extractFunctionBlock(handlerText, SR_VIEW_FN_ANCHOR)
  const sharedViewBlock = extractFunctionBlock(storeText, `export function ${SHARED_VIEW_FN}`)
  if (viewBlock.error) fail(`镜像 ${SR_VIEW_FN_ANCHOR} 提取失败: ${viewBlock.error}`)
  if (sharedViewBlock.error) fail(`shared ${SHARED_VIEW_FN} 提取失败: ${sharedViewBlock.error}`)
  exitIfFailed('域 6 session-view 公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')

  const extracted = {
    srTreeSegment: extractViewTreeRootSegment(viewBlock.text),
    srFileSegment: extractViewFileSegment(viewBlock.text),
    sharedFileSegment: extractJoinSegment(sharedViewBlock.text),
    srRegex: extractViewSessionIdRegex(viewBlock.text),
  }
  for (const [label, r] of [
    ['镜像树根段字面量', extracted.srTreeSegment],
    ['镜像导出文件段字面量', extracted.srFileSegment],
    [`shared ${SHARED_VIEW_FN} join 文件段`, extracted.sharedFileSegment],
    ['镜像 sessionId 校验正则', extracted.srRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('域 6 session-view 公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  if (extracted.srTreeSegment.value === sharedStoreSegment) {
    ok(`域 6 存储树根段一致（'${extracted.srTreeSegment.value}'，shared ↔ session-reader 镜像）`)
  } else {
    fail(
      `域 6 存储树根段漂移: shared='${sharedStoreSegment}' vs 镜像='${extracted.srTreeSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${STORE_SEGMENT_CONST} 与 ${SR_TOOL_HANDLER_SRC} 的 doExport 落盘段`,
    )
  }
  if (extracted.srFileSegment.value === extracted.sharedFileSegment.value) {
    ok(`域 6 导出文件段一致（'${extracted.srFileSegment.value}'，shared ${SHARED_VIEW_FN} ↔ 镜像字面量）`)
  } else {
    fail(
      `域 6 导出文件段漂移: shared='${extracted.sharedFileSegment.value}' vs 镜像='${extracted.srFileSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${SHARED_VIEW_FN} 与 ${SR_TOOL_HANDLER_SRC} 的 doExport 落盘段`,
    )
  }
  if (extracted.srRegex.value === sharedRegex) {
    ok(`域 6 sessionId 校验正则一致（${extracted.srRegex.value}）`)
  } else {
    fail(
      `域 6 sessionId 校验正则漂移: shared=${sharedRegex} vs 镜像=${extracted.srRegex.value}` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${SR_TOOL_HANDLER_SRC} 的 doExport 校验行`,
    )
  }
}

/**
 * ⑦ session-reader discovery 存储树公式对拍（域 9）：roots.ts 树根段 / subagent 域段 /
 * 分区名校验正则三字面量与 shared 逐字一致——session-reader 读侧与写侧（subagent-core
 * 经 shared 函数族落盘）两侧各有一份推导，漂移即 subagent 会话/记录发现为空。
 */
function compareSessionReaderDiscovery(storeText, rootsText, sharedStoreSegment, sharedRegex) {
  const sharedSubagentsBlock = extractFunctionBlock(storeText, `export function ${SHARED_SUBAGENTS_FN}`)
  if (sharedSubagentsBlock.error) fail(`shared ${SHARED_SUBAGENTS_FN} 提取失败: ${sharedSubagentsBlock.error}`)
  exitIfFailed('域 9 discovery 公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')

  const extracted = {
    srStoreSegment: extractConstLiteral(rootsText, SR_DISCOVERY_STORE_SEGMENT_CONST),
    srSubagentsSegment: extractConstLiteral(rootsText, SR_DISCOVERY_SUBAGENTS_CONST),
    sharedSubagentsSegment: extractJoinSegment(sharedSubagentsBlock.text),
    srRegex: extractConstRegex(rootsText, SR_DISCOVERY_PATTERN_CONST),
  }
  for (const [label, r] of [
    [`镜像树根段常量 ${SR_DISCOVERY_STORE_SEGMENT_CONST}`, extracted.srStoreSegment],
    [`镜像域段常量 ${SR_DISCOVERY_SUBAGENTS_CONST}`, extracted.srSubagentsSegment],
    [`shared ${SHARED_SUBAGENTS_FN} join 域段`, extracted.sharedSubagentsSegment],
    [`镜像分区名校验正则 ${SR_DISCOVERY_PATTERN_CONST}`, extracted.srRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('域 9 discovery 公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  if (extracted.srStoreSegment.value === sharedStoreSegment) {
    ok(`域 9 存储树根段一致（'${extracted.srStoreSegment.value}'，shared ↔ session-reader discovery 镜像）`)
  } else {
    fail(
      `域 9 存储树根段漂移: shared='${sharedStoreSegment}' vs 镜像='${extracted.srStoreSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${STORE_SEGMENT_CONST} 与 ${SR_DISCOVERY_ROOTS_SRC} 的 ${SR_DISCOVERY_STORE_SEGMENT_CONST}`,
    )
  }
  if (extracted.srSubagentsSegment.value === extracted.sharedSubagentsSegment.value) {
    ok(`域 9 subagent 域段一致（'${extracted.srSubagentsSegment.value}'，shared ${SHARED_SUBAGENTS_FN} ↔ 镜像常量）`)
  } else {
    fail(
      `域 9 subagent 域段漂移: shared='${extracted.sharedSubagentsSegment.value}' vs 镜像='${extracted.srSubagentsSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_SUBAGENTS_FN} 与 ${SR_DISCOVERY_ROOTS_SRC} 的 ${SR_DISCOVERY_SUBAGENTS_CONST}`,
    )
  }
  if (extracted.srRegex.value === sharedRegex) {
    ok(`域 9 sessionId 校验正则一致（${extracted.srRegex.value}）`)
  } else {
    fail(
      `域 9 sessionId 校验正则漂移: shared=${sharedRegex} vs 镜像=${extracted.srRegex.value}` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${SR_DISCOVERY_ROOTS_SRC} 的 ${SR_DISCOVERY_PATTERN_CONST}`,
    )
  }
}

/**
 * ⑧ 归档域镜像字面量对拍（域 10）：session-reader 不 import shared，归档目录名 / 簿记
 * 后缀 / 簿记 schema（status 词表 + summary.turns 成员名）/ D7 归档态返回正文四字面
 * 都是 runtime/shared 侧的镜像字面量。目录名与后缀漂移时 session-reader 静默扫不到任何
 * 簿记；schema 字段漂移时 extension 逐条拒收全部簿记（agent 对归档 session 的引用全部
 * 退化为无匹配）——漂移均无任何红灯，故对拍扩为字段级（dmg-r1-9）。
 */
function compareArchiveMirror(sharedText, storeText, ledgerText, runtimePathsText, runtimePiPathsText, sharedSchemaText, rendererText) {
  const treeSegments = extractConstStringArray(sharedText, SHARED_TREE_CONST)
  const srDirname = extractConstLiteral(ledgerText, SR_ARCHIVE_DIRNAME_CONST)
  const archiveFnBlock = extractFunctionBlock(runtimePiPathsText, `export function ${RUNTIME_ARCHIVE_DIR_FN}`)
  if (treeSegments.error) fail(`shared ${SHARED_TREE_CONST} 提取失败: ${treeSegments.error}`)
  if (srDirname.error) fail(`镜像 ${SR_ARCHIVE_DIRNAME_CONST} 提取失败: ${srDirname.error}`)
  if (archiveFnBlock.error) fail(`${RUNTIME_ARCHIVE_DIR_FN} 函数块提取失败: ${archiveFnBlock.error}`)
  exitIfFailed('域 10 归档镜像对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  const runtimeSegment = extractTreeRootSegment(archiveFnBlock.text)
  if (runtimeSegment.error) fail(`runtime ${RUNTIME_ARCHIVE_DIR_FN} 树根段提取失败: ${runtimeSegment.error}`)
  exitIfFailed('域 10 归档镜像对拍：runtime 归档根段提取失败')

  if (treeSegments.value.includes(srDirname.value) && srDirname.value === runtimeSegment.value) {
    ok(`域 10 归档目录名一致（'${srDirname.value}'，shared 树段 ↔ runtime ${RUNTIME_ARCHIVE_DIR_FN} ↔ 镜像 ${SR_ARCHIVE_DIRNAME_CONST}）`)
  } else {
    fail(
      `域 10 归档目录名漂移: shared 树段=[${treeSegments.value.join(', ')}] vs runtime='${runtimeSegment.value}' vs 镜像='${srDirname.value}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_TREE_CONST}、${RUNTIME_PI_PATHS_SRC} 的 ${RUNTIME_ARCHIVE_DIR_FN}、${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 ${SR_ARCHIVE_DIRNAME_CONST}`,
    )
  }

  // 簿记后缀：extension 侧 endsWith('.archive.json') ↔ runtime archiveLedgerPath 的
  // `${originalFile}.archive.json`（两端字面量形态不同，各按调用形态锚定）。
  const srSuffix = ledgerText.match(/\.endsWith\('([^']*\.archive\.json)'\)/)
  // 按函数块锚定（文件内另有 `${originalFile}.zst` 压缩体路径，裸全文匹配会取错）。
  const ledgerPathBlock = extractFunctionBlock(runtimePathsText, 'export function archiveLedgerPath')
  if (ledgerPathBlock.error) fail(`runtime archiveLedgerPath 提取失败: ${ledgerPathBlock.error}`)
  exitIfFailed('域 10 归档镜像对拍：archiveLedgerPath 提取失败')
  const runtimeSuffix = ledgerPathBlock.text.match(/\$\{originalFile\}(\.[A-Za-z0-9.]+)`/)
  if (!srSuffix) fail(`镜像簿记后缀提取失败（${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 endsWith 调用形态变更）`)
  if (!runtimeSuffix) fail(`runtime 簿记后缀提取失败（${RUNTIME_ARCHIVE_PATHS_SRC} 的 archiveLedgerPath 形态变更）`)
  if (srSuffix && runtimeSuffix) {
    if (srSuffix[1] === runtimeSuffix[1]) {
      ok(`域 10 簿记后缀一致（'${srSuffix[1]}'，runtime archiveLedgerPath ↔ 镜像扫描后缀）`)
    } else {
      fail(
        `域 10 簿记后缀漂移: runtime='${runtimeSuffix[1]}' vs 镜像='${srSuffix[1]}'` +
          `——恢复动作：人工核对 ${RUNTIME_ARCHIVE_PATHS_SRC} 的 archiveLedgerPath 与 ${SESSION_READER_ARCHIVE_LEDGER_SRC} 的扫描后缀`,
      )
    }
  }

  // 簿记 sessionId 同域正则：shared archive.ts（renderer barrel 出口，bundle 隔离镜像）
  // ↔ shared paths.ts（isPiSessionId 权威实现）。镜像漂移 = 归档簿记解析侧与 pi 会话
  // id 权威域对同一 sessionId 的收窄口径分裂——簿记侧放行的穿越形态 id 会流向 assets/
  // 分区键与 purge 的 rmSync 破坏性原语（dmg-r2-1 防线）。
  const ledgerSessionIdRegex = extractConstRegex(sharedSchemaText, SHARED_PATTERN_CONST)
  if (ledgerSessionIdRegex.error) fail(`shared ${SHARED_ARCHIVE_SCHEMA_SRC} 的 ${SHARED_PATTERN_CONST} 提取失败: ${ledgerSessionIdRegex.error}`)
  exitIfFailed('域 10 归档镜像对拍：簿记 sessionId 正则提取失败')
  // 正则权威 = session-store-paths.ts（isPiSessionId 现居地，paths.ts 经转发暴露——
  // C-ext-31 纯公式符号收敛后的物理位置，提取须跟随）。
  const sessionIdRegex = extractConstRegex(storeText, SHARED_PATTERN_CONST)
  if (sessionIdRegex.value === ledgerSessionIdRegex.value) {
    ok(`域 10 簿记 sessionId 正则一致（${ledgerSessionIdRegex.value}，shared session-store-paths isPiSessionId ↔ shared archive parse 镜像）`)
  } else {
    fail(
      `域 10 簿记 sessionId 正则漂移: shared paths='${sessionIdRegex.value}' vs shared archive='${ledgerSessionIdRegex.value}'` +
        `——恢复动作：人工核对 ${SHARED_STORE_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${SHARED_ARCHIVE_SCHEMA_SRC} 的 ${SHARED_PATTERN_CONST}（bundle 隔离镜像逐字同步）`,
    )
  }

  compareArchiveSchemaFields(sharedSchemaText, ledgerText)
  compareD7LiteralMirror(ledgerText, rendererText)
}

/**
 * ⑧b 域 10 字段级对拍（dmg-r1-9）：簿记 D3 schema 双解析器（shared parseArchiveLedger
 * 两态完备校验 ↔ extension parseArchiveLedgerText 消费子集）的两条漂移轴——
 * ① status 词表：shared ARCHIVE_LEDGER_STATUSES 元组 ↔ extension 守卫字面量（集合相等，
 *   词表漂移 = extension 静默拒收整条簿记）；
 * ② summary.turns 成员名：shared ArchiveSummaryTurn ↔ extension ArchiveLedgerTurn
 *   interface 成员逐字比对 + 两端 parse 块实际消费同名成员（防只改接口不改解析器）。
 */
function compareArchiveSchemaFields(sharedSchemaText, ledgerText) {
  const sharedStatuses = extractConstStringArray(sharedSchemaText, SHARED_ARCHIVE_STATUS_CONST)
  const mirrorStatuses = extractMirrorStatusLiterals(ledgerText)
  if (sharedStatuses.error) fail(`shared ${SHARED_ARCHIVE_STATUS_CONST} 提取失败: ${sharedStatuses.error}`)
  if (mirrorStatuses.error) fail(`镜像 status 词表守卫提取失败: ${mirrorStatuses.error}`)
  exitIfFailed('域 10 簿记 schema 字段级对拍：status 词表提取失败，按上方 ✗ 修复后重跑')

  const sharedSet = [...sharedStatuses.value].sort().join(',')
  const mirrorSet = [...mirrorStatuses.value].sort().join(',')
  if (sharedSet === mirrorSet) {
    ok(`域 10 status 词表一致（[${sharedStatuses.value.join(', ')}]，shared ${SHARED_ARCHIVE_STATUS_CONST} ↔ 镜像守卫字面量）`)
  } else {
    fail(
      `域 10 status 词表漂移: shared=[${sharedStatuses.value.join(', ')}] vs 镜像=[${mirrorStatuses.value.join(', ')}]` +
        `——恢复动作：人工核对 ${SHARED_ARCHIVE_SCHEMA_SRC} 的 ${SHARED_ARCHIVE_STATUS_CONST} 与 ${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 parseArchiveLedgerText 守卫（词表漂移 = extension 逐条拒收全部簿记）`,
    )
  }

  const sharedTurnBlock = extractFunctionBlock(sharedSchemaText, SHARED_TURN_INTERFACE)
  const mirrorTurnBlock = extractFunctionBlock(ledgerText, MIRROR_TURN_INTERFACE)
  if (sharedTurnBlock.error) fail(`shared ${SHARED_TURN_INTERFACE} 块提取失败: ${sharedTurnBlock.error}`)
  if (mirrorTurnBlock.error) fail(`镜像 ${MIRROR_TURN_INTERFACE} 块提取失败: ${mirrorTurnBlock.error}`)
  exitIfFailed('域 10 簿记 schema 字段级对拍：turn 接口块提取失败，按上方 ✗ 修复后重跑')

  const sharedMembers = extractInterfaceMembers(sharedTurnBlock.text)
  const mirrorMembers = extractInterfaceMembers(mirrorTurnBlock.text)
  if (sharedMembers.error) fail(`shared turn 成员名提取失败: ${sharedMembers.error}`)
  if (mirrorMembers.error) fail(`镜像 turn 成员名提取失败: ${mirrorMembers.error}`)
  exitIfFailed('域 10 簿记 schema 字段级对拍：turn 成员名提取失败，按上方 ✗ 修复后重跑')

  const sharedMemberList = sharedMembers.value.join(',')
  const mirrorMemberList = mirrorMembers.value.join(',')
  if (sharedMemberList !== mirrorMemberList) {
    fail(
      `域 10 summary.turns 成员名漂移: shared=[${sharedMemberList}] vs 镜像=[${mirrorMemberList}]` +
        `——恢复动作：人工核对 ${SHARED_ARCHIVE_SCHEMA_SRC} 的 ArchiveSummaryTurn 与 ${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 ArchiveLedgerTurn（成员漂移 = 摘要渲染字段错位）`,
    )
    return
  }
  // 两端 parse 块实际消费同名成员（接口改了名、解析器还读旧名 = 静默 undefined 字段）。
  const sharedParseBlock = extractFunctionBlock(sharedSchemaText, 'function parseSummaryTurn')
  const mirrorParseBlock = extractFunctionBlock(ledgerText, 'function parseSummary')
  if (sharedParseBlock.error) fail(`shared parseSummaryTurn 块提取失败: ${sharedParseBlock.error}`)
  if (mirrorParseBlock.error) fail(`镜像 parseSummary 块提取失败: ${mirrorParseBlock.error}`)
  exitIfFailed('域 10 簿记 schema 字段级对拍：parse 块提取失败，按上方 ✗ 修复后重跑')
  const unconsumed = sharedMembers.value.filter(
    (name) => !sharedParseBlock.text.includes(`.${name}`) || !mirrorParseBlock.text.includes(`.${name}`),
  )
  if (unconsumed.length === 0) {
    ok(`域 10 summary.turns 成员名一致（[${sharedMemberList}]，shared ArchiveSummaryTurn ↔ 镜像 ArchiveLedgerTurn，两端 parse 块消费同名校验通过）`)
  } else {
    fail(
      `域 10 summary.turns 成员消费漂移: [${unconsumed.join(', ')}] 未在两端 parse 块同时按名消费` +
        `——恢复动作：人工核对 ${SHARED_ARCHIVE_SCHEMA_SRC} 的 parseSummaryTurn 与 ${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 parseSummary`,
    )
  }
}

/**
 * ⑧c D7 归档态返回正文四字面镜像对拍（dmg-r1-9）：renderer 预检正文
 * （agent-reference-format.ts）与 extension 真实返回正文（archive-ledger.ts）是同一
 * D7 契约的两份实现，四字面漂移 = 用户预检与 agent 实见正文不一致且无红灯。
 */
function compareD7LiteralMirror(ledgerText, rendererText) {
  const extracted = D7_LITERAL_CONSTS.map((name) => ({
    name,
    mirror: extractConstLiteral(ledgerText, name),
    renderer: extractConstLiteral(rendererText, name),
  }))
  for (const { name, mirror, renderer } of extracted) {
    if (mirror.error) fail(`extension D7 字面 ${name} 提取失败: ${mirror.error}`)
    if (renderer.error) fail(`renderer D7 字面 ${name} 提取失败: ${renderer.error}`)
  }
  exitIfFailed('域 10 D7 四字面镜像对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  for (const { name, mirror, renderer } of extracted) {
    if (mirror.value === renderer.value) {
      ok(`域 10 D7 字面一致（${name}，renderer 预检 ↔ extension 返回正文逐字相同）`)
    } else {
      fail(
        `域 10 D7 字面漂移（${name}）: renderer='${renderer.value}' vs extension='${mirror.value}'` +
          `——恢复动作：人工核对 ${RENDERER_ARCHIVE_REFERENCE_SRC} 与 ${SESSION_READER_ARCHIVE_LEDGER_SRC} 的 ${name}（D7 字面契约两侧同步）`,
      )
    }
  }
}

/**
 * ⑨ retry-rules ext-config 路径公式四处对拍（第九组，dmg-r1-2）：同一相对路径
 * `config/retry-rules-ext-config.json` 在 runtime 写侧（RETRY_RULES_CONFIG_REL）、
 * 引擎读侧（同名常量）、extension 读侧（getConfigPath 泛化模板，pkg 实参 = 本域 pkg
 * 名）与 extension startupConfig 声明四处独立承载，漂移 = runtime 写的 ext-config 与
 * 两侧读侧落点错位（retry-rules message_end 改写静默空转 + 引擎失败分类静默回落
 * 内置层），均无红灯——逐段逐字对拍。
 */
function compareRetryRulesConfigFormula(runtimeText, engineText, llmSharedText, extPkgJsonText) {
  const llmSharedBlock = extractFunctionBlock(llmSharedText, 'export function getConfigPath')
  if (llmSharedBlock.error) fail(`extension 读侧 getConfigPath 函数块提取失败: ${llmSharedBlock.error}`)
  exitIfFailed('retry-rules 路径公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')

  const extracted = {
    runtime: extractConfigRelJoinSegments(runtimeText, RETRY_RULES_CONFIG_REL_CONST),
    engine: extractConfigRelJoinSegments(engineText, RETRY_RULES_CONFIG_REL_CONST),
    llmShared: extractConfigPathTemplateSegments(llmSharedBlock.text),
    startupPath: extractStartupConfigPath(extPkgJsonText),
  }
  for (const [label, r] of [
    [`runtime 写侧 ${RETRY_RULES_CONFIG_REL_CONST}`, extracted.runtime],
    [`引擎读侧 ${RETRY_RULES_CONFIG_REL_CONST}`, extracted.engine],
    ['extension 读侧 getConfigPath 泛化公式', extracted.llmShared],
    [`extension ${RETRY_RULES_STARTUP_CONFIG_PATH}`, extracted.startupPath],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('retry-rules 路径公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')

  const runtimeSegs = extracted.runtime.value
  const engineSegs = extracted.engine.value
  const template = extracted.llmShared.value
  const startupPath = extracted.startupPath.value

  // ① config 段三方一致（runtime 写侧 / 引擎读侧 / extension 读侧泛化公式）。
  if (runtimeSegs.configSeg === engineSegs.configSeg && engineSegs.configSeg === template.configSeg) {
    ok(`retry-rules 路径公式 config 段三方一致（'${runtimeSegs.configSeg}'，runtime 写侧 ↔ 引擎读侧 ↔ extension 读侧泛化公式）`)
  } else {
    fail(
      `retry-rules 路径公式 config 段漂移: runtime='${runtimeSegs.configSeg}' vs 引擎='${engineSegs.configSeg}' vs extension='${template.configSeg}'` +
        `——恢复动作：人工核对 ${RUNTIME_RETRY_RULES_SRC}、${ENGINE_RETRY_RULES_SRC} 的 ${RETRY_RULES_CONFIG_REL_CONST} 与 ${LLM_SHARED_CONFIG_SRC} 的 getConfigPath`,
    )
  }

  // ② 文件段：runtime ≡ 引擎读侧 ≡ 泛化模板按本域 pkg 名实例化（模板后缀漂移 /
  //    任一写死文件名漂移即红）。
  const instantiated = `${RETRY_RULES_EXT_PKG_NAME}${template.fileSuffix}`
  if (runtimeSegs.fileSeg === engineSegs.fileSeg && engineSegs.fileSeg === instantiated) {
    ok(`retry-rules 路径公式文件段三方一致（'${runtimeSegs.fileSeg}'，写侧 ↔ 引擎读侧 ↔ 泛化模板 pkg='${RETRY_RULES_EXT_PKG_NAME}' 实例化）`)
  } else {
    fail(
      `retry-rules 路径公式文件段漂移: runtime='${runtimeSegs.fileSeg}' vs 引擎='${engineSegs.fileSeg}' vs 泛化模板实例化='${instantiated}'` +
        `——恢复动作：人工核对两侧 ${RETRY_RULES_CONFIG_REL_CONST} 字面量与 ${LLM_SHARED_CONFIG_SRC} 模板（pkg 名 '${RETRY_RULES_EXT_PKG_NAME}' 见 ${RETRY_RULES_EXT_PKG_JSON} 文件名前缀）`,
    )
  }

  // ③ startupConfig 声明 ≡ '<config 段>/<文件段>'（extension 启动占位写点与运行时
  //    读写公式同位——占位写错位置时 runtime 首次同步覆盖即落空位）。
  const runtimeFormula = `${runtimeSegs.configSeg}/${runtimeSegs.fileSeg}`
  if (startupPath === runtimeFormula) {
    ok(`retry-rules startupConfig path 一致（'${startupPath}'，package.json ${RETRY_RULES_STARTUP_CONFIG_PATH} ↔ 运行时读写公式）`)
  } else {
    fail(
      `retry-rules startupConfig path 漂移: package.json='${startupPath}' vs 运行时公式='${runtimeFormula}'` +
        `——恢复动作：人工核对 ${RETRY_RULES_EXT_PKG_JSON} 的 ${RETRY_RULES_STARTUP_CONFIG_PATH} 与 ${RUNTIME_RETRY_RULES_SRC} 的 ${RETRY_RULES_CONFIG_REL_CONST}`,
    )
  }
}

function main() {
  const [sharedText, storeText, mirrorText, runtimeText, registryText, handlerText, rootsText, ledgerText, runtimePathsText, sharedSchemaText, rendererText, retryRulesRuntimeText, retryRulesEngineText, llmSharedText, retryRulesPkgJsonText] = readSourcesOrFail([
    [SHARED_PATHS_SRC, 'shared paths 源文件'],
    [SHARED_STORE_SRC, 'shared session-store-paths 源文件'],
    [SYSTEM_PROMPT_SRC, 'system-prompt 源文件'],
    [RUNTIME_PI_PATHS_SRC, 'runtime pi-paths 源文件'],
    [BTE_REGISTRY_SRC, 'base-tool-enhance registry 源文件'],
    [SR_TOOL_HANDLER_SRC, 'session-reader tool-handler 源文件'],
    [SR_DISCOVERY_ROOTS_SRC, 'session-reader discovery roots 源文件'],
    [SESSION_READER_ARCHIVE_LEDGER_SRC, 'session-reader archive-ledger 源文件'],
    [RUNTIME_ARCHIVE_PATHS_SRC, 'runtime archive-paths 源文件'],
    [SHARED_ARCHIVE_SCHEMA_SRC, 'shared archive schema 源文件'],
    [RENDERER_ARCHIVE_REFERENCE_SRC, 'renderer 归档预检正文源文件'],
    [RUNTIME_RETRY_RULES_SRC, 'runtime retry-rules 写侧源文件'],
    [ENGINE_RETRY_RULES_SRC, '引擎 retry-rules 读侧源文件'],
    [LLM_SHARED_CONFIG_SRC, 'llm-shared config 源文件'],
    [RETRY_RULES_EXT_PKG_JSON, 'retry-rules extension package.json'],
  ])

  const { sharedBlock, mirrorBlock } = extractFormulaBlocksOrFail(sharedText, mirrorText)
  const lits = extractFormulaLiteralsOrFail(storeText, sharedBlock, mirrorBlock, mirrorText, runtimeText)

  compareSegmentLiteral(lits.sharedSegment.value, lits.mirrorSegment.value)
  compareStoreSegmentLiteral(lits.sharedStoreSegment.value, lits.mirrorStoreSegment.value)
  compareSessionIdRegexes(lits.sharedRegex.value, lits.mirrorRegex.value, lits.runtimeRegex.value)
  checkMirrorConstUsage(mirrorBlock)
  compareTreeSegments(sharedText, runtimeText, lits.sharedStoreSegment.value)
  compareBaseToolEnhanceRegistry(storeText, registryText, lits.sharedStoreSegment.value, lits.sharedRegex.value)
  compareSessionReaderView(storeText, handlerText, lits.sharedStoreSegment.value, lits.sharedRegex.value)
  compareSessionReaderDiscovery(storeText, rootsText, lits.sharedStoreSegment.value, lits.sharedRegex.value)
  compareArchiveMirror(sharedText, storeText, ledgerText, runtimePathsText, runtimeText, sharedSchemaText, rendererText)
  compareRetryRulesConfigFormula(retryRulesRuntimeText, retryRulesEngineText, llmSharedText, retryRulesPkgJsonText)

  guardExit(
    '✓ 产物目录公式对拍通过（域段 + 存储树根段 + sessionId 校验正则三方 + pi 会话树段 + 域 5 registry 镜像 + 域 6 session-view 镜像 + 域 9 discovery 镜像 + 域 10 归档镜像〔目录名/后缀/sessionId 正则/schema 字段级/D7 四字面〕+ retry-rules 路径公式四处〔config 段/文件段/startupConfig path〕逐字一致）',
    '产物目录公式对拍未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）',
  )
}

if (isDirectRun(import.meta.url)) main()
