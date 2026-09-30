/**
 * provider-edit-models —— Provider 编辑「模型清单 CRUD」module（[C4] 拆分自 use-provider-edit.ts）。
 *
 * 承载：localModels 编辑副本（B-2 聚合层标注过滤）+ 新增模型表单（newModel，D4 reasoning 显式化）
 * + 行级 CRUD（输入类型 / 上下文 / 思考策略 / compat 展开）+ 两条清单合并规则：
 * - load/save 的 **builtin ∪ override 回传规则**（buildModelsPayload：catalog 只回传 override
 *   条目，builtin 不回传——runtime 合并语义 builtin ∪ override 会自动补齐内置模型，回传 builtin
 *   会把内置定义冻结成 override）
 * - discover 合并（mergeDiscoveredModels：去重 + D9① 出厂显式 reasoning）
 *
 * 接口即测试面（interface is the test surface）：行为矩阵见 provider-edit-models.test.ts。
 */
import { ref, reactive, watch, type Ref } from 'vue'
import type { ProviderInfo, SetProviderData } from '@taiji/shared'
import type { Translate } from './provider-edit-types'

// ── 类型 ──

/** ProviderInfo.models 元素（LocalModel 的单源基底——shared 读侧模型条目形状）。 */
export type ProviderModelEntry = ProviderInfo['models'][number]

/** 本地编辑态模型（ProviderInfo.models 的可编辑副本）。
 *  形状经 extends 从 shared 单源派生：api/baseUrl/enabled 透传位（与 ProviderInfo.models
 *  元素同构，W4）+ B-4b 透传位（reasoning/maxTokens/cost/headers/compat）全部由基底声明，
 *  不再逐字段复刻（与 runtime SetProviderInput.models 的同形内联声明是跨包克隆组来源）。
 *  编辑保存时这些字段必须回传，否则 model 级配置会在 setProvider 合并时被丢弃
 *  （运行时靠 base spread 保数据不丢，但显式回传才让「编辑→保存」链路真实生效）。 */
export interface LocalModel extends ProviderModelEntry {
  /**
   * model 级计费（B-4b 透传位，含可选 tiers 分档定价）。tiers 是运行时透传：
   * 基底（ProviderInfo.models[].cost）未声明 tiers，但 spread 链（load → LocalModel → save）
   * 保留其运行时值，编辑器不构造 cost 时既有 tiers 不丢——此处补声明使透传位类型可达。
   */
  cost?: NonNullable<ProviderModelEntry['cost']> & {
    tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>
  }
  /**
   * 条目来源（B-2 聚合层标注透传）：catalog provider 的编辑列表只含非 builtin 条目
   * （见 toEditableModels），save 回传 override 条目、builtin 不回传（runtime 合并语义
   * builtin ∪ override，回传 builtin 会把内置定义冻结成 override）。不参与 setProvider payload。
   */
  source?: 'builtin' | 'override'
}

/** 思考策略预设 key（UI Select 值） */
export type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

/** 新增模型表单草稿（ModelListSection v-model 直绑） */
export interface NewModelDraft {
  name: string
  contextWindow: number
  inputTypes: Array<'text' | 'image'>
  thinking: ThinkingStrategy
  /**
   * 思考能力开关（D4 addModel reasoning 显式化，U6）：出厂显式 boolean 不允许 undefined——
   * 同一个 undefined pi 解释为「关」而旧本地推算解释为「支持」，写入时语义
   * 坍缩正是事故 B 根因。默认 true；选非 all-levels 思考策略时自动置 true（用户可显式关）。
   */
  reasoning: boolean
}

/** discover 合并入清单的发现模型形状（runtime DiscoverModelsResponse.models 元素子集） */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
}

// ── 常量 ──

/** 上下文窗口选项（template ctxOptions 来源） */
export const CONTEXT_OPTIONS = [
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 256_000 },
  { label: '512K', value: 512_000 },
  { label: '1M', value: 1_000_000 },
] as const

/**
 * 思考策略预设 → thinkingLevelMap。thinkingLevelMap 语义是 pi 的**黑名单过滤**，
 * 不是「key = UI 可选档位」的白名单（按白名单心智写预设会多出未列出的默认档）：
 * pi `getSupportedThinkingLevels`（pi-ai dist/models.js:548-558）对 reasoning=true 的
 * 模型遍历 EXTENDED_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max）逐档判定：
 * - value = null → 剔除该档
 * - xhigh / max → 必须显式列出（未列即视为不支持）
 * - 其余档（off/minimal/low/medium/high）→ 默认保留（未列也参与）
 * 所以「只保留某几档」必须把不要的档显式写 null，不能靠不写 key 实现。
 * value = 发给 pi 的实际 level（如 max 档发 xhigh），不是 key——展示是展示、传递是 value。
 * 预设：all-levels(undefined = pi 默认五档 off~high；xhigh/max 需显式映射，要最高档选 high-max)
 *      / on-off(off+high 两档) / high-max(off+high+max→xhigh 三档)
 */
const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { off: 'off', high: 'high', minimal: null, low: null, medium: null },
  'high-max': { off: 'off', high: 'high', max: 'xhigh', minimal: null, low: null, medium: null },
}

/** 思考策略 Select 选项（template thinkingStrategies 来源）。
 *  fullLabel 保留为回退展示（向后兼容旧 import）；新代码优先用 labelKey + t()。 */
export const THINKING_STRATEGIES: Array<{
  key: ThinkingStrategy
  fullLabel: string
  labelKey: string
}> = [
  { key: 'all-levels', fullLabel: 'All Levels', labelKey: 'composable.thinkingStrategy.allLevels' },
  { key: 'on-off', fullLabel: 'On / Off', labelKey: 'composable.thinkingStrategy.onOff' },
  { key: 'high-max', fullLabel: 'High / Max', labelKey: 'composable.thinkingStrategy.highMax' },
]

// ── 纯函数 helpers ──

/**
 * 可编辑模型列表（B-2 混合列表，纯）：catalog provider 过滤掉 builtin 条目（只读展示由
 * ProviderEditBody 直接读 provider.models），custom / kind 缺失（旧数据）全量保留。
 * 整对象 spread：ProviderInfo.models 元素的 B-4b 透传位（reasoning/maxTokens/cost/headers）
 * 一并进编辑副本（load 侧接线），save 时显式回传（见 buildModelsPayload）。
 */
export function toEditableModels(p: ProviderInfo): LocalModel[] {
  const editable = p.kind === 'catalog'
    ? p.models.filter((m) => m.source !== 'builtin')
    : p.models
  return editable.map((m) => ({ ...m }))
}

/**
 * 从 thinkingLevelMap 反推策略预设（Select 回显当前选中）。按可用档位 key 判定：
 * 含 max→high-max；含 high（无 max）→on-off；空→all-levels。
 */
export function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
  if (!map || Object.keys(map).length === 0) return 'all-levels'
  // 可用档位（key 存在且 value 非 null）
  const availableKeys = Object.keys(map).filter((k) => map[k] !== null)
  if (availableKeys.includes('max')) return 'high-max'
  if (availableKeys.includes('high')) return 'on-off'
  return 'all-levels'
}

/** 策略预设 → thinkingLevelMap 值（每次深拷贝，防多模型共享同一 map 引用） */
export function resolveThinkingMap(strategy: ThinkingStrategy): Record<string, string | null> | undefined {
  return THINKING_PRESETS[strategy] ? structuredClone(THINKING_PRESETS[strategy]) : undefined
}

/**
 * save 的 models 载荷（B-2 回传规则 + B-4b 透传位 round-trip，纯）：
 * - B-2：catalog provider 的 localModels 只含 override 条目（toEditableModels）——builtin
 *   不回传，runtime 合并语义 builtin ∪ override 会自动补齐内置模型。
 * - 透传 model 级 api/baseUrl/enabled：runtime setProvider 用 spread 合并 base，缺字段会被
 *   base 兜底，但显式回传避免「编辑保存丢字段」（P1 bug #4/#5）。
 * - B-4b 透传（reasoning/maxTokens/cost/headers）有值才回传（undefined 不传键，runtime 语义
 *   undefined=不变、base spread 保留既有值；与 provider 级 headers「空对象不传」不同——
 *   model 级 {} = 清空是 runtime 的两态契约，此处值忠实回传）。reasoning 显式 false 是合法值，
 *   须用 !== undefined 判定。
 */
export function buildModelsPayload(models: LocalModel[]): NonNullable<SetProviderData['models']> {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    contextWindow: m.contextWindow,
    input: m.input,
    thinkingLevelMap: m.thinkingLevelMap,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    ...(m.cost !== undefined ? { cost: m.cost } : {}),
    ...(m.headers !== undefined ? { headers: m.headers } : {}),
    compat: m.compat,
    enabled: m.enabled,
  }))
}

/**
 * discover 合并规则（纯）：按 id 去重（existing 优先），返回待追加条目 + 计数。
 * D9①：合并进来的模型出厂显式 reasoning=true（对齐 addModel）——pi 两级门控把缺失判「关」，
 * 缺字段会让思考档位恒只有「关」（失败模式 D 用户数据命中此入口）。
 */
export function mergeDiscoveredModels(
  existing: LocalModel[],
  discovered: DiscoveredModel[],
): { added: LocalModel[]; total: number } {
  const existingIds = new Set(existing.map((m) => m.id))
  const added = discovered
    .filter((m) => !existingIds.has(m.id))
    .map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: true }))
  return { added, total: discovered.length }
}

// ── module 契约 ──

/**
 * 模型清单 CRUD module（[C4] 3 组子 interface 之一）。
 *
 * ModelListSection 经 typed InjectionKey（ui injection-keys.ts 的 MODEL_LIST_DEPS_KEY）
 * 直接持有本 module（原 provide('modelListDeps') 11 成员无型缝收编为整 module + providerApi）。
 */
export interface ProviderEditModelsModule {
  /** 新增模型表单草稿 */
  readonly newModel: NewModelDraft
  /** 可编辑模型清单（B-2：catalog 只含 override 条目） */
  readonly localModels: Ref<LocalModel[]>
  /** 「手动添加」表单展开态（ModelListSection v-model:showAddModel） */
  readonly showAddModel: Ref<boolean>
  /** 展开了 compat 编辑器的 model id 集合（reactive Set，直接 mutate add/delete） */
  readonly expandedCompat: Set<string>
  /** 行级输入类型 toggle（点击 text/image icon 切换） */
  toggleInput(m: LocalModel, type: 'text' | 'image'): void
  /** 新增模型表单的输入类型 toggle（多选，与行级 toggleInput 同语义） */
  toggleNewInput(type: 'text' | 'image'): void
  /** 行级上下文窗口更新（Select） */
  updateCtx(m: LocalModel, value: number): void
  /** 行级思考策略（Select → 写 thinkingLevelMap；D9② reasoning 救回规则在此） */
  pickStrategy(m: LocalModel, strategy: ThinkingStrategy): void
  /** 从 thinkingLevelMap 反推策略预设（Select 回显） */
  getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy
  /**
   * 新增模型到清单（来自底部新增表单）。
   * D15a：空名/重名 id 抛错（调用方 catch 后填 actionError），替代原静默 return。
   * 抛错而非静默：AGENTS.md 关键规则 #3——用户操作无反馈是 bug。
   */
  addModel(): void
  /** 移除清单中指定下标的模型 */
  removeModel(index: number): void
  /** 切换某 model 的 compat 编辑器展开/收起（直接 mutate，不 new Set 复制——问题 5） */
  toggleCompatExpand(modelId: string): void
  /** discover 结果合并入清单（去重 + D9①；返回计数供结果文案） */
  mergeDiscovered(discovered: DiscoveredModel[]): { total: number; addedCount: number }
  /** provider 切换/打开时的清单载入（null = 新增态清空） */
  applyProvider(p: ProviderInfo | null): void
  /** 瞬态 UI 状态重置（面板展开态） */
  resetTransient(): void
}

/**
 * 模型清单 CRUD module 工厂。
 *
 * D4：思考策略自动推导——选非 all-levels 策略 → reasoning 自动置 true（用户可显式关；
 * 再切策略会重新推导，保持「策略变化 → 推导、用户拨动 → 直接写」的简单模型）。
 */
export function createProviderEditModels(input: { t: Translate }): ProviderEditModelsModule {
  const { t } = input

  const newModel = reactive<NewModelDraft>({
    name: '',
    contextWindow: 200_000,
    inputTypes: ['text'],
    thinking: 'on-off',
    reasoning: true,
  })
  const localModels = ref<LocalModel[]>([])
  const showAddModel = ref(false)
  const expandedCompat = reactive<Set<string>>(new Set())

  watch(
    () => newModel.thinking,
    (strategy) => {
      if (strategy !== 'all-levels') newModel.reasoning = true
    },
  )

  function toggleInput(m: LocalModel, type: 'text' | 'image'): void {
    if (!m.input) m.input = []
    const idx = m.input.indexOf(type)
    if (idx >= 0) m.input.splice(idx, 1)
    else m.input.push(type)
  }

  function toggleNewInput(type: 'text' | 'image'): void {
    const idx = newModel.inputTypes.indexOf(type)
    if (idx >= 0) newModel.inputTypes.splice(idx, 1)
    else newModel.inputTypes.push(type)
  }

  function updateCtx(m: LocalModel, value: number): void {
    m.contextWindow = value
  }

  /**
   * 行级思考策略（Select → 写 thinkingLevelMap）。
   * D9②：reasoning 缺失时补显式 true——pi 两级门控把缺失判「关」，不补则用户设的策略
   * 根本轮不到被读取（弹层只显示「关」）。永不覆盖用户显式 false（显式选择优先于联动）；
   * all-levels 与其余策略同规则——存量最常见形态正是「从未设策略 = all-levels + reasoning
   * 缺失」，救回路径必须闭合在 all-levels 分支上。
   */
  function pickStrategy(m: LocalModel, strategy: ThinkingStrategy): void {
    if (m.reasoning === undefined) m.reasoning = true
    m.thinkingLevelMap = resolveThinkingMap(strategy)
  }

  /** addModel（D15a 抛错 + D4 reasoning 显式 boolean 出厂，见接口注释） */
  function addModel(): void {
    const name = newModel.name.trim()
    if (!name) throw new Error(t('composable.modelNameRequired'))
    // 重复 id 校验：localModels 已含同 id → 抛错
    if (localModels.value.some((m) => m.id === name)) {
      throw new Error(t('composable.modelAlreadyExists', { name }))
    }
    localModels.value.push({
      id: name,
      name,
      contextWindow: newModel.contextWindow,
      input: [...newModel.inputTypes],
      thinkingLevelMap: resolveThinkingMap(newModel.thinking),
      // D4：reasoning 显式 boolean 出厂（不 undefined）——pi 两级门控把缺失判为「关」，
      // 手加模型静默丢字段会让思考档全被钳回 off（事故 B 根因 ②）。
      reasoning: newModel.reasoning,
    })
    newModel.name = ''
  }

  function removeModel(index: number): void {
    localModels.value.splice(index, 1)
  }

  function toggleCompatExpand(modelId: string): void {
    if (expandedCompat.has(modelId)) expandedCompat.delete(modelId)
    else expandedCompat.add(modelId)
  }

  function mergeDiscovered(discovered: DiscoveredModel[]): { total: number; addedCount: number } {
    const { added, total } = mergeDiscoveredModels(localModels.value, discovered)
    localModels.value.push(...added)
    return { total, addedCount: added.length }
  }

  function applyProvider(p: ProviderInfo | null): void {
    localModels.value = p ? toEditableModels(p) : []
  }

  function resetTransient(): void {
    showAddModel.value = false
    expandedCompat.clear()
  }

  return {
    newModel,
    localModels,
    showAddModel,
    expandedCompat,
    toggleInput,
    toggleNewInput,
    updateCtx,
    pickStrategy,
    getStrategyFromMap,
    addModel,
    removeModel,
    toggleCompatExpand,
    mergeDiscovered,
    applyProvider,
    resetTransient,
  }
}
