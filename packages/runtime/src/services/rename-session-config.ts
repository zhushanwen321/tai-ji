/**
 * rename-session 配置域（pi-rename-session extension 的全部 runtime 侧配置面）。
 *
 * 从 worktree-config-helper.ts 抽出（P1-7 名实拆分：原文件名只对应 worktree 偏好域，
 * 本域与其落盘路径/契约对象均不同）。本模块两部分落盘形态不同，注意区分：
 *
 * 1. auto-rename 开关标志文件（getAutoRenameEnabled / setAutoRenameEnabled /
 *    getAutoRenameEnabledPath / ensureAutoRenameDefault）：不经 AppConfigAccessors、
 *    不落 config.json，直接读写 ${PI_CODING_AGENT_DIR}/auto-rename-enabled 独立标志
 *    文件（与 pi-rename-session extension 契约对齐，extensions/universal/rename-session
 *    pure.ts AUTO_RENAME_FLAG_FILE：文件存在=开，不存在=关）。
 *
 * 2. rename-session ext-config（getRenameModel / setRenameModel / getRenameMode /
 *    setRenameMode）：读改写 ${PI_CODING_AGENT_DIR}/config/rename-session-ext-config.json
 *    的 model / mode 字段（与 extension 的 llm-shared getConfigPath 路径契约对齐）。
 *    extension 事件面（turn_end / message_end / 工具 execute 守卫）读时刷新（mtime+size
 *    缓存），本侧写入后下一事件自动生效（设计 rename-session-three-modes D1：事件面
 *    live 求值）。只改目标字段，保留文件内其他字段（enabled/maxTitleLength/thinkingLevel
 *    及未来新增）。RMW / 锁协议走共享基建 ext-config-rmw.ts（单一实现点）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RenameMode } from '@taiji/shared'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'
import { logger } from '../infra/logger.js'
import type { SyncFileLockOptions } from '../utils/file-lock.js'
import { toErrorMessage } from '../utils/errors.js'
import { extractRefString, rmwExtConfigField } from './ext-config-rmw.js'

/** auto-rename 开关标志文件名（放在 PI_CODING_AGENT_DIR 下，文件存在=开，不存在=关）。 */
const AUTO_RENAME_ENABLED_FILE = 'auto-rename-enabled'
/** auto-rename 初始化标记文件名（存在=已执行过默认初始化，防止 boot 反复覆盖用户的关闭操作）。 */
const AUTO_RENAME_INITIALIZED_FILE = 'auto-rename-initialized'

/**
 * auto-rename 开关标志文件路径（${PI_CODING_AGENT_DIR}/auto-rename-enabled）。
 * 与 pi extension 契约一致：extension 读 process.env.PI_CODING_AGENT_DIR 下同名文件。
 * 注意：不走 AppConfigAccessors / config.json —— 开关是独立标志文件，不落 config 字段。
 */
export function getAutoRenameEnabledPath(): string {
  return join(getPiAgentDir(), AUTO_RENAME_ENABLED_FILE)
}

/**
 * 读取 auto-rename 开关状态。标志文件存在=开，不存在/出错=关。
 * 不抛错（读异常一律当关，防御性设计）。
 */
export function getAutoRenameEnabled(): boolean {
  try {
    return existsSync(getAutoRenameEnabledPath())
  } catch {
    return false
  }
}

/**
 * 设置 auto-rename 开关。enabled=true 创建标志文件（空内容，若不存在），
 * enabled=false 删除标志文件（不存在时吞 ENOENT，不报错）。
 */
export function setAutoRenameEnabled(enabled: boolean): void {
  const filePath = getAutoRenameEnabledPath()
  if (enabled) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '', 'utf-8')
    }
  } else {
    try {
      rmSync(filePath)
    } catch (e: unknown) {
      // 文件不存在视为成功（吞 ENOENT）
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw e
    }
  }
}

/**
 * 首次启动时默认开启 auto-rename（创建 flag file）。
 * 用 auto-rename-initialized 标记防止后续 boot 反复覆盖用户的关闭操作：
 *   - initialized 不存在 → 首次，创建 enabled flag（默认开）+ initialized 标记
 *   - initialized 存在 → 用户已设置过，不干预
 * 不抛错（与 getAutoRenameEnabled 防御性设计一致）。
 */
export function ensureAutoRenameDefault(): void {
  try {
    const initializedPath = join(getPiAgentDir(), AUTO_RENAME_INITIALIZED_FILE)
    if (existsSync(initializedPath)) return
    mkdirSync(dirname(initializedPath), { recursive: true })
    // 标记已初始化（先写标记，再开开关；即使 enabled 写失败，标记已防重复）
    writeFileSync(initializedPath, '', 'utf-8')
    setAutoRenameEnabled(true)
  } catch (e) {
    // 初始化失败不阻塞 boot，但记录原因便于诊断
    logger.warn(`[rename-session-config] ensureAutoRenameDefault failed: ${toErrorMessage(e)}`)
  }
}

// ── rename-session 模型配置（config/rename-session-ext-config.json 的 model 字段）──

/** 配置文件相对路径（与 pi-rename-session 的 llm-shared getConfigPath('rename-session') 契约一致）。 */
const RENAME_SESSION_CONFIG_REL = join('config', 'rename-session-ext-config.json')

/**
 * 文件缺失/损坏时的回退默认值（与 extension 的 DEFAULT_RENAME_CONFIG 一致：
 * extensions/universal/rename-session/src/pure.ts）。三处默认值真相同批收敛（设计
 * rename-session-three-modes u5）：pure.ts DEFAULT / package.json startupConfig.content /
 * 本镜像。仅 setRenameModel / setRenameMode 落盘时用作基底。
 */
const RENAME_MODEL_DEFAULT_CONFIG: Record<string, unknown> = {
  enabled: false,
  model: { type: 'ref', ref: '' },
  mode: 'first-stop',
  maxTitleLength: 50,
  thinkingLevel: 'off',
}

/** rename-session 配置文件完整路径（${PI_CODING_AGENT_DIR}/config/rename-session-ext-config.json）。 */
export function getRenameConfigPath(): string {
  return join(getPiAgentDir(), RENAME_SESSION_CONFIG_REL)
}

/**
 * 锁参数覆盖（仅测试用，如把重试预算压到几十 ms 快速验证 fail-fast）。
 * 生产保持 file-lock.ts 的默认值（stale 30s / 25ms / 1s），与 pi-settings-store 同协议。
 */
let renameConfigLockOptions: SyncFileLockOptions = {}

/** 覆盖 rename-session-ext-config.json 写锁参数（仅测试用）。传 {} 恢复默认。 */
export function setRenameConfigLockTimingForTest(opts: SyncFileLockOptions): void {
  renameConfigLockOptions = opts
}

/**
 * 读取 rename 标题生成模型（"provider/modelId"，未设置返回空串）。
 * 文件不存在/坏 JSON/model 字段非法 → 空串（与 extension normalizeRenameConfig 的回退语义一致）。
 * 不抛错（读异常一律当未设置，防御性设计，与 getAutoRenameEnabled 一致）。
 */
export function getRenameModel(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getRenameConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    return extractRefString(parsed as Record<string, unknown>, 'model')
  } catch {
    return ''
  }
}

/** RMW 只覆盖指定字段（锁协议走共享 rmwExtConfigField，与 smart-context-config.ts 的 writeSmartContextField 同形）。 */
function writeRenameField(apply: (base: Record<string, unknown>) => void): void {
  rmwExtConfigField(getRenameConfigPath(), renameConfigLockOptions, () => ({ ...RENAME_MODEL_DEFAULT_CONFIG }), apply)
}

/**
 * 设置 rename 标题生成模型（读改写，只覆盖 model 字段，保留其他字段）。
 * model 为空串 = 清除回未设置；非空但不含 "/"（provider/modelId 格式非法）归一为空串
 * （extension 的 parseModelRef 对无 "/" 的 ref 返回 null，写进去也不会生效，不如归一）。
 * 写入为原子写（tmp+rename），与 extension saveConfig 的序列化格式一致（2 空格缩进 + 尾换行）。
 * 写失败（如目录不可写）抛错由调用方处理。
 *
 * 🔒 跨进程锁（D1e，integrity-hardening.md §3.1）：RMW 全程持 withFileLockSync
 * （lockfile 路径 = <rename-session-ext-config.json>.lock，锁目标文件自身）。
 * 该文件被 runtime 与 pi-rename-session extension 双方 RMW——extension 侧
 * （extensions/shared/llm-shared saveConfig）W4 起已持同一把锁（@zhushanwen/pi-file-lock
 * withFileLockSync，协议与本侧逐字对齐），双端闭环；extension 侧锁失败返回
 * success:false 不降级（对端持锁时无锁写会交错丢字段）。见登记表 §6 rename-session 行。
 */
export function setRenameModel(model: string): void {
  const normalized = model.includes('/') ? model : ''
  writeRenameField((base) => {
    base['model'] = { type: 'ref', ref: normalized }
  })
}

// ── rename-session 触发模式（config/rename-session-ext-config.json 的 mode 字段，设计 D1）──

/** mode 缺失/非法时的回退默认（与 extension DEFAULT_RENAME_CONFIG.mode 一致，旧 config 零迁移）。 */
const DEFAULT_RENAME_MODE: RenameMode = 'first-stop'

/** 合法触发模式清单（与 extension pure.ts 的 RenameMode 值域一致；Set 免 as 断言）。 */
const RENAME_MODES: ReadonlySet<RenameMode> = new Set<RenameMode>(['first-prompt', 'first-stop', 'agent-tool'])

/** mode 值域 guard（与 extension isRenameMode 同构；读取回退与写入归一共用）。 */
function isRenameMode(raw: unknown): raw is RenameMode {
  return typeof raw === 'string' && RENAME_MODES.has(raw as RenameMode)
}

/**
 * 读取 rename 触发模式。文件不存在/坏 JSON/mode 字段缺失或非法 → first-stop
 * （与 extension normalizeRenameConfig 的回退语义一致）。不抛错（防御性设计，与 getRenameModel 一致）。
 */
export function getRenameMode(): RenameMode {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getRenameConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_RENAME_MODE
    const mode = (parsed as Record<string, unknown>)['mode']
    return isRenameMode(mode) ? mode : DEFAULT_RENAME_MODE
  } catch {
    return DEFAULT_RENAME_MODE
  }
}

/**
 * 设置 rename 触发模式（读改写，只覆盖 mode 字段，保留其他字段）。
 * 非法值归一为 first-stop（extension 读侧 normalize 对非法值同回默认，写进去也不生效，
 * 不如归一——与 setRenameModel 对无 "/" ref 的归一纪律一致）。
 * 锁协议与 setRenameModel 共用同一把锁（同一文件，D1e）。
 * 生效时点：extension 事件面 live 读 config，写入后下一事件生效；rename_session 工具面
 * 只在 pi 进程起动时求值一次（设计 D1 求值时点边界，GUI 切换须提示「工具面对新会话生效」）。
 */
export function setRenameMode(mode: RenameMode): void {
  const normalized = isRenameMode(mode) ? mode : DEFAULT_RENAME_MODE
  writeRenameField((base) => {
    base['mode'] = normalized
  })
}
