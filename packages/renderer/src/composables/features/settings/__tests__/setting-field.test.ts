/**
 * setting-field module 行为矩阵（RPC 设置项字段编排器，C2 deep module）。
 *
 * 打在 module interface 上（不 mount 组件）：
 *  - loadAll 归并：任一 loader reject → loadError 置位（RD-4#8）/ 全成功复位；失败不阻塞其余。
 *  - 便捷 load 自动注册 + registerLoader 共享 load（单 RPC 回填多字段，SmartContext 形态）。
 *  - persist 编排：乐观写（save pending 时 value 已生效）/ busy 防重入 / 失败回滚到已保存基准 +
 *    saveFailed toast（reason 插值，key 可覆盖）/ 成功回填权威值并更新基准 / save resolve void 不回填 /
 *    validate 非法不调 RPC + 回弹基准 + 专属 toast（不叠 saveFailed）/ savedToastKey 函数形态。
 *  - 回滚锚点 = lastSaved 基准而非 persist 入口快照（v-model 直改脏值形态，thresholdsK 对齐）。
 *  - createMirrorSave：失败置位 + toast e.message 原文；每次尝试起点复位标志。
 *  - createExplicitSave：saving 防重入 / 失败 toast 默认 e.message 原文、onError 可覆盖、不上抛 / 带参形态。
 *
 * toast/i18n mock：useToast 捕获 info/error 调用；vue-i18n 只 mock useI18n().t，
 * t 以「key?{json}」形态返回——断言同时锁定 key 与插值参数。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/settings/__tests__/setting-field.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
// useToast 工厂绑定 import 须先于被测模块 import 求值（setting-field 顶层消费 useToast，
// 触发 mock 工厂；晚初始化的绑定在 TDZ——vi.hoisted 同族坑，见 helpers/i18n-toast-mock.ts）
import { toastSpyMock, toastSpyModule } from '@/__tests__/helpers/i18n-toast-mock'
import {
  createSettingFieldGroup,
  createMirrorSave,
  createExplicitSave,
  type SettingField,
} from '../setting-field'

// toast spy 单源（helpers/i18n-toast-mock.ts 的 toastSpyMock 单例，断言经该单例取）
vi.mock('@/composables/useToast', () => toastSpyModule())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}?${JSON.stringify(params)}`,
  }),
}))

beforeEach(() => {
  toastSpyMock.info.mockClear()
  toastSpyMock.error.mockClear()
  toastSpyMock.warning.mockClear()
})

describe('createSettingFieldGroup · loadAll 归并', () => {
  it('任一 loader reject → loadError 置位 + 返回 false；失败不阻塞其余 loader', async () => {
    const group = createSettingFieldGroup()
    const good = vi.fn(() => Promise.resolve())
    const bad = vi.fn(() => Promise.reject(new Error('ws down')))
    group.registerLoader(good)
    group.registerLoader(bad)

    await expect(group.loadAll()).resolves.toBe(false)
    expect(group.loadError.value).toBe(true)
    expect(good).toHaveBeenCalledTimes(1)
    expect(bad).toHaveBeenCalledTimes(1)
  })

  it('全部成功 → loadError 复位 + 返回 true（重试成功路径）', async () => {
    const group = createSettingFieldGroup()
    let shouldFail = true
    group.registerLoader(() => (shouldFail ? Promise.reject(new Error('ws down')) : Promise.resolve()))

    await expect(group.loadAll()).resolves.toBe(false)
    expect(group.loadError.value).toBe(true)

    shouldFail = false
    await expect(group.loadAll()).resolves.toBe(true)
    expect(group.loadError.value).toBe(false)
  })
})

describe('field · 加载回填（便捷 load 自动注册 + 共享 loader）', () => {
  it('便捷 load hooks 自动注册进 loadAll；resolve 值经 reset 回填 value', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<string>('default', { load: () => Promise.resolve('loaded') })

    expect(f.value.value).toBe('default')
    await group.loadAll()
    expect(f.value.value).toBe('loaded')
  })

  it('registerLoader 共享 load：单 loader 回填多字段（SmartContext 形态），基准同步更新', async () => {
    const group = createSettingFieldGroup()
    const enabled = group.field<boolean>(false, { save: async () => undefined })
    const excluded = group.field<string[]>([], { save: async (next) => next })
    group.registerLoader(async () => {
      enabled.reset(true)
      excluded.reset(['p1/m1'])
    })

    await group.loadAll()
    expect(enabled.value.value).toBe(true)
    expect(excluded.value.value).toEqual(['p1/m1'])

    // 基准同步：随后的失败 persist 回滚到加载值而非初始值
    enabled.reset(true)
    const saveRejects = group.field<boolean>(false, { save: () => Promise.reject(new Error('x')) })
    saveRejects.reset(true)
    await saveRejects.persist(false)
    expect(saveRejects.value.value).toBe(true)
  })
})

describe('field · persist 编排', () => {
  it('乐观写：save 尚未 resolve 时 value 已更新 + busy 置位；resolve 后 busy 复位', async () => {
    const group = createSettingFieldGroup()
    let resolveSave!: () => void
    const f = group.field<boolean>(false, {
      save: () => new Promise<void>((resolve) => { resolveSave = resolve }),
    })

    const pending = f.persist(true)
    expect(f.value.value).toBe(true)
    expect(f.busy.value).toBe(true)

    resolveSave()
    await pending
    expect(f.busy.value).toBe(false)
  })

  it('busy 防重入：busy 期间 persist 直接 return（save 只被调一次，value 不被二次写）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(() => new Promise<void>(() => {}))
    const f = group.field<boolean>(false, { save })

    void f.persist(true)
    await f.persist(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(f.value.value).toBe(true)
  })

  it('失败回滚到已保存基准 + saveFailed toast 带 reason 插值', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<boolean>(false, { save: () => Promise.reject(new Error('ws down')) })
    f.reset(true)

    await f.persist(false)
    expect(f.value.value).toBe(true)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.saveFailed?{"reason":"ws down"}')
  })

  it('saveFailedToastKey 覆盖 + 非 Error reject 走 String(reason)', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<string>('a', {
      save: () => Promise.reject('plain-failure'),
      saveFailedToastKey: 'settings.system.customFailed',
    })

    await f.persist('b')
    expect(f.value.value).toBe('a')
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.customFailed?{"reason":"plain-failure"}')
  })

  it('成功回填权威值并更新基准：后续失败回滚到权威值（而非更早的初始值）', async () => {
    const group = createSettingFieldGroup()
    const saveCalls: string[] = []
    const f = group.field<string>('init', {
      save: async (next) => {
        saveCalls.push(next)
        if (saveCalls.length === 2) throw new Error('boom')
        return 'authoritative'
      },
    })

    await f.persist('next')
    expect(f.value.value).toBe('authoritative')
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')

    await f.persist('again')
    expect(f.value.value).toBe('authoritative')
  })

  it('save resolve void = 不回填（乐观值保留）+ 默认 saved toast key', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<boolean>(false, { save: async () => undefined })

    await f.persist(true)
    expect(f.value.value).toBe(true)
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('validate 非法：不调 RPC、回弹已保存基准、专属 toast（不叠 saveFailed）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number[]): Promise<number[] | void> => [])
    const f = group.field<number[]>([200, 400], {
      save,
      validate: (next) =>
        next.some((tk) => !Number.isFinite(tk) || tk <= 0) ? 'settings.system.smartContextThresholdInvalid' : null,
    })

    await f.persist([300, -1])
    expect(save).not.toHaveBeenCalled()
    expect(f.value.value).toEqual([200, 400])
    expect(toastSpyMock.error).toHaveBeenCalledTimes(1)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.smartContextThresholdInvalid')
  })

  it('validate 通过（null）→ 正常走 save 并回填权威值', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (next: number[]) => next.map((tk) => tk * 1000))
    const f = group.field<number[]>([200, 400], {
      save,
      validate: (next) => (next.some((tk) => tk <= 0) ? 'invalid' : null),
    })

    await f.persist([300, 500])
    expect(save).toHaveBeenCalledWith([300, 500])
    expect(f.value.value).toEqual([300000, 500000])
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('回滚锚点 = 已保存基准而非 persist 入口值：v-model 原地直改脏值后失败回到基准', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<number[]>([200, 400], { save: () => Promise.reject(new Error('x')) })
    f.reset([200, 400])

    // 模拟 v-model.number="thresholdsK[i]" 原地改写（同一数组引用，persist 调用前已带脏值）
    f.value.value[0] = 999
    await f.persist(f.value.value)

    expect(f.value.value).toEqual([200, 400])
  })

  it('savedToastKey 函数形态：保存完成后求值，可按其他字段状态选文案', async () => {
    const group = createSettingFieldGroup()
    const toggle = group.field<boolean>(true, { save: async () => undefined })
    // 显式类型标注：savedToastKey 闭包引用本字段自身（与组件现场同构），不标注构成自引用初始化环
    const mode: SettingField<string> = group.field<string>('first-stop', {
      save: (next) => Promise.resolve(next),
      savedToastKey: () =>
        !toggle.value.value && mode.value.value !== 'agent-tool' ? 'mode.switchedAutoDisabled' : 'mode.switched',
    })

    await mode.persist('agent-tool')
    expect(toastSpyMock.info).toHaveBeenCalledWith('mode.switched')

    toggle.reset(false)
    await mode.persist('first-prompt')
    expect(toastSpyMock.info).toHaveBeenCalledWith('mode.switchedAutoDisabled')
  })
})

describe('field · 同值短路（blur 形态字段）', () => {
  it('persist 与已保存基准同值 → 不校验不保存不 toast（blur 未改动不触发任何动作）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: string): Promise<void> => undefined)
    const validate = vi.fn((_next: string): string | null => null)
    const f = group.field<string>('saved', { save, validate })
    f.reset('saved')

    await f.persist('saved')
    expect(save).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(toastSpyMock.info).not.toHaveBeenCalled()
    expect(toastSpyMock.error).not.toHaveBeenCalled()
  })

  it('数组值域同值短路：元素相同的新数组实例不触发 save（JSON 序列化值比较）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number[]): Promise<void> => undefined)
    const f = group.field<number[]>([200, 400], { save })
    f.reset([200, 400])

    await f.persist([200, 400])
    expect(save).not.toHaveBeenCalled()
  })
})

/** 「恒拒校验 inline 字段 + 首次非法 persist」共用前置（同值清 inline / reset 清 inline
 *  两用例的单源形态）：field(60) 的 validate 恒拒 → persist(0) 后 inline 已置 timeoutInvalid、
 *  值回弹基准 60。末尾断言 = 每个用例的前置自检，随用例一并执行。 */
async function rejectedInlineFieldAfterInvalidPersist() {
  const group = createSettingFieldGroup()
  const invalidInline = ref<string | null>(null)
  const f = group.field<number>(60, {
    save: async () => undefined,
    validate: () => 'settings.worktree.timeoutInvalid',
    invalidInline,
  })

  await f.persist(0)
  expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')
  return { f, invalidInline }
}

describe('field · validate inline 通道（invalidInline，RD-4#7 表单红字形态）', () => {
  it('提供 invalidInline：validate 拒绝 → inline key 置入 + 不弹 toast + 回弹基准 + 不调 RPC', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number): Promise<void> => undefined)
    const invalidInline = ref<string | null>(null)
    const f = group.field<number>(60, {
      save,
      validate: (next) => (!Number.isFinite(next) || next <= 0 ? 'settings.worktree.timeoutInvalid' : null),
      invalidInline,
    })
    f.reset(60)

    await f.persist(0)
    expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')
    expect(save).not.toHaveBeenCalled()
    expect(f.value.value).toBe(60)
    expect(toastSpyMock.error).not.toHaveBeenCalled()
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('不提供 invalidInline：validate 拒绝仍走专属 toast（System sections 形态不受影响）', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<number[]>([200, 400], {
      save: async () => undefined,
      validate: (next) => (next.some((tk) => tk <= 0) ? 'settings.system.smartContextThresholdInvalid' : null),
    })

    await f.persist([300, -1])
    expect(toastSpyMock.error).toHaveBeenCalledTimes(1)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.smartContextThresholdInvalid')
  })

  it('persist 尝试起点清 inline：拒绝后再合法保存成功 → inline 复位 + saved toast', async () => {
    const group = createSettingFieldGroup()
    const invalidInline = ref<string | null>(null)
    const f = group.field<number>(60, {
      save: async () => undefined,
      validate: (next) => (next <= 0 ? 'settings.worktree.timeoutInvalid' : null),
      invalidInline,
    })

    await f.persist(0)
    expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')

    await f.persist(120)
    expect(invalidInline.value).toBe(null)
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('同值 persist 同样清 inline（先清后短路：再次 blur 带走旧 error 的既有 UI 行为）', async () => {
    const { f, invalidInline } = await rejectedInlineFieldAfterInvalidPersist()

    // 拒绝路径已回弹基准（60），再次 blur → 同值短路，但旧 inline error 被起点复位带走
    await f.persist(60)
    expect(invalidInline.value).toBe(null)
  })

  it('reset 更新基准时清 inline（重试加载成功后旧校验错误不再适用）', async () => {
    const { f, invalidInline } = await rejectedInlineFieldAfterInvalidPersist()

    f.reset(90)
    expect(invalidInline.value).toBe(null)
  })
})

describe('createMirrorSave（dirs 镜像保存）', () => {
  it('失败 → saveError 置位 + toast error（e.message 原文）；成功 → 复位（尝试起点复位语义）', async () => {
    let shouldFail = true
    const mirror = createMirrorSave((arg: string) =>
      shouldFail ? Promise.reject(new Error('disk full')) : Promise.resolve(),
    )

    await mirror.run('a')
    expect(mirror.saveError.value).toBe(true)
    expect(toastSpyMock.error).toHaveBeenCalledWith('disk full')

    shouldFail = false
    await mirror.run('b')
    expect(mirror.saveError.value).toBe(false)
  })
})

describe('createExplicitSave（显式保存动作）', () => {
  it('防重入：in-flight 期间 run 直接 return（run 本体只执行一次）+ 成功 toast', async () => {
    let resolveRun!: () => void
    const body = vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve }))
    const action = createExplicitSave({ run: body, savedToastKey: 'x.saved' })

    const first = action.run()
    await action.run()
    expect(body).toHaveBeenCalledTimes(1)
    expect(action.saving.value).toBe(true)

    resolveRun()
    await first
    expect(action.saving.value).toBe(false)
    expect(toastSpyMock.info).toHaveBeenCalledWith('x.saved')
  })

  it('失败不上抛：默认 toast e.message 原文；onError 覆盖文案', async () => {
    const failing = createExplicitSave({ run: () => Promise.reject(new Error('boom')), savedToastKey: 'x.saved' })
    await expect(failing.run()).resolves.toBeUndefined()
    expect(toastSpyMock.error).toHaveBeenCalledWith('boom')

    const custom = createExplicitSave({
      run: () => Promise.reject(new Error('raw')),
      savedToastKey: 'x.saved',
      onError: () => 'custom text',
    })
    await custom.run()
    expect(toastSpyMock.error).toHaveBeenCalledWith('custom text')
  })

  it('带参形态（LlmRetry 整体 config 形态）：run 收到调用方域校验产物', async () => {
    const body = vi.fn(async (_cfg: { n: number }) => undefined)
    const action = createExplicitSave<{ n: number }>({ run: body, savedToastKey: 'x.saved' })

    await action.run({ n: 1 })
    expect(body).toHaveBeenCalledWith({ n: 1 })
    expect(toastSpyMock.info).toHaveBeenCalledWith('x.saved')
  })
})
