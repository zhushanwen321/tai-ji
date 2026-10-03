/**
 * PiCodemodeSettings — settings.json tools 域（defaultTools 字段）的 infra 字段域模块
 * （codemode 设计 D1/D2：启动迁移 + 开关写入共用的唯一写点）。
 *
 * 职责三件：
 *   1. 激活集解析（resolveDefaultToolSet / isCodemodeActive）——复刻 pi 1.0.0 实装语义，
 *      供读侧显示判定（开关显示开/关）；
 *   2. 启动迁移（ensureCodemodeDefaultEntry）——字段缺失时幂等写默认条目；
 *   3. 开关写入（setCodemodeEntry）——负条目占位 + 只增删 codemode 相关系目。
 *
 * 全部写入经 updateSettingsFields('tools', …)（跨进程锁 + 字段域 merge，settings.json
 * 三方共享：taiji 各字段域 / pi 子进程 / 用户手工编辑），绝不直写文件。
 *
 * ── pi 语义锚点（前提 12：与 pi dist 同一语义两处代码，pi 版本升级须重验）──
 *
 * 权威源 = node_modules 实装 1.0.0 `dist/core/settings-manager.js`：
 *   - :35   DEFAULT_TOOL_NAMES = ["read","bash","edit","write"]
 *   - :36   isToolModifier：字符串且以 +/- 开头
 *   - :43   mergeDefaultTools：两层（global/project）合并——overrides 全为 modifier
 *           条目时拼接，否则（含任一层非数组）整体替换
 *   - :52   resolveDefaultTools：任一纯名出现 = 整体替换默认集；仅 modifier =
 *           默认集起步；空数组 = 空激活集；+name 追加（name 非空且不在集内）、
 *           -name 移除，按条目顺序应用
 *   - :1021 getDefaultTools：**数组先 filter 剥非字符串元素再解析**（坏值逐元素行为
 *           的实测定案——非字符串元素既非纯名也非 modifier，解析前即被丢弃）；非数组
 *           → resolveDefaultTools([]) = 空激活集；字段缺失（undefined）→ 返回
 *           undefined，pi 会话层回落 DEFAULT_TOOL_NAMES（agent-session.js reload
 *           `?? DEFAULT_TOOL_NAMES`）
 * 上述语义已用 1.0.0 实装跑 node 探针逐条验证（u1 检查点 1），探针结论固化在本模块
 * 表驱动单测（__tests__/pi-codemode-settings.test.ts）；pi bump 时由 docs/pi-semantics.json
 * 门禁条目（U7 登记）自动重验。
 *
 * taiji 读侧对「字段缺失 / 非数组坏值」统一解析为空激活集：pi 侧该两种形态下 codemode
 * 均不激活（defaultActive: false 且不在默认集），「显示关」判定等价（codemode 不在
 * DEFAULT_TOOL_NAMES，空集与回落默认集对 includes('codemode') 同结果）。
 */

import { updateSettingsFields, getSettingsCorruption, type PiSettings } from './pi-settings-store.js'

/** codemode 工具名（pi builtin extension 注册名，也是 defaultTools 条目里的纯名形态）。 */
export const CODEMODE_TOOL_NAME = 'codemode'

/** 启动迁移写入的默认条目（D2：增量语法，不改写用户默认工具集）。 */
export const CODEMODE_DEFAULT_ENTRY = '+codemode'

/** 关闭态占位条目（D2：负条目占位——字段保留 + codemode 关闭跨重启持久的唯一同时满足形态）。 */
export const CODEMODE_DISABLE_ENTRY = '-codemode'

/** pi DEFAULT_TOOL_NAMES 同构（settings-manager.js:35）。 */
export const PI_DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write'] as const

/** pi isToolModifier 同构（settings-manager.js:36-41）：仅字符串判定，非字符串不算 modifier。 */
function isToolModifier(entry: unknown): entry is string {
  return typeof entry === 'string' && (entry.startsWith('+') || entry.startsWith('-'))
}

/**
 * defaultTools 激活集解析——pi getDefaultTools + resolveDefaultTools 同构（语义锚点见
 * 模块头）。纯函数，无 I/O。
 *
 * @param raw settings.json 的 defaultTools 字段原值（透传类型，可含坏值）
 * @returns 激活工具名集合。字段缺失（undefined）/ null / 非数组 → 空激活集；
 *          数组 → 先剥非字符串元素，再按 pi 顺序应用语义解析。
 */
export function resolveDefaultToolSet(raw: unknown): string[] {
  // pi getDefaultTools :1021-1026 同构：数组先 filter 只留字符串；非数组按空数组解析
  const entries: string[] = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : []
  const plain = entries.filter(entry => !isToolModifier(entry))
  // pi resolveDefaultTools :55-57 同构：任一纯名出现 = 整体替换默认集；空数组 = 空激活集
  const tools: string[] = plain.length > 0 || entries.length === 0 ? [...plain] : [...PI_DEFAULT_TOOL_NAMES]
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue
    const name = entry.slice(1)
    const index = tools.indexOf(name)
    if (entry.startsWith('+') && index === -1 && name) {
      tools.push(name)
    } else if (entry.startsWith('-') && index !== -1) {
      tools.splice(index, 1)
    }
  }
  return tools
}

/** 读侧显示判定（D2）：激活集含 codemode = 开关显示开，否则关；坏值（含字段缺失）= 关。 */
export function isCodemodeActive(raw: unknown): boolean {
  return resolveDefaultToolSet(raw).includes(CODEMODE_TOOL_NAME)
}

/**
 * 字段存在性判定（D2 启动迁移）：undefined / null = 未配置（写默认）；任何其他值
 * （含空数组、坏值）= 有人配置过，尊重不碰。JSON.parse 不会产出值为 undefined 的键，
 * 「键存在值 null」是手工编辑可产出的形态，与 undefined 同归「未配置」。
 */
function isFieldUnset(raw: unknown): boolean {
  return raw === undefined || raw === null
}

/**
 * 启动迁移幂等默认写入（D2）：defaultTools 字段不存在 → 写 ["+codemode"]；字段存在
 * （任何内容，含空数组、坏值）→ 不碰。经 updateSettingsFields('tools', …)（跨进程锁 +
 * 字段域 merge），用户其他字段与 defaultTools 内其他条目零触碰。
 *
 * 遇损坏文件须先经 getSettingsCorruption() 拒入（runCodemodeStartupMigration 编排）——
 * 损坏时 updateSettingsFields 锁内重读走 JsonStore 会触发读时隔离改名、以空基线合法化
 * 覆盖用户全部字段（A1 要堵死的路径）。
 */
export function ensureCodemodeDefaultEntry(): void {
  updateSettingsFields('tools', (s: PiSettings) => {
    if (isFieldUnset(s.defaultTools)) {
      s.defaultTools = [CODEMODE_DEFAULT_ENTRY]
    }
  })
}

/**
 * 开关写入（D2 语义表）。用户非 codemode 条目始终原样保留；重复调用幂等。
 *
 * - **开**：非法形态值（非数组）→ 显式配置动作，规范化覆盖为 ["+codemode"]；数组 →
 *   先移除 "-codemode"（若在），再按 pi 解析语义判幂等——已含 codemode（含纯名形态）
 *   → 不动，否则追加 "+codemode"。
 * - **关**：非法形态值 → 规范化覆盖为 ["-codemode"]；数组 → 移除 "+codemode" 与纯名
 *   "codemode"；移除后数组空 → 追加 "-codemode" 占位（字段保留，防下次启动迁移按
 *   「未配置」写回导致关闭状态无法跨重启持久——D2「不采用」节的关键正确性约束）；
 *   数组非空 → 保留其余条目原样落盘（落盘结果在 pi 解析下 codemode 恒为关闭）。
 */
export function setCodemodeEntry(enabled: boolean): void {
  updateSettingsFields('tools', (s: PiSettings) => {
    const raw = s.defaultTools
    if (!Array.isArray(raw)) {
      // 非法形态值：开关操作是显式配置动作 → 规范化覆盖为增量表达（D2）
      s.defaultTools = [enabled ? CODEMODE_DEFAULT_ENTRY : CODEMODE_DISABLE_ENTRY]
      return
    }
    if (enabled) {
      // 先移除 "-codemode"（若在），再按 pi 解析语义判幂等
      const withoutDisable = raw.filter(entry => entry !== CODEMODE_DISABLE_ENTRY)
      if (!isCodemodeActive(withoutDisable)) {
        withoutDisable.push(CODEMODE_DEFAULT_ENTRY)
      }
      s.defaultTools = withoutDisable
      return
    }
    // 关：只移除 "+codemode" 与纯名 "codemode"；"-codemode" 保留（关闭态幂等）
    const kept = raw.filter(entry => entry !== CODEMODE_DEFAULT_ENTRY && entry !== CODEMODE_TOOL_NAME)
    // 移除后为空 → 负条目占位（已有 "-codemode" 则 kept 非空，构造性不重复追加）
    s.defaultTools = kept.length === 0 ? [CODEMODE_DISABLE_ENTRY] : kept
  })
}

/**
 * 组合根启动迁移入口（codemode 设计 D1/A1：listen 前同步段、与 cleanLeakedPackages
 * 同窗口、先于一切 pi 进程 spawn）。损坏 → 跳过迁移 + 结构化告警（含路径与恢复指引）；
 * 未损坏 → 幂等默认写入。迁移失败不阻塞启动（沿 cleanLeakedPackages ES1 风格，
 * 下次启动重试幂等）。
 */
export function runCodemodeStartupMigration(): void {
  // A1 写点拒入：进 updateSettingsFields 之前先查损坏单点（每次现查）
  const corruption = getSettingsCorruption()
  if (corruption.corrupted) {
    const copyNote = corruption.corruptCopyPath
      ? `，原内容可从隔离副本找回: ${corruption.corruptCopyPath}`
      : ''
    console.warn(
      `[pi-codemode-settings] settings.json 已损坏，跳过 codemode 启动迁移。文件: ${corruption.filePath}${copyNote}。` +
      `恢复指引：修复或删除该文件后重试（重启后迁移自动补跑）。`,
    )
    return
  }
  try {
    ensureCodemodeDefaultEntry()
  } catch (e) {
    // 降级策略（best-effort）：迁移失败不阻塞启动（ES1，沿 cleanLeakedPackages 同款），
    // 错误留痕后继续启动主路径；写入幂等，下次启动自动补跑
    console.warn('[pi-codemode-settings] codemode 启动迁移失败（不阻塞启动，下次启动重试幂等）:', e)
  }
}
