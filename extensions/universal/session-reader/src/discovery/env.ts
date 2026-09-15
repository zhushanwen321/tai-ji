import { dirname } from 'node:path'

/**
 * 环境判定（design 2026-09-10-session-root-discovery-and-env-transparency §6.2）：
 * 多信号合取 + evidence 附带。
 *
 * 零 pi 依赖：与 discovery/roots.ts 同一分层约定——全部输入经 EnvironmentSignals
 * 显式注入（process.env / import.meta.url / getAgentDir() 的组装在 index.ts 接线层），
 * 本模块是纯函数，不读全局状态，可完全单测。
 *
 * 输入接口在本文件内自定义（design §10 U2：与 U1 roots 无数据依赖，doctor 需两者
 * 齐备），不 import roots.ts 的信号类型，避免并行单元耦合；接线层分别组装两种信号包。
 *
 * 信号可靠性依据（design §4.4 活体实测表，非推断）：
 * - TAIJI_AGENT_EXT_LOG 单独使用可靠性「中」——runtime 无条件注入，但
 *   ENV_WHITELIST_PREFIXES 含裸 `TAIJI_` 前缀，用户 shell 里的同名变量会透传进任何进程；
 * - PI_CODING_AGENT_DIR 单独使用可靠性「中」——pi 原生变量，裸 pi 用户也可能自设，
 *   但其值形态是 taiji 专属约定：`<*>/.taiji*` 目录后接 `/agent`；
 * - TAIJI_AGENT_PACKAGED **不可用**——在 SPAWN_ENV_OUTBOUND_DENY_LIST 被剥除
 *  （§4.4 在案结论），故不引入该信号，防后人重蹈。
 * 因此托管判定必须是双信号合取：任一信号单独成立只判 standalone-pi，
 * 透传/自设污染提示写入 evidence。
 */

/** taiji 托管信号 1：runtime 无条件注入的 extension 日志开关（恒 '1'） */
export const TAIJI_AGENT_EXT_LOG_ENV = 'TAIJI_AGENT_EXT_LOG'
/** taiji 托管信号 2：pi agentDir 注入变量；其**值形态**是 taiji 专属约定 */
export const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'
/** 数据目录推导首选：runtime getDataDir() 的权威注入值 */
export const TAIJI_AGENT_DATA_DIR_ENV = 'TAIJI_AGENT_DATA_DIR'

/** 托管信号 1 的唯一合法值（注释「托管语义恒为 '1'」） */
const EXT_LOG_MANAGED_VALUE = '1'

// taiji agentDir 值形态（§6.2 双形态兼容——迁移窗口期 B 前后两种布局并存）：
// - B 后新布局：`<*>/.taiji*` 目录后接 `/agent`（一层）
// - B 前旧布局：`<*>/.taiji*` 目录后接 `/pi/agent`（两层）
// `.taiji*` = 以 `.taiji` 开头的目录段（prod `.taiji` / dev `.taiji-dev`）。
// 三条正则都要求匹配到路径末尾（`$`），调用前输入先经 normalizeTaijiPath 剥尾斜杠。
// （用行注释：形态文本含星号斜杠序列，写进块注释会提前终止注释。）
const AGENT_DIR_SHAPE_ANY = /(^|\/)\.taiji[^/]*\/(pi\/)?agent$/
const AGENT_DIR_SHAPE_OLD = /(^|\/)\.taiji[^/]*\/pi\/agent$/
const AGENT_DIR_SHAPE_NEW = /(^|\/)\.taiji[^/]*\/agent$/

/**
 * 打包形态判据（§6.2：bundle 路径判发行形态；无法判定 → null 不猜）。
 * electron-builder extraResources `to: extensions`：
 * - macOS → `*.app/Contents/Resources/extensions/`（§4.4 TaiJi.app 实测形态）
 * - Windows/Linux → 安装根 `resources/extensions/`（小写 resources；macOS 是大写
 *   `Resources`，故小写模式不会误吞 macOS 形态）
 * dev 仓库 staged 根 `<projectRoot>/apps/electron/resources/extensions/`（§6.12 在案
 * 「dev 仓库资源根」）与 Windows 打包目录在 `resources/extensions` 段同形——必须
 * 先排除，否则 dev staged 的 bundle 会被误判 packaged。
 */
const MACOS_PACKAGED_PATTERN = /\.app\/Contents\/Resources\/extensions\//
const REPO_STAGED_PATTERN = /(^|\/)apps\/electron\/resources\/extensions\//
const WIN_LINUX_PACKAGED_PATTERN = /(^|\/)resources\/extensions\//

export type EnvironmentKind = 'taiji' | 'standalone-pi'
export type Distribution = 'packaged' | 'dev' | null

export interface EnvironmentSignals {
  /** process.env 快照（接线层传入，本模块不读全局 process.env） */
  env: Record<string, string | undefined>
  /** extension 模块的 import.meta.url（file:// URL）；缺失 = distribution 无法判定（null） */
  bundleUrl?: string
  /** pi 的 agentDir（getAgentDir() 值），透传进 evidence 供核对 */
  agentDir: string
}

export interface DetectedEnvironment {
  kind: EnvironmentKind
  distribution: Distribution
  /** 托管时的 taiji 数据目录；standalone-pi 恒 undefined */
  dataDir?: string
  /** 每条命中/未命中信号的原文 + 判定依据，恒非空（§6.2：判定可被证据推翻，非黑盒断言） */
  evidence: string[]
}

/** 形态匹配前的归一化：Windows 分隔符 → `/`，剥尾部斜杠 */
function normalizeTaijiPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function matchesTaijiAgentDir(value: string): boolean {
  return AGENT_DIR_SHAPE_ANY.test(normalizeTaijiPath(value))
}

/** distribution 判定，判定行写入 evidence */
function detectDistribution(bundleUrl: string | undefined, evidence: string[]): Distribution {
  if (!bundleUrl) {
    evidence.push('bundle=<缺失> → distribution 无法判定（null，不猜）')
    return null
  }
  const normalized = bundleUrl.replace(/\\/g, '/')
  if (MACOS_PACKAGED_PATTERN.test(normalized)) {
    evidence.push(`bundle='${bundleUrl}' → packaged（macOS app bundle）`)
    return 'packaged'
  }
  if (REPO_STAGED_PATTERN.test(normalized)) {
    evidence.push(`bundle='${bundleUrl}' → dev（仓库 staged 资源根，非安装产物）`)
    return 'dev'
  }
  if (WIN_LINUX_PACKAGED_PATTERN.test(normalized)) {
    evidence.push(`bundle='${bundleUrl}' → packaged（Windows/Linux 应用资源目录）`)
    return 'packaged'
  }
  evidence.push(`bundle='${bundleUrl}' → dev（非打包资源目录形态）`)
  return 'dev'
}

/**
 * 托管时的数据目录推导：TAIJI_AGENT_DATA_DIR 优先（runtime 注入的权威值，与
 * getDataDir() 同源），缺失时按布局形态从 PI_CODING_AGENT_DIR 剥层。来源写入 evidence。
 */
function deriveDataDir(env: Record<string, string | undefined>, evidence: string[]): string | undefined {
  const dataDirEnv = env[TAIJI_AGENT_DATA_DIR_ENV]
  if (dataDirEnv) {
    evidence.push(`数据目录：'${dataDirEnv}'（来源：${TAIJI_AGENT_DATA_DIR_ENV}）`)
    return dataDirEnv
  }
  const agentDirEnv = env[PI_CODING_AGENT_DIR_ENV]
  if (agentDirEnv) {
    const normalized = normalizeTaijiPath(agentDirEnv)
    // 旧形态更长，先判：`.taiji*/pi/agent` → 剥 pi/agent 两层
    if (AGENT_DIR_SHAPE_OLD.test(normalized)) {
      const dataDir = dirname(dirname(normalized))
      evidence.push(`数据目录：'${dataDir}'（来源：${PI_CODING_AGENT_DIR_ENV} 剥 pi/agent 两层，B 前旧布局）`)
      return dataDir
    }
    if (AGENT_DIR_SHAPE_NEW.test(normalized)) {
      const dataDir = dirname(normalized)
      evidence.push(`数据目录：'${dataDir}'（来源：${PI_CODING_AGENT_DIR_ENV} 剥 agent 一层，B 后新布局）`)
      return dataDir
    }
  }
  evidence.push(`数据目录：无法推导（${TAIJI_AGENT_DATA_DIR_ENV} 未设置且 ${PI_CODING_AGENT_DIR_ENV} 形态不可剥层）`)
  return undefined
}

/** 信号 1 evidence 行（命中/未命中原文 + 未设置形态 + 要求值）。 */
function pushExtLogEvidence(
  evidence: string[],
  extLog: string | undefined,
  extLogHit: boolean,
): void {
  evidence.push(
    extLogHit
      ? `${TAIJI_AGENT_EXT_LOG_ENV}='${extLog}' → 命中`
      : `${TAIJI_AGENT_EXT_LOG_ENV}=${extLog === undefined ? '<未设置>' : `'${extLog}'`} → 未命中（要求值为 '1'）`,
  )
}

/** 信号 2 的形态标注（§6.2 双形态兼容：B 前旧布局 / B 后新布局 / 非 taiji 形态）。 */
function describeAgentDirShape(normalized: string): string {
  if (AGENT_DIR_SHAPE_OLD.test(normalized)) return 'B 前旧布局 pi/agent'
  if (AGENT_DIR_SHAPE_NEW.test(normalized)) return 'B 后新布局 agent'
  return '非 taiji 形态'
}

/** 信号 2 evidence 行（未设置 → 未命中；有值 → 形态匹配与否 + 形态标注）。 */
function pushAgentDirEvidence(
  evidence: string[],
  agentDirEnv: string | undefined,
  agentDirHit: boolean,
): void {
  if (agentDirEnv === undefined) {
    evidence.push(`${PI_CODING_AGENT_DIR_ENV}=<未设置> → 未命中`)
    return
  }
  const shape = describeAgentDirShape(normalizeTaijiPath(agentDirEnv))
  evidence.push(
    `${PI_CODING_AGENT_DIR_ENV}='${agentDirEnv}' → ${agentDirHit ? `形态匹配（${shape}）` : `形态不匹配（${shape}，要求 <*>/.taiji*/agent）`}`,
  )
}

/** 判定行：托管（双信号合取成立）/ standalone-pi（孤置信号点名，提示透传/自设污染）。 */
function judgedEvidenceLine(extLogHit: boolean, agentDirHit: boolean): string {
  if (extLogHit && agentDirHit) {
    return `判定：taiji 托管（${TAIJI_AGENT_EXT_LOG_ENV}='1' 且 ${PI_CODING_AGENT_DIR_ENV} 形态匹配，双信号合取成立）`
  }
  const orphaned: string[] = []
  if (extLogHit) orphaned.push(TAIJI_AGENT_EXT_LOG_ENV)
  if (agentDirHit) orphaned.push(PI_CODING_AGENT_DIR_ENV)
  const orphanNote =
    orphaned.length > 0
      ? `——${orphaned.join(' 与 ')} 单独成立不合取，可能为 shell 透传/自设污染，不判托管`
      : ''
  return `判定：standalone-pi（双信号合取不成立）${orphanNote}`
}

/**
 * 判定当前宿主环境（design §6.2）。
 *
 * 托管（taiji）= 合取：`TAIJI_AGENT_EXT_LOG === '1'` **且** `PI_CODING_AGENT_DIR`
 * 值匹配 taiji 形态（`<*>/.taiji*` 目录后接 `/agent`；B 前旧布局接
 * `/pi/agent` 同样接受）。任一信号单独成立 → standalone-pi，evidence 点名孤置
 * 信号（透传污染提示）。
 * evidence 恒非空：每条命中/未命中信号的原文都在列，让 agent 能核对并推翻判定。
 *
 * 本函数只负责「读信号 → 按序委派 evidence 构造 → 组装返回值」；每条 evidence 的
 * 文案与压入顺序由上方 per-信号 helper 承担（拆解自原单函数 if/三元链，零行为变更）。
 */
export function detectEnvironment(signals: EnvironmentSignals): DetectedEnvironment {
  const evidence: string[] = []
  const { env } = signals

  // 信号 1：TAIJI_AGENT_EXT_LOG === '1'
  const extLog = env[TAIJI_AGENT_EXT_LOG_ENV]
  const extLogHit = extLog === EXT_LOG_MANAGED_VALUE
  pushExtLogEvidence(evidence, extLog, extLogHit)

  // 信号 2：PI_CODING_AGENT_DIR 值形态
  const agentDirEnv = env[PI_CODING_AGENT_DIR_ENV]
  const agentDirHit = agentDirEnv !== undefined && matchesTaijiAgentDir(agentDirEnv)
  pushAgentDirEvidence(evidence, agentDirEnv, agentDirHit)
  evidence.push(`agentDir='${signals.agentDir}' → pi getAgentDir() 透传记录`)

  const managed = extLogHit && agentDirHit
  const kind: EnvironmentKind = managed ? 'taiji' : 'standalone-pi'
  evidence.push(judgedEvidenceLine(extLogHit, agentDirHit))

  const distribution = detectDistribution(signals.bundleUrl, evidence)

  let dataDir: string | undefined
  if (managed) {
    dataDir = deriveDataDir(env, evidence)
  } else {
    evidence.push('数据目录：不输出（standalone-pi 恒无托管数据目录）')
  }

  return {
    kind,
    distribution,
    ...(dataDir !== undefined ? { dataDir } : {}),
    evidence,
  }
}
