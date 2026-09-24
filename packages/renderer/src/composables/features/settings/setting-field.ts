/**
 * RPC 设置项字段编排器（setting-field）——System 设置项「字段编排」的唯一 deep module（C2）。
 *
 * 组件只声明 hooks（load / save / validate + toast key 覆盖），编排收进 module。三种形态：
 * - {@link createSettingFieldGroup}：乐观更新字段组——组级 load 归并（RD-4#8 loadError）+
 *   per-field「busy 防重入 → validate → 乐观写 → save → 成功回填权威值 + saved toast；
 *   失败回滚 + saveFailed toast（带 reason 插值）」。底层乐观协议走
 *   {@link runOptimisticUpdate}（@taiji/core/foundation/optimistic-update）。
 *   回滚锚点 = field 内部 lastSaved 基准，而非 persist 入口快照：v-model 直改 value 的字段
 *   （如阈值输入框）在 persist 被调前已带脏值，回到 lastSaved 才是「回到已保存态」。
 * - {@link createMirrorSave}：镜像保存（dirs 形态）——不乐观更新（store 镜像只被成功落盘后的
 *   广播写入，dirs 域无 getter RPC），失败置 saveError 标志驱动 LoadPaths 从 store 镜像
 *   （最近落盘值）强制重拉回弹 + 常驻红字（RD-4#1：失败无广播，标志是唯一回弹信号），
 *   toast error（e.message 原文）；每次保存尝试起点复位标志（成功即消、再失败再亮）。
 * - {@link createExplicitSave}：显式保存动作（整表单形态，按钮触发）——saving 防重入 +
 *   成功 toast（savedToastKey）/ 失败 toast（默认 e.message 原文，onError 覆盖）；
 *   失败 rethrow 语义内化 = catch 后 toast，不上抛。
 *
 * 全部经 useI18n()/useToast() 获取 toast/i18n——须在组件 setup 上下文调用。
 */
import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { runOptimisticUpdate } from '@taiji/core/foundation/optimistic-update'
import { useToast } from '@/composables/useToast'

/** 默认成功 toast key（System 设置项通用「已保存」文案）。 */
const DEFAULT_SAVED_TOAST_KEY = 'settings.system.saved'
/** 默认失败 toast key（带 reason 插值）。 */
const DEFAULT_SAVE_FAILED_TOAST_KEY = 'settings.system.saveFailed'

/**
 * 字段值基准快照。structuredClone 防基准污染：v-model 原地改写 value（如 thresholdsK[i]）时
 * lastSaved 若与 value 同引用会跟着变，回滚/回弹会回到脏值。设置项字段值域 = 可结构化克隆的
 * 原始值/纯数据（boolean / string / number[] / string[]），克隆语义等价于「独立副本」。
 */
function snapshotOf<TValue>(value: TValue): TValue {
  return structuredClone(value)
}

/** saveFailed toast 的 reason 插值载荷。 */
function reasonPayload(e: unknown): { reason: string } {
  return { reason: e instanceof Error ? e.message : String(e) }
}

/** e → 用户可见错误文本（默认形态：Error message 原文，非 Error 走 String）。 */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 字段便捷 hooks：load 缺省 = 无便捷 load（由 registerLoader 共享拉取，如单 RPC 回填多字段）；
 * save resolve 非空值 = 权威回填（runtime 归一/clamp 后的生效值），resolve void = 不回填。
 */
export interface SettingFieldHooks<TValue> {
  /** 便捷 load（field 自动注册进 group，loadAll 时与其他 loader 并行）；resolve 值经 reset 回填。 */
  load?(): Promise<TValue>
  /** 持久化 RPC。resolve 非空值 = 成功回填权威值并更新回滚基准；resolve void = 不回填。 */
  save(next: TValue): Promise<TValue | void>
  /** 前端校验：返回错误 i18n key → 不调 RPC、value 回弹已保存基准、toast 该 key（非 saveFailed 文案）；返回 null = 通过。 */
  validate?(next: TValue): string | null
  /** 成功 toast key 覆盖（默认 'settings.system.saved'）；函数形态支持运行时决定（如按其他字段状态选文案）。 */
  savedToastKey?: string | (() => string)
  /** saveFailed toast 的 key 覆盖（默认 'settings.system.saveFailed'，带 reason 插值）。 */
  saveFailedToastKey?: string
}

/** 单个 RPC 设置项（乐观更新 + 回滚 + toast + 成功回填）。 */
export interface SettingField<TValue> {
  readonly value: Ref<TValue>
  /** 保存中（防重入 + 控件禁用态）。 */
  readonly busy: Ref<boolean>
  /** persist 编排：busy 防重入 → validate（可选）→ 乐观写 → save → 成功回填权威值 + saved toast；失败回滚 + saveFailed toast。 */
  persist(next: TValue): Promise<void>
  /** 加载回填 + 更新回滚/回弹基准（load hooks 与共享 loader 的回填唯一入口）。 */
  reset(loaded: TValue): void
}

/** 字段编排组：组级 load 归并（RD-4#8）+ 字段工厂 + 共享 loader 注册。 */
export interface SettingFieldGroup {
  /** RD-4#8：loadAll 任一 loader 失败置位；成功复位。置位时控件禁用 + 常驻提示（组件渲染侧）。 */
  readonly loadError: Ref<boolean>
  /** 声明一个乐观更新字段（便捷 load 自动注册进 group）。 */
  field<TValue>(initial: TValue, hooks: SettingFieldHooks<TValue>): SettingField<TValue>
  /** 共享 loader（如单个 getSmartContextConfig 回填多字段）。 */
  registerLoader(loader: () => Promise<void>): void
  /** 并行执行全部 loader；任一 reject 置 loadError=true（归并），全部成功置 false；返回是否全部成功。 */
  loadAll(): Promise<boolean>
}

export function createSettingFieldGroup(): SettingFieldGroup {
  const { t } = useI18n()
  const { info: toastInfo, error: toastError } = useToast()

  const loaders: Array<() => Promise<void>> = []
  const loadError = ref(false)

  const registerLoader = (loader: () => Promise<void>): void => {
    loaders.push(loader)
  }

  const loadAll = async (): Promise<boolean> => {
    // 任一失败不阻塞其余（Promise.allSettled），但任一失败即置 loadError——默认值明确标注为
    // 默认而非已存（RD-4#8：误显的默认值会随用户操作直接落盘），成功复位。
    const results = await Promise.allSettled(loaders.map((load) => load()))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    loadError.value = failures.length > 0
    if (failures.length > 0) {
      console.warn(`[setting-field] loadAll: ${failures.length}/${loaders.length} loader(s) failed`, failures.map((f) => f.reason))
    }
    return failures.length === 0
  }

  const field = <TValue>(initial: TValue, hooks: SettingFieldHooks<TValue>): SettingField<TValue> => {
    const value = ref(initial) as Ref<TValue>
    const busy = ref(false)
    // 已保存基准：reset(loaded) 与成功回填时更新；validate 非法回弹与 save 失败回滚的唯一锚点
    let lastSaved = snapshotOf(initial)

    const reset = (loaded: TValue): void => {
      value.value = loaded
      lastSaved = snapshotOf(loaded)
    }

    const persist = async (next: TValue): Promise<void> => {
      if (busy.value) return
      if (hooks.validate) {
        const invalidToastKey = hooks.validate(next)
        if (invalidToastKey !== null) {
          // 前端校验拒绝：不调 RPC，回弹到已保存基准 + 专属 toast（非 saveFailed 文案）
          value.value = snapshotOf(lastSaved)
          toastError(t(invalidToastKey))
          return
        }
      }
      busy.value = true
      try {
        const authoritative = await runOptimisticUpdate({
          apply: () => {
            value.value = next
          },
          // 回滚锚点是 lastSaved（已保存基准），不是 persist 入口快照——v-model 直改 value 的
          // 字段在 persist 被调前已带脏值，回到基准才是「回到已保存态」
          rollback: () => {
            value.value = snapshotOf(lastSaved)
          },
          commit: () => hooks.save(next),
        })
        // 成功回填：save resolve 非空值 = runtime 权威值（reply.model / reply.mode / clamp 后阈值），
        // 写回 value 并更新基准，避免本地乐观值与实际生效值漂移；resolve void = 不回填，仍更新基准
        if (authoritative !== undefined && authoritative !== null) {
          value.value = authoritative
          lastSaved = snapshotOf(authoritative)
        } else {
          lastSaved = snapshotOf(next)
        }
        const savedToastKey = typeof hooks.savedToastKey === 'function' ? hooks.savedToastKey() : hooks.savedToastKey
        toastInfo(t(savedToastKey ?? DEFAULT_SAVED_TOAST_KEY))
      } catch (e) {
        toastError(t(hooks.saveFailedToastKey ?? DEFAULT_SAVE_FAILED_TOAST_KEY, reasonPayload(e)))
      } finally {
        busy.value = false
      }
    }

    if (hooks.load) {
      const load = hooks.load
      registerLoader(async () => {
        reset(await load())
      })
    }

    return { value, busy, persist, reset }
  }

  return { loadError, field, registerLoader, loadAll }
}

/**
 * 镜像保存（dirs 形态）：不乐观更新——LoadPaths 本地态靠广播推回，store 镜像恒为「最近落盘值」，
 * 失败时无广播，故由 saveError 标志驱动 LoadPaths 从 store 镜像强制重拉回弹 + 常驻红字（RD-4#1）；
 * 每次尝试起点复位标志（成功即消、再失败再亮）。失败 toast = e.message 原文 error。
 */
export function createMirrorSave<T>(save: (arg: T) => Promise<void>): {
  readonly saveError: Ref<boolean>
  run(arg: T): Promise<void>
} {
  const { error: toastError } = useToast()
  const saveError = ref(false)

  const run = async (arg: T): Promise<void> => {
    saveError.value = false
    try {
      await save(arg)
    } catch (e) {
      saveError.value = true
      toastError(reasonOf(e))
    }
  }

  return { saveError, run }
}

/** 显式保存动作配置（run 的参数供域校验产物传递，如 LlmRetry 的整体 config；void = 无参）。 */
export interface ExplicitSaveOptions<TArg> {
  /** 保存动作本体（域校验/组装留在调用方，本 module 只管 in-flight + toast）。 */
  run(arg: TArg): Promise<void>
  /** 成功 toast key。 */
  savedToastKey: string
  /** 失败 toast 文案函数（默认用 e.message 原文 toast error，对齐 PromptPage/TerminalPage 现状）。 */
  onError?: (e: unknown) => string
}

/**
 * 显式保存动作（整表单形态，按钮触发）：saving 防重入（in-flight 期间重复 run 直接返回，
 * 防并发覆盖同一 config + 双 toast）+ 成功 toast（savedToastKey）/ 失败 toast（onError 覆盖，
 * 默认 e.message 原文）。失败 rethrow 语义内化 = catch 后 toast，不上抛。
 */
export function createExplicitSave<TArg = void>(opts: ExplicitSaveOptions<TArg>): {
  readonly saving: Ref<boolean>
  run(arg: TArg): Promise<void>
} {
  const { t } = useI18n()
  const { info, error } = useToast()
  const saving = ref(false)

  const run = async (arg: TArg): Promise<void> => {
    if (saving.value) return
    saving.value = true
    try {
      await opts.run(arg)
      info(t(opts.savedToastKey))
    } catch (e) {
      error(opts.onError ? opts.onError(e) : reasonOf(e))
    } finally {
      saving.value = false
    }
  }

  return { saving, run }
}
