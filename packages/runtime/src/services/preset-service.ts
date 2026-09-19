/**
 * PresetService — Pi 启动参数预设的存储 + CRUD 服务。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md（§1.4 存储 / §3.4 builtin 可编辑边界 / §8.1 API）。
 *
 * 与 ConfigService 对称（独立 service，非 SessionService 内部字段）：
 *   - 构造函数注入 IConfigStore（推导 pi-presets.json 路径）+ IExtensionService（resolve 用，本 wave 不调用）
 *   - 文件 IO 范式参考 config-service.ts L216-248（load 容错 / save atomicWrite + uniqueTmpSuffix）
 *
 * 本 wave 只实现存储 + CRUD（getAllPresets/getPreset/savePreset/deletePreset/defaultPresetId）。
 * resolve(preset, cwd) 留给 wave2（依赖 ExtensionService.getDiscoveredAndDisabled 提取）。
 *
 * 组合根（packages/runtime/src/index.ts）构造，SessionService 加 setPresetService setter
 * （参考 setConfigService session-service.ts L187-189）。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveExtensions, dedupeLoadedExtensions, applyPresetMode } from './extension-filter.js'

import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  SYSTEM_PROMPT_MAX_LENGTH,
  type PiLaunchPreset,
  type PiPresetsFile,
  type PresetPromptConfig,
  type PresetPromptSegment,
} from '@taiji/shared'
import type { IConfigStore } from './ports/config.js'
import type { IExtensionService } from '../interfaces.js'
import { atomicWrite } from '../utils/fs-utils.js'

/** JSON 序列化缩进（与 config-service.ts 共用约定）。 */
const JSON_INDENT = 2

/**
 * ToolMode 合法枚举白名单（W-RT-1）。
 *
 * shared 层 pi-preset.ts 的 TOOL_MODES 未导出（私有），此处本地定义副本保持模块自洽。
 * 用于 coercePreset 校验脏数据（如导入文件里 toolMode: "DROP TABLE"），不在白名单
 * 的 preset 被丢弃（防御性，与 loadPresetsFile 容错范式一致）。
 */
const VALID_TOOL_MODES = ['all', 'allowlist', 'denylist', 'none'] as const

/**
 * ExtensionMode 合法枚举白名单（W-RT-1）。
 *
 * shared 层 pi-preset.ts 的 EXTENSION_MODES 未导出（私有），此处本地定义副本。
 * 用途同 VALID_TOOL_MODES。
 */
const VALID_EXTENSION_MODES = ['all', 'allowlist', 'denylist', 'none'] as const

/**
 * 生成 atomicWrite 的唯一 tmp 后缀（时间戳 + 随机串），避免并发写入撞固定 .tmp 文件。
 * 复刻 config-service.ts L68-71 模式。
 */
function uniqueTmpSuffix(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 radix + slice 掉 "0." 前缀
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/**
 * 内置预设保护错误。
 *
 * 触发场景（设计文档 §3.4）：
 *   - savePreset 传入 builtin id 但 builtin:false（试图降级逃逸保护）
 *   - deletePreset 内置 preset（builtin 不可删）
 */
export class PresetGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetGuardError'
  }
}

/**
 * 校验模式提示词（prompt 字段）——**整条拒绝**语义（写路 savePreset / 导入路 importPresets 共用）。
 *
 * 三条约束（设计文档 §7.1 校验接线）：
 *   ① prompt 段形状：prompt 须为对象；replace/append 若存在须为对象，且 enabled 为 boolean、
 *      prompt 为 string；
 *   ② 段限：每段 prompt 长度 ≤ SYSTEM_PROMPT_MAX_LENGTH（16000），超限报错文案含该段实际长度；
 *   ③ 合计限：replace.prompt.length + append.prompt.length ≤ SYSTEM_PROMPT_MAX_LENGTH，
 *      错误文案含实际合计值。
 *
 * 入参为 unknown（而非 PiLaunchPreset）：导入路在 coercePreset 之前先跑本函数（顺序不可颠倒），
 * 此时条目还是文件来的 raw 值。非对象入参直接放行（条目级形状由 coercePreset 负责）。
 *
 * 抛 PresetGuardError（既有守卫家族）→ preset-message-handler 的 catch 转成 `preset_guard_error`
 * envelope 回 renderer，handler 无需改动。
 */
export function validatePresetPrompt(preset: unknown): void {
  if (typeof preset !== 'object' || preset === null || Array.isArray(preset)) return
  const rawPrompt = (preset as Record<string, unknown>)['prompt']
  if (rawPrompt === undefined || rawPrompt === null) return
  if (typeof rawPrompt !== 'object' || Array.isArray(rawPrompt)) {
    throw new PresetGuardError('模式提示词形状非法：prompt 必须是对象')
  }
  const container = rawPrompt as Record<string, unknown>
  const lengths: Record<'replace' | 'append', number> = { replace: 0, append: 0 }
  for (const segmentKey of ['replace', 'append'] as const) {
    const rawSegment = container[segmentKey]
    if (rawSegment === undefined || rawSegment === null) continue
    if (typeof rawSegment !== 'object' || Array.isArray(rawSegment)) {
      throw new PresetGuardError(`模式提示词形状非法：prompt.${segmentKey} 必须是对象`)
    }
    const segment = rawSegment as Record<string, unknown>
    const enabled = segment['enabled']
    const prompt = segment['prompt']
    if (typeof enabled !== 'boolean') {
      throw new PresetGuardError(`模式提示词形状非法：prompt.${segmentKey}.enabled 必须是 boolean`)
    }
    if (typeof prompt !== 'string') {
      throw new PresetGuardError(`模式提示词形状非法：prompt.${segmentKey}.prompt 必须是 string`)
    }
    if (prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      throw new PresetGuardError(
        `模式提示词 prompt.${segmentKey} 长度 ${prompt.length} / ${SYSTEM_PROMPT_MAX_LENGTH} 字符，超出单段上限，请精简该段`,
      )
    }
    lengths[segmentKey] = prompt.length
  }
  const total = lengths.replace + lengths.append
  if (total > SYSTEM_PROMPT_MAX_LENGTH) {
    throw new PresetGuardError(
      `模式提示词合计 ${total} / ${SYSTEM_PROMPT_MAX_LENGTH} 字符，请精简总长`,
    )
  }
}

/**
 * resolve(preset, cwd) 的返回形状（设计文档 §8.1）。
 *
 * 本 wave 只声明类型（供 wave2 实现 + wave3 session-lifecycle 消费），不实现 resolve。
 */
export interface PresetResolution {
  /** builtin 永远前置 + extensionMode 过滤的用户 extension 路径（设计 §2.3/§2.4） */
  extensionPaths: string[]
  /**
   * noSkills=true 时空数组（清空所有 skill）；否则 undefined（B1 修复）。
   *
   * undefined 语义：让 session-lifecycle 的 `resolution?.skillPaths ?? getSkillPaths(cwd)`
   * 触发 `??` fallback 到现有 getSkillPaths 结果（设计 §2.2）。
   *
   * ⚠️ 不能用 []（truthy）表示「不覆盖」——那样 `??` 永远不 fallback，所有用 presetId
   * 启动的 session 都会拿到空 skillPaths，所有 skill 失效（BLOCKER B1 根因）。
   */
  skillPaths: string[] | undefined
  /** 工具相关 args（all/allowlist/denylist/none 四模式，设计 §2.5） */
  toolArgs: { tools?: string[]; excludeTools?: string[]; noTools?: boolean }
  /** 其他 args（noSkills 映射 --no-skills，noContextFiles 映射 --no-context-files） */
  flags: { noSkills: boolean; noContextFiles: boolean }
  /** 覆盖模型（受 Landing Chip 覆盖，设计 §5.2） */
  modelOverride?: string
  /** 覆盖思考级别（受 Landing Chip 覆盖，设计 §5.2） */
  thinkingLevel?: string
  /**
   * 模式提示词（已过读路段级折叠的合法值）。
   *
   * 由 resolve() 填入（直接取类型化 preset.prompt，不重复跑折叠——折叠只属读盘入口
   * coercePreset），供 launch-params 的两个取值 helper 消费（设计 §7.2）。
   * 未配置 / 读路段级折叠后无剩余段时为 undefined。
   *
   * 与 skillPaths 不同，undefined 即「无模式提示词」（无 ?? fallback 语义）。
   */
  prompt?: PresetPromptConfig
  /**
   * 模式回落事实（F1，设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）：
   * 请求的 presetId 定义不可得、本次 resolve 已回落 builtin:full 时，填原（悬空）presetId。
   *
   * 由 `resolveLaunchPresetOptions`（launch-params.ts）在 fallback 分支附加——**不是**
   * `PresetService.resolve()` 的产物（resolve 只认已到手的 preset 定义）。
   *
   * 两个消费面口径不同，勿混：
   * - **UI 披露位**（`SessionSummary.launchPresetFallbackTo`）仅 restore 置位；create/fork
   *   不置位（回落照常发生但 UI 不披露）。
   * - **trace env 三路同注**：create/restore/fork 均经 `buildPresetFallbackEnv` 出站，
   *   故 fork/create 的 trace entry 仍会带 `presetFallback`。
   */
  fellBackFromPresetId?: string
}

/**
 * PresetService — Pi 启动参数预设的存储 + CRUD + resolve 服务。
 *
 * 设计文档 §8.1 API。本 wave 实现 CRUD，resolve 留给 wave2。
 */
export class PresetService {
  /**
   * S-RT-2：pi-presets.json 的 mtime 缓存（参考 session-file-utils.ts sessionMetaCache 模式）。
   *
   * 动机：getPreset → getAllPresets → readFileSync + JSON.parse 每次都做真实 IO。
   * 频繁 session 创建（每个 create() 触发 getLaunchPresetOptions → getPreset）时多次读盘。
   *
   * 策略：缓存键为 (mtimeMs, size)（INVAR-cache-2 SR4 模式，同 ms 内并发 append mtimeMs
   * 不变但 size 变 → miss 消除竞态）。读取时 statSync，键匹配则用缓存值，否则读盘 + 更新缓存。
   * savePresetsFile 写盘后立即 invalidate（写后必然 size/mtime 变，下次读会 miss 重读——
   * 但 invalidate 让本次已知新值可直接用，避免一次冗余重读）。
   *
   * 缓存值是已 parse + coerce 的 PiPresetsFile（含默认骨架兜底），命中时直接返回，跳过 JSON.parse。
   */
  private presetFileCache: { mtimeMs: number; size: number; file: PiPresetsFile } | undefined

  constructor(
    private readonly configStore: IConfigStore,
    // extensionService 本 wave 不用，但 wave2 的 resolve 依赖它（getDiscoveredAndDisabled）。
    // 提前对齐双参构造，避免 wave2 改构造签名 → 破坏 wave3 组合根 + 所有测试构造点。
    private readonly extensionService: IExtensionService,
  ) {}

  // ── 文件 IO（参考 config-service.ts L216-248 范式）──

  /**
   * pi-presets.json 路径：getDataDir 根（与 config.json/system-prompt.json 同级）。
   * 用 configStore.getConfigDir() port 动态推导（设计文档 §1.4 + 架构约定 #2 禁硬编码）。
   */
  private piPresetsPath(): string {
    return join(this.configStore.getConfigDir(), 'pi-presets.json')
  }

  /**
   * 加载 pi-presets.json（容错，S-RT-2：带 mtime 缓存）。
   *
   * 容错策略（与 config-service.loadAppConfig L216-232 对齐）：
   *   - 文件不存在 → 空骨架兜底（presets: []）
   *   - JSON 畸形 → 空骨架兜底 + console.warn（不抛错）
   *   - 顶层非对象/presets 非数组 → 空骨架兜底 + console.warn
   *
   * 缓存：statSync 拿 (mtimeMs, size)，命中缓存键则直接返回缓存 file（跳过 readFileSync + JSON.parse）；
   * miss 或 stat 失败则读盘解析并更新缓存。返回的 PiPresetsFile 是深拷贝，避免调用方 mutation 污染缓存。
   */
  private loadPresetsFile(): PiPresetsFile {
    const path = this.piPresetsPath()
    // S-RT-2：先 stat 查缓存（与 session-file-utils.scanSessionMeta 同模式）
    let stat
    try {
      stat = statSync(path)
    } catch {
      // 文件不存在/不可读：清 stale 缓存（INVAR-cache-4 模式），返回空骨架兜底
      this.presetFileCache = undefined
      return { presets: [], version: 1 }
    }
    const cached = this.presetFileCache
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // 命中：返回深拷贝（调用方会 mutate file 对象，不能返回缓存引用）
      return clonePresetsFile(cached.file)
    }
    // miss：读盘 + 解析 + 更新缓存
    const file = this.parsePresetsFileFromDisk(path)
    this.presetFileCache = { mtimeMs: stat.mtimeMs, size: stat.size, file }
    return clonePresetsFile(file)
  }

  /**
   * 从磁盘读取并解析 pi-presets.json（容错，S-RT-2 抽出以便 loadPresetsFile 复用）。
   *
   * 主函数只留编排：读文件容错（readPresetsObject）→ presets 逐项 coerce →
   * usage/defaultPresetId 透传兜底。
   */
  private parsePresetsFileFromDisk(path: string): PiPresetsFile {
    if (!existsSync(path)) {
      return { presets: [], version: 1 }
    }
    const obj = readPresetsObject(path)
    if (!obj) {
      return { presets: [], version: 1 }
    }
    // 逐项类型守卫：只接受形似 PiLaunchPreset 的对象，丢弃畸形项（防御性，不抛错）。
    // W-RT-1：coercePreset 内含 toolMode/extensionMode 枚举白名单校验。
    const presets = coercePresetsArray(
      Array.isArray(obj['presets']) ? obj['presets'] as unknown[] : [],
    )
    // 透传 usage（FR-14 的持久化字段，load 容错不做强类型守卫，
    // 与 defaultPresetId 同策略：只校验顶层存在性，值合法性由消费方在使用时兜底）
    const usage = coerceRecordField(obj['usage'])
    const defaultPresetId = typeof obj['defaultPresetId'] === 'string' ? obj['defaultPresetId'] as string : undefined
    const file: PiPresetsFile = {
      presets,
      defaultPresetId,
      // usage 用 as 保持 PiPresetsFile 兼容（值是 Record<string, PresetUsageEntry>，
      // 已知字段类型不安全但与原实现一致——load 容错不抛错，消费方信任读到的形状）
      usage: usage as PiPresetsFile['usage'],
      version: 1,
    }
    // [HISTORICAL] FR-15（per-cwd 默认预设）已随 state-truth-sync U9 全链删除，perCwdDefaults
    // 字段无消费者。存量数据惰性清除：读盘检出即剥离重写（清除失败只 warn 不抛——驻留数据
    // 本身无害，不应因清除失败拖垮 preset 域全部 RPC）。写盘内容已无该字段，收敛一次不重写。
    if (obj['perCwdDefaults'] !== undefined) {
      try {
        this.savePresetsFile(file)
      } catch (e) {
        // best-effort 降级：存量数据清洗失败不应阻塞 preset 加载；warn 可观测，下次 load 重试。
        console.warn('[preset-service] failed to purge legacy perCwdDefaults field:', e)
      }
    }
    return file
  }

  /**
   * 保存 pi-presets.json（atomicWrite + 唯一 tmp 后缀，与 config-service.saveAppConfig 同模式）。
   *
   * S-RT-2：写盘后立即 invalidate 缓存（写后 mtime/size 必变，但显式清避免下一次读的 stat 比对冗余，
   * 且防止 atomicWrite 的 tmp rename 时序下读到旧 mtime 的极端竞态——下次 loadPresetsFile 会重新 stat + 读盘）。
   */
  private savePresetsFile(file: PiPresetsFile): void {
    const cd = this.configStore.getConfigDir()
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    const path = this.piPresetsPath()
    atomicWrite(path, JSON.stringify(file, null, JSON_INDENT), uniqueTmpSuffix())
    // S-RT-2：写盘后失效缓存。下次 loadPresetsFile 会重新 stat + 读盘拿到新内容。
    this.presetFileCache = undefined
  }

  // ── 合并逻辑（参考 mergeSystemPromptConfig L573-596 字段级合并范式）──

  /**
   * 合并 DEFAULT_PRESETS 与 user presets（设计文档 §1.4）。
   *
   * 合并规则：
   *   - 以 DEFAULT_PRESETS 为基底
   *   - user presets 中 builtin:true 项按 id 命中 DEFAULT → 字段级合并（user 字段覆盖，缺失字段从 DEFAULT 兜底）
   *   - user presets 中 builtin:false 项追加（自定义预设）
   *   - 按 (order, id) 复合键升序排序（保证全序确定，规避 sort 稳定性依赖）
   *
   * 保护判定：用「id 命中 DEFAULT_PRESETS.id 集合」而非前缀匹配（防用户自定义 'builtin:foo' 误判，r2）。
   */
  private mergePresets(userPresets: PiLaunchPreset[]): PiLaunchPreset[] {
    const defaultById = new Map<string, PiLaunchPreset>(DEFAULT_PRESETS.map(p => [p.id, p]))
    const result: PiLaunchPreset[] = []

    // 1. 合并 DEFAULT（user 中命中 id 的覆盖字段，否则用 DEFAULT 原值）
    for (const def of DEFAULT_PRESETS) {
      const userOverride = userPresets.find(p => p.id === def.id && p.builtin === true)
      if (userOverride) {
        result.push({ ...def, ...userOverride, id: def.id, builtin: true, order: def.order })
      } else {
        result.push({ ...def })
      }
    }

    // 2. 追加 user 自定义（builtin:false，且 id 不与 DEFAULT 冲突）
    for (const u of userPresets) {
      if (defaultById.has(u.id)) continue // 已在 step1 处理（含 builtin:false 的同 id 项也跳过，防 id 冲突）
      if (u.builtin === true) continue // 非 DEFAULT id 的 builtin:true 是脏数据，忽略
      result.push({ ...u })
    }

    // 3. 排序：(order, id) 复合键，规避 sort 稳定性依赖（r1）
    return result.sort((a, b) =>
      a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  // ── 公开 API（设计文档 §8.1）──

  /** 加载所有预设：内置默认 + 用户自定义（含对内置的覆盖合并）。 */
  getAllPresets(): PiLaunchPreset[] {
    return this.mergePresets(this.loadPresetsFile().presets)
  }

  /** 获取单个预设。找不到返回 undefined（builtin:full 总能找到，由 DEFAULT 兜底）。 */
  getPreset(presetId: string): PiLaunchPreset | undefined {
    return this.getAllPresets().find(p => p.id === presetId)
  }

  /**
   * 获取默认预设 ID（pi-presets.json 的 defaultPresetId，缺省 BUILTIN_PRESET_IDS.FULL）。
   *
   * W-RT-3：校验 defaultPresetId 是否存在于 merge 后的 preset 列表（DEFAULT + 用户自定义）。
   * 不存在（指向已删 preset / 历史脏数据）→ 回退 BUILTIN_PRESET_IDS.FULL，避免 Landing 拿到僵尸 id
   * 导致 getLaunchPresetOptions 返回 undefined（无 preset 配置，静默降级到默认 args）。
   */
  getDefaultPresetId(): string {
    const file = this.loadPresetsFile()
    return this.resolveDefaultPresetId(file)
  }

  /**
   * 计算「有效」默认 preset id（W-RT-3 抽出，getDefaultPresetId 共用）。
   *
   * 校验：defaultPresetId 非空且存在于 merge 后的 presets 列表（含 DEFAULT 兜底，builtin:full 总存在）。
   * 不存在 → 回退 BUILTIN_PRESET_IDS.FULL。
   */
  private resolveDefaultPresetId(file: PiPresetsFile): string {
    const candidate = file.defaultPresetId
    if (!candidate) return BUILTIN_PRESET_IDS.FULL
    // 校验存在性：在 merge 后的 presets 里查（DEFAULT_PRESETS 兜底，builtin:full 永远存在）
    const allIds = new Set(this.mergePresets(file.presets).map(p => p.id))
    return allIds.has(candidate) ? candidate : BUILTIN_PRESET_IDS.FULL
  }

  /** 设为默认（写 defaultPresetId 字段）。 */
  setDefaultPresetId(presetId: string): void {
    const file = this.loadPresetsFile()
    file.defaultPresetId = presetId
    this.savePresetsFile(file)
  }

  /**
   * 保存预设（新增或更新）。
   *
   * 内置预设（id 命中 DEFAULT_PRESETS.id 集合）的「不可改」字段保护（设计文档 §3.4）：
   *   - 强制保留 id / builtin / order / name 四字段（用 DEFAULT 的值，忽略传入值）
   *   - 传入 builtin:false 但 id 命中 builtin → 抛 PresetGuardError（防降级逃逸保护）
   *   - 其余字段按传入值覆盖
   *
   * 自定义预设（id 不在 DEFAULT）：
   *   - 强制 builtin:false（防止用户传 builtin:true 伪造内置预设）
   */
  savePreset(preset: PiLaunchPreset): void {
    // 唯一写点入口守卫：模式提示词整条拒绝（形状 / 段限 / 合计限），抛 PresetGuardError。
    // 放在 builtin 字段保护之前：非法提示词不应因后续保护逻辑改写而混过（且避免无谓读盘）。
    validatePresetPrompt(preset)
    const file = this.loadPresetsFile()
    const isBuiltinId = DEFAULT_PRESETS.some(p => p.id === preset.id)

    if (isBuiltinId) {
      // 防降级逃逸：builtin id 但传入 builtin:false
      if (preset.builtin !== true) {
        throw new PresetGuardError(
          `cannot change builtin flag of builtin preset '${preset.id}' to false`,
        )
      }
      // 字段保护：id/builtin/order/name 来自 DEFAULT，忽略传入
      const def = DEFAULT_PRESETS.find(p => p.id === preset.id)!
      const protectedPreset: PiLaunchPreset = {
        ...preset,
        id: def.id,
        builtin: true,
        order: def.order,
        name: def.name,
      }
      upsertById(file.presets, protectedPreset)
    } else {
      // 新自定义：强制 builtin:false（防伪造）
      const customPreset: PiLaunchPreset = { ...preset, builtin: false }
      upsertById(file.presets, customPreset)
    }
    this.savePresetsFile(file)
  }

  /**
   * 删除预设。内置 preset 抛 PresetGuardError（设计文档 §3.4 不可删）。
   * 自定义 preset 不存在时 no-op（不抛错）。
   *
   * W-RT-2：删除后清理对被删 preset 的引用：
   *   - 若 file.defaultPresetId === presetId → 清空（回退到 BUILTIN_PRESET_IDS.FULL，下次 getDefaultPresetId 兜底）
   * 避免 Landing / restoreSession 拿到僵尸 id（getLaunchPresetOptions 拿不到 preset 返回 undefined）。
   * [HISTORICAL] perCwdDefaults 条目清理已随 FR-15 删除（state-truth-sync U9）。
   */
  deletePreset(presetId: string): void {
    if (DEFAULT_PRESETS.some(p => p.id === presetId)) {
      throw new PresetGuardError(`cannot delete builtin preset '${presetId}'`)
    }
    const file = this.loadPresetsFile()
    const before = file.presets.length
    file.presets = file.presets.filter(p => p.id !== presetId)
    let changed = file.presets.length !== before

    // W-RT-2：清理 defaultPresetId 指向被删 preset 的引用
    if (file.defaultPresetId === presetId) {
      file.defaultPresetId = undefined
      changed = true
    }
    // 仅当确实有变更时才写盘（no-op 时不触发 IO + cache invalidate）
    if (changed) {
      this.savePresetsFile(file)
    }
  }

  // ── FR-14：预设使用统计 ──────────────────────────────────────

  /**
   * 记录一次预设使用（session 创建时调用）。
   * 原子操作：load → mutate → save，无并发保护（单用户桌面应用，写冲突概率极低）。
   */
  recordUsage(presetId: string): void {
    const file = this.loadPresetsFile()
    if (!file.usage) file.usage = {}
    const entry = file.usage[presetId]
    if (entry) {
      entry.count += 1
      entry.lastUsed = Date.now()
    } else {
      file.usage[presetId] = { count: 1, lastUsed: Date.now() }
    }
    this.savePresetsFile(file)
  }

  /** 获取全部预设使用统计（供前端展示排序）。 */
  getUsage(): Record<string, import('@taiji/shared').PresetUsageEntry> {
    return this.loadPresetsFile().usage ?? {}
  }

  // ── FR-13：预设导入/导出 ─────────────────────────────────────

  /**
   * 导出全部预设为 JSON 字符串（前端通过 electronAPI 文件对话框保存）。
   * 导出格式：{ presets, defaultPresetId, version }（不含 usage，避免跨机器泄漏）。
   */
  exportPresets(): string {
    const file = this.loadPresetsFile()
    return JSON.stringify({ presets: file.presets, defaultPresetId: file.defaultPresetId, version: 1 }, null, JSON_INDENT)
  }

  /**
   * 从 JSON 字符串导入预设（合并策略：自定义预设追加，内置预设字段级合并）。
   * 返回导入的预设数量。格式校验失败抛 Error。
   */
  importPresets(json: string): number {
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      throw new Error('Invalid JSON format')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Import file must be a JSON object')
    }
    const obj = raw as Record<string, unknown>
    const importedRaw = Array.isArray(obj['presets']) ? obj['presets'] as unknown[] : []
    const imported: PiLaunchPreset[] = []
    for (const p of importedRaw) {
      // 校验顺序不可颠倒：先 validatePresetPrompt（整条拒）→ 再 coercePreset（形状折叠）。
      // 反过来会让超限段被段级折叠丢掉并 warn，「导入路整条拒」永不触发，用户以为导入成功
      // 但提示词没了（静默降级）。超限项在此抛出 → 整个 import 中止，不写盘。
      validatePresetPrompt(p)
      const typed = coercePreset(p)
      if (typed) imported.push(typed)
    }
    if (!imported.length) {
      throw new Error('No valid presets found in import file')
    }
    // 合并：load → mergePresets(imported) → save
    const file = this.loadPresetsFile()
    const merged = this.mergePresets([...file.presets, ...imported])
    file.presets = merged
    this.savePresetsFile(file)
    return imported.length
  }

  // ── resolve（设计文档 §8.1，wave2 实现）──

  /**
   * 根据 preset + cwd 解析为 RpcClientOptions 的扩展字段。
   *
   * 设计文档 §8.1：返回值供 session-lifecycle 覆盖现有 getExtensionPaths/getSkillPaths 结果。
   * - extensionPaths：builtin 永远前置 + extensionMode 过滤的用户 extension（§2.3/§2.4）
   * - skillPaths：noSkills=true 时空数组；否则空数组（wave3 session-lifecycle 用 flags.noSkills
   *   决定是否用现有 getSkillPaths 兜底——PresetService 不跨域依赖 ConfigService，见 wave2 设计 t1）
   * - toolArgs：toolMode 4 模式映射（§2.5）
   * - flags：noSkills/noContextFiles 透传
   * - modelOverride/thinkingLevel：透传（受 Landing Chip 覆盖，§5.2 由 wave3 处理）
   */
  async resolve(preset: PiLaunchPreset, cwd: string): Promise<PresetResolution> {
    const extensionPaths = await this.resolveExtensionPaths(preset, cwd)
    return {
      extensionPaths,
      skillPaths: this.resolveSkillPaths(preset),
      toolArgs: this.resolveToolArgs(preset),
      flags: {
        noSkills: preset.noSkills ?? false,
        noContextFiles: preset.noContextFiles ?? false,
      },
      modelOverride: preset.modelOverride,
      thinkingLevel: preset.thinkingLevel,
      // 模式提示词透传：preset 已是类型化对象（非 raw），直接取 preset.prompt。
      // 不在此重复跑 coercePresetPrompt——折叠只属读盘入口（coercePreset）；非法/超限段
      // 在读路（段级折叠）与写路（整条拒）已拦下，不会进入 resolution。
      prompt: preset.prompt,
    }
  }

  /**
   * 解析 extensionPaths（设计文档 §2.3/§2.4）。
   *
   * M1：不调 getExtensionPaths(cwd)（其已做 enabled 过滤，preset 需要原始集合自筛），
   * 改为调 getDiscoveredAndDisabled(cwd) 拿原始 discovered + disabled，本地 resolveExtensions
   * + applyPresetMode 完成过滤。
   *
   * [builtin npm 化（34234fb66）] builtin = mandatory-extensions.json 里 tier=infrastructure
   * 的 npm 包，随 discovery 进入 discovered 集合，由 applyPresetMode 保活——旧文件型
   * getBuiltinExtensionPaths 路径前置已随迁移消亡，本函数无独立 builtin 注入。
   *
   * 用户 extension 按 mode 二次筛选：
   *   - all: 全部 enabled
   *   - allowlist: enabled && name in preset.allowedExtensions
   *   - denylist: enabled && name not in preset.deniedExtensions
   *   - none: 空（仅 infrastructure 存活）
   *
   * tier 语义（applyPresetMode 内置）：
   *   - infrastructure 包（presetOverridable=false）：任何模式都存活，不可覆盖
   *   - feature mandatory / 普通包：presetOverridable=true，按 mode 过滤
   */
  private async resolveExtensionPaths(preset: PiLaunchPreset, cwd: string): Promise<string[]> {
    const { discovered, disabledSet } = await this.extensionService.getDiscoveredAndDisabled(cwd)

    // 一次读盘：disabled 过滤 + tier 推导
    const resolved = resolveExtensions(discovered, disabledSet)
    // P7：加载层同名去重（与 getExtensionPaths 一致——preset 分支同样注入 --extension，
    // discovery 目录与 settings npm 版同名时只保留受管版，避免 pi Tool conflicts）
    const deduped = dedupeLoadedExtensions(resolved)
    // preset mode 二次筛选（infrastructure 在任何模式下都存活）
    const afterPreset = applyPresetMode(
      deduped,
      preset.extensionMode,
      preset.allowedExtensions ?? [],
      preset.deniedExtensions ?? [],
    )
    // 过滤后可加载的路径（builtin infrastructure 包已在 deduped 内，见函数头注释）。
    // .filter(r => r.loadable) 排除被 disabled 的普通包（applyPresetMode 不过滤 disabled，
    // 只按 preset mode 过滤 presetOverridable/name，disabled 过滤在此完成）
    return afterPreset.filter(r => r.loadable).map(r => r.path)
  }

  /**
   * 解析 skillPaths（设计文档 §2.2，B1 修复）。
   *
   * 返回值语义：
   *   - noSkills=true → 返 []（清空所有 skill；session-lifecycle 用此空数组，不 fallback）
   *   - noSkills=false/undefined → 返 undefined（「不覆盖」语义；session-lifecycle 的
   *     `resolution?.skillPaths ?? getSkillPaths(cwd)` 触发 ?? fallback 到现有 getSkillPaths）
   *
   * ⚠️ BLOCKER B1：原实现两个分支都返 []（truthy），导致 `?? getSkillPaths` 永远不触发，
   * 所有用 presetId 启动的 session 都拿到空 skillPaths，所有 skill 失效。
   */
  private resolveSkillPaths(preset: PiLaunchPreset): string[] | undefined {
    return preset.noSkills === true ? [] : undefined
  }

  /**
   * 解析 toolArgs（设计文档 §2.5）。
   *
   *   - all: {}（不传工具 flag，用 pi 默认）
   *   - allowlist: { tools: allowedTools }（替换语义 --tools）
   *   - denylist: { excludeTools: deniedTools }（叠加语义 --exclude-tools）
   *   - none: { noTools: true }（--no-tools）
   */
  private resolveToolArgs(preset: PiLaunchPreset): PresetResolution['toolArgs'] {
    switch (preset.toolMode) {
      case 'all':
        return {}
      case 'allowlist':
        return { tools: preset.allowedTools ?? [] }
      case 'denylist':
        return { excludeTools: preset.deniedTools ?? [] }
      case 'none':
        return { noTools: true }
      // W-RT-1 兜底：coercePreset 已白名单校验，理论上走不到 default；
      // 防御性兜底（脏数据绕过 coerce）按 'all' 处理（不传任何工具 flag，用 pi 默认），
      // 保证函数有返回值，避免 TS「函数缺少返回语句」与运行时 undefined。
      default:
        return {}
    }
  }
}

// ── 内部 helpers ──────────────────────────────────────────────────

/**
 * 读 pi-presets.json 原始内容并校验顶层形状（容错）。
 *
 * 容错策略（与 config-service.loadAppConfig L216-232 对齐）：
 *   - JSON 畸形 → console.warn + undefined（调用方兜底空骨架，不抛错）
 *   - 顶层非对象/数组/null → console.warn + undefined
 */
function readPresetsObject(path: string): Record<string, unknown> | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    console.warn(`[preset-service] pi-presets.json is not valid JSON, ignoring: ${stringifyError(e)}`)
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn('[preset-service] pi-presets.json top-level is not an object, ignoring')
    return undefined
  }
  return raw as Record<string, unknown>
}

/** presets 数组逐项 coerce（coercePreset 校验失败的畸形项直接丢弃）。 */
function coercePresetsArray(presets: unknown[]): PiLaunchPreset[] {
  const validPresets: PiLaunchPreset[] = []
  for (const p of presets) {
    const typed = coercePreset(p)
    if (typed) validPresets.push(typed)
  }
  return validPresets
}

/**
 * coerce Record 形状的持久化字段（usage 用，FR-14）：
 * 普通对象原样透传，其余（缺失/数组/标量）返回 undefined。不做强类型守卫，
 * 值合法性由消费方在使用时兜底（与 defaultPresetId 同策略）。
 */
function coerceRecordField(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 段级折叠模式提示词（读路 / 导入折叠用）。
 *
 * 与 validatePresetPrompt 的「整条拒绝」相对：畸形/超限的 prompt 段**只丢该段**，
 * 记 issues（调用方 warn 日志），不因此丢掉整个 preset、不阻断文件加载。
 *
 * 函数拆分的理由（写进代码）：coercePreset 现有返回类型是 `T | undefined`（整条级），无法同时
 * 表达「段级丢 + 整体报错」——故拆成「段级折叠（本函数）+ 整体校验（validatePresetPrompt）」
 * 两个函数，调用方各自选语义，不靠布尔参数猜。
 *
 * 合计限与丢段顺序（堵直改盘旁路）：直改 pi-presets.json 无 UI 约束，故段级折叠也必须执行
 * 合计判定——合计超限时**优先丢 append 段**（保留 replace：替换段语义更重且用户更难自恢复），
 * issues 记实际合计值与丢弃了哪一段。段级超限（单段 > 16000）同样丢该段。
 */
function coercePresetPrompt(raw: unknown): { value?: PresetPromptConfig; issues: string[] } {
  const issues: string[] = []
  if (raw === undefined || raw === null) return { issues }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('prompt 形状非法（非对象），已丢弃全部提示词段')
    return { issues }
  }
  const container = raw as Record<string, unknown>
  const value: PresetPromptConfig = {}
  for (const segmentKey of ['replace', 'append'] as const) {
    const segment = coercePresetPromptSegment(segmentKey, container[segmentKey], issues)
    if (segment) value[segmentKey] = segment
  }
  const total = (value.replace?.prompt.length ?? 0) + (value.append?.prompt.length ?? 0)
  if (total > SYSTEM_PROMPT_MAX_LENGTH) {
    // 两段各自 ≤ 段限却合计超限 → 必然两段都在场；优先丢 append 保留 replace。
    if (value.append) {
      delete value.append
      issues.push(
        `模式提示词合计 ${total} / ${SYSTEM_PROMPT_MAX_LENGTH} 字符超限，已丢弃 append 段并保留 replace 段`,
      )
    } else if (value.replace) {
      delete value.replace
      issues.push(
        `模式提示词合计 ${total} / ${SYSTEM_PROMPT_MAX_LENGTH} 字符超限，已丢弃 replace 段`,
      )
    }
  }
  const hasSegment = value.replace !== undefined || value.append !== undefined
  // 可观测契约（设计 §7.1「畸形/超限只丢该段 + warn」）：raw 是普通对象但**无任何可识别段**
  //（如 `{foo:1}`）时当前实现会静默丢整个 prompt 容器——补一条 issue 让丢弃可见（仍丢弃，
  // 只增可观测性）。**只记键名不记值**：值可能是用户提示词正文，不应进日志。
  // 条件用「容器无 replace/append 键」而非「value 为空」：`{replace: <畸形>}` 已由段级 issue
  // 覆盖，再叠一条会误导（键是被识别的，只是值非法）。
  const containerKeys = Object.keys(container)
  const hasKnownSegmentKey = containerKeys.includes('replace') || containerKeys.includes('append')
  if (!hasSegment && !hasKnownSegmentKey && containerKeys.length > 0) {
    issues.push(`prompt 容器无可识别段（键：${containerKeys.join(', ')}），已丢弃全部提示词段`)
  }
  return hasSegment ? { value, issues } : { issues }
}

/** 折叠单段模式提示词；畸形/超限返回 undefined 并追加一条 issue。 */
function coercePresetPromptSegment(
  segmentKey: 'replace' | 'append',
  raw: unknown,
  issues: string[],
): PresetPromptSegment | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`prompt.${segmentKey} 形状非法（非对象），已丢弃该段`)
    return undefined
  }
  const segment = raw as Record<string, unknown>
  const enabled = segment['enabled']
  const prompt = segment['prompt']
  if (typeof enabled !== 'boolean' || typeof prompt !== 'string') {
    issues.push(`prompt.${segmentKey} 字段类型非法（enabled 须 boolean / prompt 须 string），已丢弃该段`)
    return undefined
  }
  if (prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    issues.push(
      `prompt.${segmentKey} 长度 ${prompt.length} / ${SYSTEM_PROMPT_MAX_LENGTH} 字符超出单段上限，已丢弃该段`,
    )
    return undefined
  }
  return { enabled, prompt }
}

/**
 * 把磁盘读到的 raw（unknown）尝试 coerce 成 PiLaunchPreset。
 * 不通过返回 undefined（loadPresetsFile 会丢弃）。
 *
 * 必须有 id(string) + name(string) + builtin(boolean) + order(number) + toolMode + extensionMode。
 *
 * W-RT-1：额外校验 toolMode/extensionMode 必须在枚举白名单内（VALID_TOOL_MODES /
 * VALID_EXTENSION_MODES）。脏数据（如导入文件里 toolMode: "DROP TABLE"）不在白名单 →
 * 返回 undefined，preset 被丢弃，避免 resolveToolArgs/resolveExtensionPaths 的 switch 落空。
 *
 * 模式提示词是**段级折叠**（非整条丢弃）：畸形/超限只丢该段 + warn（issues），不丢整个 preset。
 * 整条拒绝只发生在写路/导入路（validatePresetPrompt）。
 */
function coercePreset(raw: unknown): PiLaunchPreset | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const toolMode = r['toolMode']
  const extensionMode = r['extensionMode']
  if (
    typeof r['id'] !== 'string' ||
    typeof r['name'] !== 'string' ||
    typeof r['builtin'] !== 'boolean' ||
    typeof r['order'] !== 'number' ||
    typeof toolMode !== 'string' ||
    typeof extensionMode !== 'string' ||
    // W-RT-1：枚举白名单校验——脏数据（非合法 mode 值）丢弃
    !(VALID_TOOL_MODES as readonly string[]).includes(toolMode) ||
    !(VALID_EXTENSION_MODES as readonly string[]).includes(extensionMode)
  ) {
    return undefined
  }
  // 必填字段已验证，其余字段直接透传（PiLaunchPreset 的可选字段保持 unknown→具体类型由调用方信任）
  // 双重断言：先 unknown 再 PiLaunchPreset（r 是 Record<string, unknown>，直接断言 TS 报不重叠）。
  const preset = { ...(r as unknown as PiLaunchPreset) }
  // 模式提示词段级折叠：畸形/超限只丢该段 + warn，不丢整个 preset。
  const { value: prompt, issues } = coercePresetPrompt(r['prompt'])
  if (issues.length > 0) {
    console.warn(
      `[preset-service] preset '${preset.id}' 模式提示词段级折叠：${issues.join('；')}`,
    )
  }
  if (prompt === undefined) {
    // raw 可能带畸形 prompt（已在上面 spread 进来的非对象/超限值），必须显式移除。
    delete preset.prompt
  } else {
    preset.prompt = prompt
  }
  return preset
}

/** 按 id upsert（存在则替换，不存在则追加）。就地修改 presets 数组。 */
function upsertById(presets: PiLaunchPreset[], preset: PiLaunchPreset): void {
  const idx = presets.findIndex(p => p.id === preset.id)
  if (idx >= 0) {
    presets[idx] = preset
  } else {
    presets.push(preset)
  }
}

/**
 * 深拷贝 PiPresetsFile（S-RT-2）。
 *
 * loadPresetsFile 命中缓存时不能直接返回缓存引用——调用方（savePreset/deletePreset/
 * setDefaultPresetId 等）会 mutate file 对象（push/filter/赋值），返回引用会污染缓存。
 * 用 structuredClone 做完整深拷贝（PiLaunchPreset 是纯数据，无函数/循环引用，安全）。
 */
function clonePresetsFile(file: PiPresetsFile): PiPresetsFile {
  return structuredClone(file)
}

/**
 * 把 Error/unknown 转为字符串（容错 warn 日志用）。
 * 避免直接 String(e) 把对象输出成 [object Object]。
 */
function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
