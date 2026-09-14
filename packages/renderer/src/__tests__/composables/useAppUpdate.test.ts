/**
 * useAppUpdate 单测（自动升级单例 composable · w4 update-frontend · w2 两阶段改造）。
 *
 * 覆盖：
 * - checkForUpdate 有/无新版 → available/idle
 * - performDownload 经 onUpdateProgress 做 stage 转换，downloaded:true → state='downloaded'
 * - performInstall 乐观置 replacing / triggerRestart 置 restarting / 失败置 error
 * - onUpdateError → error/unsupported（SSOT）
 * - restorePreloadedUpdate 有效产物 → downloaded / 无效 no-op
 * - 状态守卫 ES4（downloaded 同版本不覆盖）/ ES5（downloaded 追新版退回 available）
 * - performDownload catch 兜底 / 传给 ipc 的是 plain object（toRaw 解包）
 *
 * w2 改造：旧一键 performUpdate 拆为 performDownload（downloaded 态）+ performInstall（restarting 态）。
 * ipc 层新增 updateDownload/updateInstall/getPreloaded 三导出，本测试同步补 mock。
 *
 * Mock 策略：
 * - vi.mock('@/api/domains/settings') 桩 8 个 update 方法；onUpdateProgress/onUpdateError 捕获 cb 供测试手动触发
 * - vi.mock('@/composables/logic/markdown') 桩 renderMarkdown 避免加载 shiki WASM
 * - effectScope 包 useAppUpdate（onScopeDispose 依赖活跃 scope）
 * - _resetForTest 在 beforeEach 重置 module-level 单例 state
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo, UpdateCheckResult } from '@xyz-agent/shared'

// vi.mock 被 hoist，factory 内不能引用顶层变量，用 vi.hoisted 拿稳定引用
const hoisted = vi.hoisted(() => {
  // 捕获 onUpdateProgress/onUpdateError 注册的回调，供测试手动触发（模拟 main 推送）
  let progressCb: ((p: { stage: 'downloading' | 'replacing'; percent: number }) => void) | null = null
  let errorCb: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<UpdateCheckResult>>(),
    updateDownload: vi.fn<(version: string) => Promise<{ downloaded: boolean }>>(),
    updateInstall: vi.fn<() => Promise<{ triggerRestart: boolean }>>(),
    getPreloaded: vi.fn<() => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
    getPendingUpdate: vi.fn<() => Promise<LatestReleaseInfo | null>>(),
    getLaunchResult: vi.fn<() => Promise<{ status: string; version: string; error?: string } | null>>(),
    getUpdateSettings: vi.fn<() => Promise<{ preDownload: boolean; autoUpdate?: boolean }>>(),
    openUpdateFallbackUrl: vi.fn<(url: string) => Promise<void>>(),
    onUpdateProgress: vi.fn((cb: typeof progressCb) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    }),
    onUpdateError: vi.fn((cb: typeof errorCb) => {
      errorCb = cb
      return () => {
        errorCb = null
      }
    }),
    // 暴露给测试：手动触发 main 进程的进度/错误推送
    fireProgress: (p: { stage: 'downloading' | 'replacing'; percent: number }) => {
      if (progressCb) progressCb(p)
    },
    fireError: (e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => {
      if (errorCb) errorCb(e)
    },
    renderMarkdown: vi.fn<(md: string) => Promise<string>>(),
  }
})

vi.mock('@/api/domains/settings', () => ({
  checkForUpdate: hoisted.checkForUpdate,
  updateDownload: hoisted.updateDownload,
  updateInstall: hoisted.updateInstall,
  getPreloaded: hoisted.getPreloaded,
  getPendingUpdate: hoisted.getPendingUpdate,
  getLaunchResult: hoisted.getLaunchResult,
  getUpdateSettings: hoisted.getUpdateSettings,
  openUpdateFallbackUrl: hoisted.openUpdateFallbackUrl,
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoisted.renderMarkdown,
}))

// W4: useToast mock（launch result toast 测试用）
const toastFns = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastFns,
}))

import { useAppUpdate, __testing, _resetForTest } from '@/composables/features/settings/useAppUpdate'

/** 构造测试用 LatestReleaseInfo */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## 新特性\n- 支持 foo',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/example/repo/releases/v' + version,
    assets: {},
  }
}

/** 在 effectScope 内运行 useAppUpdate，返回 result + scope.stop 清理函数（与 pending.test.ts 对齐）。
 *  options.initAutoCheck=true 时在 scope 内同步调 initAutoCheck（onScopeDispose 需绑定到活跃 scope）。 */
function setupUseAppUpdate(options?: { initAutoCheck?: boolean }): {
  result: ReturnType<typeof useAppUpdate>
  stop: () => void
} {
  const scope = effectScope()
  let result: ReturnType<typeof useAppUpdate> | undefined
  scope.run(() => {
    result = useAppUpdate()
    if (options?.initAutoCheck) {
      result.initAutoCheck()
    }
  })
  return { result: result!, stop: () => scope.stop() }
}

beforeEach(() => {
  _resetForTest()
  // __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之。
  // 默认 '0.0.0' 让版本守卫不拦截（< 任何 preloaded 版本），保持现有用例意图。
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  hoisted.checkForUpdate.mockReset()
  hoisted.updateDownload.mockReset()
  hoisted.updateInstall.mockReset()
  hoisted.getPreloaded.mockReset()
  hoisted.getUpdateSettings.mockReset()
  // 默认 autoUpdate=true（批次 4 默认值）：存量 autoCheck 用例行为不变
  hoisted.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
  hoisted.openUpdateFallbackUrl.mockReset()
  hoisted.onUpdateProgress.mockClear()
  hoisted.onUpdateError.mockClear()
  hoisted.renderMarkdown.mockReset()
  hoisted.renderMarkdown.mockResolvedValue('<h2>新特性</h2>')
  // 默认值：两阶段 mock 的合理默认（各用例按需覆盖）
  hoisted.updateDownload.mockResolvedValue({ downloaded: true })
  hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
  hoisted.getPreloaded.mockResolvedValue(null)
  hoisted.getPendingUpdate.mockReset()
  hoisted.getPendingUpdate.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAppUpdate', () => {
  it('checkForUpdate 有新版 → state="available" + latestRelease 填充', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    // renderMarkdown 异步，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    expect(hoisted.renderMarkdown).toHaveBeenCalledWith('## 新特性\n- 支持 foo')
    stop()
  })

  it('checkForUpdate 无新版 → state="idle"', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('checkForUpdate 限额退避（rateLimited=true）→ 状态不回退 + 每窗口一次性提示（RM2.3）', async () => {
    toastFns.info.mockClear()
    // 先进入 available（已有升级提醒）
    hoisted.checkForUpdate.mockResolvedValueOnce({ info: makeRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('available')

    // 退避窗口内的检查（周期/补查/手动同路径）：null + rateLimited=true
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })
    await result.checkForUpdate(true)
    // 「限额未知」≠「确认无新版」：available 提醒不回退 idle
    expect(result.state.state).toBe('available')
    // 非侵入提示一次（不进 error 态，info toast）
    expect(toastFns.info).toHaveBeenCalledTimes(1)
    expect(toastFns.info).toHaveBeenCalledWith('更新检查服务限流，约 2 小时内暂停自动检查')

    // 同窗口内再查不重复提示
    await result.checkForUpdate(true)
    expect(toastFns.info).toHaveBeenCalledTimes(1)

    // 窗口结束（拿到确定答案）→ 去重标记复位；确认无新版正常回退 idle
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    await result.checkForUpdate(true)
    expect(result.state.state).toBe('idle')

    // 新退避窗口可再次提示
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })
    await result.checkForUpdate(true)
    expect(toastFns.info).toHaveBeenCalledTimes(2)
    stop()
  })

  it('onUpdateError UPDATE_STALE_RELEASE → 不进 error 态，自动重查拿新 latest（§3.5.1② / T3）', async () => {
    toastFns.info.mockClear()
    toastFns.error.mockClear()
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('available')

    // 用户点下载期间服务端发了更新版本：main 权威解析拒绝旧版本并推 STALE 错误
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireError({ stage: 'downloading', message: '更新信息已过期', errorCode: 'UPDATE_STALE_RELEASE' })
      throw { message: '更新信息已过期', stage: 'downloading', errorCode: 'UPDATE_STALE_RELEASE' }
    })
    // 自动重查拿到更新的 latest
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.1'), rateLimited: false })

    await result.performDownload()

    // 不进 error 态；自动重查后 available(v0.9.1)，用户再点下载即拿新版本
    await vi.waitFor(() => {
      expect(result.state.state).toBe('available')
    })
    expect(result.state.latestRelease?.version).toBe('0.9.1')
    // 信息性提示而非错误 toast
    expect(toastFns.info).toHaveBeenCalledWith('检测到更新的版本，已为你刷新更新信息')
    expect(toastFns.error).not.toHaveBeenCalled()
    stop()
  })

  it('onUpdateError UPDATE_STALE_RELEASE + 自动重查恰逢限额 → 不固化 downloading 假态（#24 回归）', async () => {
    toastFns.info.mockClear()
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('available')

    // STALE 错误推送触发自动重查，重查恰逢限额退避窗口：{info:null, rateLimited:true}
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireError({ stage: 'downloading', message: '更新信息已过期', errorCode: 'UPDATE_STALE_RELEASE' })
      throw { message: '更新信息已过期', stage: 'downloading', errorCode: 'UPDATE_STALE_RELEASE' }
    })
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })

    await result.performDownload()

    // 修复前：performDownload 已置 downloading 且 catch 被 errorHandled 去重跳过，
    // STALE 分支不置态 → 自动重查 prevState='downloading' 被 rateLimited 恢复固化，
    // UpdateCheckCard downloading 态无按钮 + 周期检查守卫跳过 → UI 永久卡死。
    // 修复后：STALE 分支在重查前显式置 available，rateLimited 恢复 available（稳定态有出路）。
    await vi.waitFor(() => {
      expect(result.state.state).toBe('available')
    })
    expect(result.state.state).not.toBe('downloading')
    expect(result.state.state).not.toBe('checking')
    stop()
  })

  it('performDownload 经 onUpdateProgress 推送做 stage 转换（downloading→replacing），downloaded:true 后置 downloaded', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    hoisted.updateDownload.mockImplementation(async () => {
      // 触发主进程推送：downloading 30% → replacing 100%（verifying 已随批次 3 删 perform 移除，m3）
      hoisted.fireProgress({ stage: 'downloading', percent: 30 })
      hoisted.fireProgress({ stage: 'replacing', percent: 100 })
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    // 推送过程中 percent 累积到 100；downloaded:true → state=downloaded（下载止于此，restart 是 install 阶段）
    expect(result.state.percent).toBe(100)
    expect(result.state.state).toBe('downloaded')
    expect(hoisted.updateDownload).toHaveBeenCalled()
    stop()
  })

  it('performDownload 在 progress 推到中间态后 resolve {downloaded:true}，state 置 downloaded 不卡在 downloading', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    // 模拟：main 只推了一次 downloading 进度，updateDownload 随即 resolve
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireProgress({ stage: 'downloading', percent: 50 })
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    // downloaded:true 覆盖中间态 → state=downloaded（不卡在 downloading）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.percent).toBe(50)
    stop()
  })

  it('performDownload downloaded=true → state="downloaded"（基础成功路径）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    hoisted.updateDownload.mockResolvedValue({ downloaded: true })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('downloaded')
    stop()
  })

  it('onUpdateError 推送 → state="error" + errorMessage（SSOT）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    hoisted.updateDownload.mockImplementation(async () => {
      // 触发主进程错误推送（SSOT 优先于 performDownload catch）
      hoisted.fireError({ stage: 'downloading', message: '校验失败：sha256 不匹配' })
      return { downloaded: false }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('校验失败：sha256 不匹配')
    stop()
  })

  it('onUpdateError errorCode="UPDATE_UNSUPPORTED_PLATFORM" → state="unsupported"', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireError({
        stage: 'init',
        message: '当前平台不支持自动升级',
        errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
      })
      return { downloaded: false }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('unsupported')
    stop()
  })

  it('performDownload catch 在 !errorHandled 时兜底置 error（去重：onUpdateError 未触发）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    // updateDownload reject 且未触发 onUpdateError → 走兜底 error
    hoisted.updateDownload.mockRejectedValue(new Error('网络中断'))
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络中断')
    stop()
  })

  // ── W3 验收并入（原独立文件 useAppUpdate.w3-acceptance.test.ts，同 mock 装置）──
  // errorSuggestion 填充（D9 网络类错误码追加手动下载指引）+ toast 只弹摘要。
  const MANUAL_HINT_ZH = '也可从 release 页手动下载安装包，放入手动升级目录后重试（目录路径见 设置 → 更新 → 手动升级通道）'

  it('onUpdateError 带 suggestion 的网络类错误 → errorSuggestion = suggestion + D9 追加段', () => {
    const { result, stop } = setupUseAppUpdate()
    hoisted.fireError({
      stage: 'downloading',
      message: '无法连接代理 (EHOSTUNREACH)',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试',
    })

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('无法连接代理 (EHOSTUNREACH)')
    expect(result.state.errorSuggestion).toBe(
      `macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试\n${MANUAL_HINT_ZH}`,
    )
    stop()
  })

  it('无 suggestion 的网络类错误 → errorSuggestion = D9 手动下载指引', () => {
    const { result, stop } = setupUseAppUpdate()
    hoisted.fireError({ stage: 'downloading', message: '网络连接失败', errorCode: 'UPDATE_NETWORK_FAILED' })

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络连接失败')
    expect(result.state.errorSuggestion).toBe(MANUAL_HINT_ZH)
    stop()
  })

  it('onUpdateError 触发 error toast，只弹摘要不弹 suggestion（单参数）', () => {
    setupUseAppUpdate()
    // toastFns 为模块级 hoisted spy（不被 beforeEach 重置），用例内先清零隔离
    toastFns.error.mockClear()
    hoisted.fireError({
      stage: 'downloading',
      message: '无法连接代理 (EHOSTUNREACH)',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: '很长的恢复指引文案...',
    })

    expect(toastFns.error).toHaveBeenCalledTimes(1)
    expect(toastFns.error).toHaveBeenCalledWith('无法连接代理 (EHOSTUNREACH)')
    // toast 只传 message，不传 suggestion
    expect(toastFns.error.mock.calls[0].length).toBe(1)
  })

  // [HISTORICAL] 回归：传给 ipc 的 release 必须是 plain object，不能是 Vue reactive proxy。
  // 事故：state.latestRelease 存入 reactive(state) 后被 Vue 深度代理化（含嵌套 assets），
  // performDownload 把 proxy 传给 ipcRenderer.invoke → Electron structured clone 抛
  // "an object could not be cloned" → invoke reject 被 catch 吞成 errorMessage，
  // 用户在 UpdateButton hover 看到英文 clone 报错。现有用例 mock @/api/domains/settings 接收的是
  // makeRelease() 返回的普通对象，测不到此问题；本用例在 reactive 上下文（effectScope +
  // useAppUpdate 内部 reactive state）下验证传给 ipc 的对象可被 structuredClone。
  // [批次 3 RC1] 旧用例验证「传给 ipc 的是 plain object（toRaw 解包）」——契约版本号化后
  // updateDownload 只传 version 字符串，proxy/structuredClone 问题不再存在；本用例改为
  // 断言传给 ipc 的是 available release 的 version 字段（意图透传）。
  it('performDownload 传给 ipc 的是 available release 的 version 字符串（批次 3 契约）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    // 捕获 updateDownload 实际收到的参数（IPC 入参）
    const received: string[] = []
    hoisted.updateDownload.mockImplementation(async (v) => {
      received.push(v)
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(received).toEqual(['0.9.0'])
    stop()
  })

  it('openFallbackUrl 调 ipc.openUpdateFallbackUrl(latestRelease.htmlUrl)', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue({ info: release, rateLimited: false })
    hoisted.openUpdateFallbackUrl.mockResolvedValue(undefined)
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.openFallbackUrl()

    expect(hoisted.openUpdateFallbackUrl).toHaveBeenCalledWith(release.htmlUrl)
    stop()
  })

  // ── performInstall（安装/重启阶段）──
  it('performInstall 乐观置 replacing（IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态）', async () => {
    // updateInstall 返回 pending promise，调 performInstall 后同步检查 state
    let resolveInstall!: (v: { triggerRestart: boolean }) => void
    hoisted.updateInstall.mockImplementation(
      () => new Promise<{ triggerRestart: boolean }>((r) => { resolveInstall = r }),
    )
    const { result, stop } = setupUseAppUpdate()
    const p = result.performInstall()
    // 同步断言：state 已乐观置 replacing（不等 IPC 往返）
    expect(result.state.state).toBe('replacing')
    resolveInstall({ triggerRestart: false })
    await p
    stop()
  })

  it('performInstall triggerRestart=true → state="restarting"', async () => {
    hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
    const { result, stop } = setupUseAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('restarting')
    stop()
  })

  it('performInstall 失败 → state="error" + errorMessage（兜底）', async () => {
    hoisted.updateInstall.mockRejectedValue(new Error('替换文件失败'))
    const { result, stop } = setupUseAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('替换文件失败')
    stop()
  })

  // ── restorePreloadedUpdate（功能 2：预下载恢复）──
  it('restorePreloadedUpdate 有效预下载产物 → state="downloaded" + latestRelease 填充，返回 true', async () => {
    const release = makeRelease('0.9.0')
    hoisted.getPreloaded.mockResolvedValue({ release, filePath: '/tmp/preloaded.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await __testing.restorePreloadedUpdate()

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('restorePreloadedUpdate 无预下载产物（null）→ no-op，state 不变，返回 false', async () => {
    hoisted.getPreloaded.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()
    const restored = await __testing.restorePreloadedUpdate()

    expect(restored).toBe(false)
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  // ── restorePreloadedUpdate 版本守卫（w2-frontend-guard：前端兜底拦截过期产物）──
  it('W2TC1：currentVersion < preloaded.version（0.8.48 < 0.8.49）→ 守卫放行，恢复 downloaded', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.48')
    hoisted.getPreloaded.mockResolvedValue({ release: makeRelease('0.8.49'), filePath: '/tmp/x.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await __testing.restorePreloadedUpdate()

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.49')
    stop()
  })

  it('W2TC2：currentVersion >= preloaded.version（0.8.49 >= 0.8.49）→ 守卫拦截，不恢复，回退 pending', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.49')
    hoisted.getPreloaded.mockResolvedValue({ release: makeRelease('0.8.49'), filePath: '/tmp/x.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await __testing.restorePreloadedUpdate()

    expect(restored).toBe(false)
    expect(result.state.state).not.toBe('downloaded')
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('W2TC3：preloaded.version 非 semver → compare 抛错 catch 后继续恢复（对齐后端 keep 语义）', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.49')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // makeRelease 填合法字段，仅覆盖 version 为非法 semver 触发 compare 抛错
    hoisted.getPreloaded.mockResolvedValue({
      release: { ...makeRelease('0.8.49'), version: 'not-a-version' },
      filePath: '/tmp/x.zip',
    })
    const { result, stop } = setupUseAppUpdate()
    const restored = await __testing.restorePreloadedUpdate()

    expect(warnSpy).toHaveBeenCalled()
    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    warnSpy.mockRestore()
    stop()
  })

  // ── 状态守卫 ES4/ES5（downloaded 态不被联网检测误覆盖）──
  it('状态守卫 ES4：downloaded 态检测到同版本 → 不被覆盖为 available（保持 downloaded）', async () => {
    // 通过 restorePreloadedUpdate 恢复 downloaded 态：同时设 pendingRestored=true，
    // 否则 checkForUpdate 进入时会置 checking 态破坏守卫前提（pendingRestored 守的是 checking 回退）
    const preloadedRelease = makeRelease('0.8.44')
    hoisted.getPreloaded.mockResolvedValue({ release: preloadedRelease, filePath: '/tmp/x.zip' })
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.8.44'), rateLimited: false }) // 同版本
    const { result, stop } = setupUseAppUpdate()
    await __testing.restorePreloadedUpdate()
    expect(result.state.state).toBe('downloaded')

    await result.checkForUpdate()
    // ES4：downloaded + 同版本 → 不覆盖，保持 downloaded（仅刷新 latestRelease）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.44')
    stop()
  })

  it('状态守卫 ES5：downloaded 态检测到更新版本 → 退回 available（追新版）', async () => {
    const preloadedRelease = makeRelease('0.8.44')
    hoisted.getPreloaded.mockResolvedValue({ release: preloadedRelease, filePath: '/tmp/x.zip' })
    hoisted.checkForUpdate.mockResolvedValue({ info: makeRelease('0.8.46'), rateLimited: false }) // 更新版本
    const { result, stop } = setupUseAppUpdate()
    await __testing.restorePreloadedUpdate()
    expect(result.state.state).toBe('downloaded')

    await result.checkForUpdate()
    // ES5：downloaded + 更新版本 → 退回 available（追新版，旧 preloaded 由 main 侧下次 download 自动清）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.8.46')
    stop()
  })
})

describe('useAppUpdate initAutoCheck 定时器（递归 setTimeout + 守卫）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30s 首次触发 checkForUpdate(force=false)（批次 4 RM2.1：周期走缓存）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    hoisted.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
    // initAutoCheck 必须在 scope 内调（onScopeDispose 需绑定活跃 scope），用 options 触发
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(hoisted.checkForUpdate).toHaveBeenCalledWith({ force: false })
    stop()
  })

  it('autoUpdate=false → 恢复链照走但零定时器/零 listener/零联网（RM1，验收①）', async () => {
    hoisted.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    const addListenerSpy = vi.spyOn(document, 'addEventListener')
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    // settings 读取是 fire-and-forget 异步：flush 微任务后再断言
    await vi.advanceTimersByTimeAsync(0)

    // 零联网：30s 首查从未发生
    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
    // 零 listener：visibilitychange 未挂载
    expect(
      addListenerSpy.mock.calls.some(([name]) => name === 'visibilitychange'),
    ).toBe(false)
    // 恢复链照走（本地读取不联网）：getPreloaded/getLaunchResult 被调
    expect(hoisted.getPreloaded).toHaveBeenCalled()
    expect(hoisted.getLaunchResult).toHaveBeenCalled()
    addListenerSpy.mockRestore()
    stop()
  })

  it('首次完成后 60min 周期触发第二次 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })

    // 30s 首次触发
    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    // 60min（60 * 60 * 1000ms）周期触发第二次
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(hoisted.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('守卫：state.state="downloaded" 时定时器触发跳过 checkForUpdate，但仍排下一次', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    // 置为升级流程态（downloaded），定时器触发时不应打断
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30000)
    // 守卫跳过本次检查
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    // 恢复可检测态后，下一个周期应恢复检测（证明仍排了下一次定时器）
    result.state.state = 'idle'
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('守卫：state.state="replacing" 时定时器触发跳过 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    result.state.state = 'replacing'

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('onScopeDispose 清理定时器：dispose 后周期不再触发 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // 触发 onScopeDispose → clearAutoCheckTimer

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1) // 不再触发
  })

  it('可见性补查 10min 节流（RM2.4）：10min 内无重复联网补查（净效果断言）', async () => {
    hoisted.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    // flush settings promise → 30s 首查 timer 排上
    await vi.advanceTimersByTimeAsync(0)

    // 首查触发
    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    // hidden（含 document.hidden，runAutoCheck 守卫读的是它）→ 周期触发置 skipped
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1) // hidden 期间周期跳过联网
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    hiddenSpy.mockReturnValue(false)

    // 恢复可见 → 距首查 60min+ > 10min 窗口 → 补查正常触发（第 2 次）
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(2)

    // 10min 窗口内再次切窗切回（skipped 未置）→ 无第二次补查联网（净效果）
    const hiddenSpy2 = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    hiddenSpy2.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })
})

// ── W4: 启动结果 toast（launch result）──────────────────────────
describe('W4: launch result toast', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
    hoisted.getLaunchResult.mockResolvedValue(null)
    vi.stubGlobal('__APP_VERSION__', '0.0.0')
  })

  afterEach(() => {
    _resetForTest()
  })

  it('A4-done-toast-vitest: done status → info toast sidebar.update.upgradedToast（i18n 解析）', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'done', version: '0.9.9' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // initAutoCheck 内 checkLaunchResult 是 fire-and-forget，等微任务完成。
    // 断言真实 i18n（@/i18n 默认 zh-CN）解析插值后的完整文案，同时锁住 {version} 占位传参
    await vi.waitFor(() => {
      expect(toastFns.info).toHaveBeenCalledWith('已升级到 v0.9.9')
    })
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })

  it('A6-rolledback-toast-vitest: rolled-back status → warning toast sidebar.update.rolledBack（i18n 解析）', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'rolled-back', version: '0.9.7' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // 精确断言 {version} 插值位置在句尾旧版本处
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成，已恢复到 v0.9.7')
    })
    stop()
  })

  it('A5-failed-toast-vitest: failed status → warning toast sidebar.update.upgradeFailed（无版本号）', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'failed', version: '0.9.9' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // upgradeFailed 键不含 {version} 占位：精确断言完整文案 + 仅此一次调用（排除混入带版本的键）
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成')
    })
    expect(toastFns.warning).toHaveBeenCalledTimes(1)
    stop()
  })

  it('A5b-failed-error-mapping-vitest: failed + extract failed → 细分原因文案（A-D1 透传映射）', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'failed', version: '0.9.9', error: 'extract failed' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('解压新版本失败，请检查磁盘空间后重试')
    })
    expect(toastFns.warning).toHaveBeenCalledTimes(1)
    stop()
  })

  it('A5c-failed-unknown-error-fallback-vitest: failed + 未收录 error 码 → 回退通用文案', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'failed', version: '0.9.9', error: 'future-code' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成')
    })
    stop()
  })

  it('A5d-failed-installer-exited-vitest: failed + win 动态码 installer exited 1626 → 安装器文案（前缀匹配）', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'failed', version: '0.9.9', error: 'installer exited 1626' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('安装程序执行失败，请重新下载更新')
    })
    stop()
  })

  it('A7-null-no-toast-vitest: null result → no toast + getLaunchResult 被调用', async () => {
    hoisted.getLaunchResult.mockResolvedValue(null)
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // 给微任务时间完成
    await new Promise((r) => setTimeout(r, 50))
    // A7: getLaunchResult 必须被调用（新实现的 checkLaunchResult 会调它）
    expect(hoisted.getLaunchResult).toHaveBeenCalled()
    // null 结果不弹 toast
    expect(toastFns.info).not.toHaveBeenCalled()
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })
})
