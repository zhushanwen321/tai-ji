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
 * - performDownload catch 兜底 / 传给 ipc 的是 version 字符串（批次 3 契约）
 *
 * w2 改造：旧一键 performUpdate 拆为 performDownload（downloaded 态）+ performInstall（restarting 态）。
 *
 * Mock 策略：族级共享 harness（../helpers/app-update-mount.ts）——ipc 七键默认值 +
 * __APP_VERSION__ stub + markdown 桩 '<h2>新特性</h2>'（renderMarkdown 断言经
 * renderMarkdownMock）；场景前置收敛为文件内装置函数：enterAvailable（进入 available 态）、
 * makeDownloadStale（STALE 交错）、primePreloaded（预下载守卫）、launchWithResult（W4 toast）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo, LaunchResult } from '@taiji/shared'
// app-update-markdown-stub 必须先于 app-update-mount import（后者加载 SUT 时 mock 工厂立即执行）
import { markdownStubModule, renderMarkdownMock } from '../helpers/app-update-markdown-stub'
import {
  ipc,
  controller,
  makeUpdateRelease,
  setupAppUpdate,
  setupAppUpdateLifecycle,
  type AppUpdateHandle,
} from '../helpers/app-update-mount'

// W4: useToast mock（launch result toast 测试用）
const toastFns = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastFns,
}))

vi.mock('@/composables/logic/markdown', () => markdownStubModule())

setupAppUpdateLifecycle({ primeIpc: true, stubAppVersion: true, markdownHtml: '<h2>新特性</h2>' })

/** 进入 available 态的公共前置：mock 检出指定版本（默认 0.9.0，null = 无新版）→ 订阅 → 执行一次检查 */
async function enterAvailable(info: LatestReleaseInfo | null = makeUpdateRelease('0.9.0')): Promise<AppUpdateHandle> {
  ipc.checkForUpdate.mockResolvedValue({ info, rateLimited: false })
  const handle = setupAppUpdate()
  await handle.result.checkForUpdate()
  return handle
}

/** STALE 装置：下载期间 main 权威拒绝旧版（推 UPDATE_STALE_RELEASE 错误并 reject） */
function makeDownloadStale(): void {
  ipc.updateDownload.mockImplementation(async () => {
    ipc.fireError({ stage: 'downloading', message: '更新信息已过期', errorCode: 'UPDATE_STALE_RELEASE' })
    throw { message: '更新信息已过期', stage: 'downloading', errorCode: 'UPDATE_STALE_RELEASE' }
  })
}

/** 预下载恢复装置：置 getPreloaded 产物（可选先 stub 当前版本触发守卫分支）→ 订阅 → 执行恢复 */
async function restorePreloaded(
  release: LatestReleaseInfo | null,
  appVersion?: string,
): Promise<AppUpdateHandle & { restored: boolean }> {
  if (appVersion !== undefined) vi.stubGlobal('__APP_VERSION__', appVersion)
  ipc.getPreloaded.mockResolvedValue(release === null ? null : { release, filePath: '/tmp/preloaded.zip' })
  const handle = setupAppUpdate()
  const restored = await controller.restorePreloadedUpdate()
  return { ...handle, restored }
}

/** RD-4#5 装置：置 check 网络失败后按触发轴执行检查（manual 显形 / auto 静默断言留在用例） */
async function checkWithNetworkFailure(force: boolean, source: 'manual' | 'auto'): Promise<AppUpdateHandle> {
  ipc.checkForUpdate.mockRejectedValue(new Error('network down'))
  const handle = setupAppUpdate()
  await handle.result.checkForUpdate(force, source)
  return handle
}

/** W4 装置：置 launch result 后 initAutoCheck 启动（toast 断言留在用例，返回 stop 收尾） */
function launchWithResult(result: LaunchResult): () => void {
  ipc.getLaunchResult.mockResolvedValue(result)
  const { stop } = setupAppUpdate({ initAutoCheck: true })
  return stop
}

describe('useAppUpdate', () => {
  it('checkForUpdate 有新版 → state="available" + latestRelease 填充', async () => {
    const { result, stop } = await enterAvailable()
    // renderMarkdown 异步，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    expect(renderMarkdownMock).toHaveBeenCalledWith('## 新特性\n- 支持 foo')
    stop()
  })

  it('checkForUpdate 无新版 → state="idle"', async () => {
    const { result, stop } = await enterAvailable(null)
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('checkForUpdate 限额退避（rateLimited=true）→ 状态不回退 + 每窗口一次性提示（RM2.3）', async () => {
    toastFns.info.mockClear()
    // 先进入 available（已有升级提醒）
    ipc.checkForUpdate.mockResolvedValueOnce({ info: makeUpdateRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('available')

    // 退避窗口内的检查（周期/补查/手动同路径）：null + rateLimited=true
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })
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
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    await result.checkForUpdate(true)
    expect(result.state.state).toBe('idle')

    // 新退避窗口可再次提示
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })
    await result.checkForUpdate(true)
    expect(toastFns.info).toHaveBeenCalledTimes(2)
    stop()
  })

  it('onUpdateError UPDATE_STALE_RELEASE → 不进 error 态，自动重查拿新 latest（§3.5.1② / T3）', async () => {
    toastFns.info.mockClear()
    toastFns.error.mockClear()
    const { result, stop } = await enterAvailable()
    expect(result.state.state).toBe('available')

    // 用户点下载期间服务端发了更新版本：main 权威解析拒绝旧版本并推 STALE 错误
    makeDownloadStale()
    // 自动重查拿到更新的 latest
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.9.1'), rateLimited: false })

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
    const { result, stop } = await enterAvailable()
    expect(result.state.state).toBe('available')

    // STALE 错误推送触发自动重查，重查恰逢限额退避窗口：{info:null, rateLimited:true}
    makeDownloadStale()
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: true })

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
    const { result, stop } = await enterAvailable()
    ipc.updateDownload.mockImplementation(async () => {
      // 触发主进程推送：downloading 30% → replacing 100%（verifying 已随批次 3 删 perform 移除，m3）
      ipc.fireProgress({ stage: 'downloading', percent: 30 })
      ipc.fireProgress({ stage: 'replacing', percent: 100 })
      return { downloaded: true }
    })
    await result.performDownload()

    // 推送过程中 percent 累积到 100；downloaded:true → state=downloaded（下载止于此，restart 是 install 阶段）
    expect(result.state.percent).toBe(100)
    expect(result.state.state).toBe('downloaded')
    expect(ipc.updateDownload).toHaveBeenCalled()
    stop()
  })

  it('performDownload 在 progress 推到中间态后 resolve {downloaded:true}，state 置 downloaded 不卡在 downloading', async () => {
    const { result, stop } = await enterAvailable()
    // 模拟：main 只推了一次 downloading 进度，updateDownload 随即 resolve
    ipc.updateDownload.mockImplementation(async () => {
      ipc.fireProgress({ stage: 'downloading', percent: 50 })
      return { downloaded: true }
    })
    await result.performDownload()

    // downloaded:true 覆盖中间态 → state=downloaded（不卡在 downloading）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.percent).toBe(50)
    stop()
  })

  it('performDownload downloaded=true → state="downloaded"（基础成功路径）', async () => {
    const { result, stop } = await enterAvailable()
    await result.performDownload()

    expect(result.state.state).toBe('downloaded')
    stop()
  })

  it('onUpdateError 推送 → state="error" + errorMessage（SSOT）', async () => {
    const { result, stop } = await enterAvailable()
    ipc.updateDownload.mockImplementation(async () => {
      // 触发主进程错误推送（SSOT 优先于 performDownload catch）
      ipc.fireError({ stage: 'downloading', message: '校验失败：sha256 不匹配' })
      return { downloaded: false }
    })
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('校验失败：sha256 不匹配')
    stop()
  })

  it('onUpdateError errorCode="UPDATE_UNSUPPORTED_PLATFORM" → state="unsupported"', async () => {
    const { result, stop } = await enterAvailable()
    ipc.updateDownload.mockImplementation(async () => {
      ipc.fireError({
        stage: 'init',
        message: '当前平台不支持自动升级',
        errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
      })
      return { downloaded: false }
    })
    await result.performDownload()

    expect(result.state.state).toBe('unsupported')
    stop()
  })

  it('performDownload catch 在 !errorHandled 时兜底置 error（去重：onUpdateError 未触发）', async () => {
    const { result, stop } = await enterAvailable()
    // updateDownload reject 且未触发 onUpdateError → 走兜底 error
    ipc.updateDownload.mockRejectedValue(new Error('网络中断'))
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络中断')
    stop()
  })

  // ── W3 验收并入（原独立文件 useAppUpdate.w3-acceptance.test.ts，同 mock 装置）──
  // errorSuggestion 填充（D9 网络类错误码追加手动下载指引）+ toast 只弹摘要。
  const MANUAL_HINT_ZH = '也可从 release 页手动下载安装包，放入手动升级目录后重试（目录路径见 设置 → 更新 → 手动升级通道）'

  it('onUpdateError 带 suggestion 的网络类错误 → errorSuggestion = suggestion + D9 追加段', () => {
    const { result, stop } = setupAppUpdate()
    ipc.fireError({
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
    const { result, stop } = setupAppUpdate()
    ipc.fireError({ stage: 'downloading', message: '网络连接失败', errorCode: 'UPDATE_NETWORK_FAILED' })

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络连接失败')
    expect(result.state.errorSuggestion).toBe(MANUAL_HINT_ZH)
    stop()
  })

  it('onUpdateError 触发 error toast，只弹摘要不弹 suggestion（单参数）', () => {
    setupAppUpdate()
    // toastFns 为模块级 hoisted spy（不被 beforeEach 重置），用例内先清零隔离
    toastFns.error.mockClear()
    ipc.fireError({
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
  // 用户在 UpdateButton hover 看到英文 clone 报错。
  // [批次 3 RC1] 旧用例验证「传给 ipc 的是 plain object（toRaw 解包）」——契约版本号化后
  // updateDownload 只传 version 字符串，proxy/structuredClone 问题不再存在；本用例改为
  // 断言传给 ipc 的是 available release 的 version 字段（意图透传）。
  it('performDownload 传给 ipc 的是 available release 的 version 字符串（批次 3 契约）', async () => {
    const { result, stop } = await enterAvailable()
    // 捕获 updateDownload 实际收到的参数（IPC 入参）
    const received: string[] = []
    ipc.updateDownload.mockImplementation(async (v) => {
      received.push(v)
      return { downloaded: true }
    })
    await result.performDownload()

    expect(received).toEqual(['0.9.0'])
    stop()
  })

  it('openFallbackUrl 调 ipc.openUpdateFallbackUrl(latestRelease.htmlUrl)', async () => {
    ipc.openUpdateFallbackUrl.mockResolvedValue(undefined)
    const { result, stop } = await enterAvailable()
    await result.openFallbackUrl()

    expect(ipc.openUpdateFallbackUrl).toHaveBeenCalledWith(makeUpdateRelease('0.9.0').htmlUrl)
    stop()
  })

  // ── RD-4#9：逃生通道自身裸崩修复 ──
  it('RD-4#9: openFallbackUrl IPC 失败 → toastError 带可复制 URL（不变 unhandledRejection）', async () => {
    ipc.openUpdateFallbackUrl.mockRejectedValue(new Error('shell.openPath failed'))
    toastFns.error.mockClear()
    const { result, stop } = await enterAvailable()
    await result.openFallbackUrl()

    // 逃生通道自身失败不再静默失灵：toast 报错并把 release.htmlUrl 直接可复制地给出
    expect(toastFns.error).toHaveBeenCalledWith('无法打开下载页，请手动访问 ' + makeUpdateRelease('0.9.0').htmlUrl)
    stop()
  })

  // ── RD-4#5：手动检查失败显形 / 自动检查保持静默 ──
  it('RD-4#5: manual 检查网络失败 → state="error" + errorMessage（与「已是最新」可区分）', async () => {
    const { result, stop } = await checkWithNetworkFailure(true, 'manual')

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络不可达，请检查连接或前往下载页')
    stop()
  })

  it('RD-4#5: auto 检查网络失败 → 保持静默回退 idle（不打 error 态）', async () => {
    const { result, stop } = await checkWithNetworkFailure(false, 'auto')

    expect(result.state.state).toBe('idle')
    expect(result.state.errorMessage).toBe('')
    stop()
  })

  // ── performInstall（安装/重启阶段）──
  it('performInstall 乐观置 replacing（IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态）', async () => {
    // updateInstall 返回 pending promise，调 performInstall 后同步检查 state
    let resolveInstall!: (v: { triggerRestart: boolean }) => void
    ipc.updateInstall.mockImplementation(
      () => new Promise<{ triggerRestart: boolean }>((r) => { resolveInstall = r }),
    )
    const { result, stop } = setupAppUpdate()
    const p = result.performInstall()
    // 同步断言：state 已乐观置 replacing（不等 IPC 往返）
    expect(result.state.state).toBe('replacing')
    resolveInstall({ triggerRestart: false })
    await p
    stop()
  })

  it('performInstall triggerRestart=true → state="restarting"', async () => {
    const { result, stop } = setupAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('restarting')
    stop()
  })

  it('performInstall 失败 → state="error" + errorMessage（兜底）', async () => {
    ipc.updateInstall.mockRejectedValue(new Error('替换文件失败'))
    const { result, stop } = setupAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('替换文件失败')
    stop()
  })

  // ── restorePreloadedUpdate（功能 2：预下载恢复）──
  it('restorePreloadedUpdate 有效预下载产物 → state="downloaded" + latestRelease 填充，返回 true', async () => {
    const { result, stop, restored } = await restorePreloaded(makeUpdateRelease('0.9.0'))

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('restorePreloadedUpdate 无预下载产物（null）→ no-op，state 不变，返回 false', async () => {
    const { result, stop, restored } = await restorePreloaded(null)

    expect(restored).toBe(false)
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  // ── restorePreloadedUpdate 版本守卫（w2-frontend-guard：前端兜底拦截过期产物）──
  it('W2TC1：currentVersion < preloaded.version（0.8.48 < 0.8.49）→ 守卫放行，恢复 downloaded', async () => {
    const { result, stop, restored } = await restorePreloaded(makeUpdateRelease('0.8.49'), '0.8.48')

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.49')
    stop()
  })

  it('W2TC2：currentVersion >= preloaded.version（0.8.49 >= 0.8.49）→ 守卫拦截，不恢复，回退 pending', async () => {
    const { result, stop, restored } = await restorePreloaded(makeUpdateRelease('0.8.49'), '0.8.49')

    expect(restored).toBe(false)
    expect(result.state.state).not.toBe('downloaded')
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('W2TC3：preloaded.version 非 semver → compare 抛错 catch 后继续恢复（对齐后端 keep 语义）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // makeUpdateRelease 填合法字段，仅覆盖 version 为非法 semver 触发 compare 抛错
    const { result, stop, restored } = await restorePreloaded(
      { ...makeUpdateRelease('0.8.49'), version: 'not-a-version' },
      '0.8.49',
    )

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
    const { result, stop } = await restorePreloaded(makeUpdateRelease('0.8.44'))
    expect(result.state.state).toBe('downloaded')

    // 同版本检测（mock 排在恢复后、checkForUpdate 调用前即生效）
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.8.44'), rateLimited: false })
    await result.checkForUpdate()
    // ES4：downloaded + 同版本 → 不覆盖，保持 downloaded（仅刷新 latestRelease）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.44')
    stop()
  })

  it('状态守卫 ES5：downloaded 态检测到更新版本 → 退回 available（追新版）', async () => {
    const { result, stop } = await restorePreloaded(makeUpdateRelease('0.8.44'))
    expect(result.state.state).toBe('downloaded')

    // 更新版本检测
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.8.46'), rateLimited: false })
    await result.checkForUpdate()
    // ES5：downloaded + 更新版本 → 退回 available（追新版，旧 preloaded 由 main 侧下次 download 自动清）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.8.46')
    stop()
  })
})

// ── RD-4#4：订阅引用计数修正（第 2/3 消费者也注册 onScopeDispose，末位 dispose 才退订）──
describe('useAppUpdate 订阅引用计数（RD-4#4）', () => {
  it('多消费者：listener 只注册一次；首/中 dispose 不退订，末位 dispose 才退订', () => {
    const scope1 = effectScope()
    const scope2 = effectScope()
    scope1.run(() => { controller.subscribeProgress() })
    scope2.run(() => { controller.subscribeProgress() })
    const r1 = controller
    const r2 = controller

    // 同一控制器的多消费者读同一份 state（容器化后单实例共享 state，结构恒成立）
    expect(r1.state).toBe(r2.state)
    // 旧 bug：第 2 消费者在 refCount!==1 时早退 return，永不注册 onScopeDispose。修正后
    // listener 仍只注册一次（仅首个消费者），但每个消费者都挂了 onScopeDispose。
    expect(ipc.onUpdateProgress).toHaveBeenCalledTimes(1)
    expect(ipc.onUpdateError).toHaveBeenCalledTimes(1)

    // 首个消费者 dispose → refCount 2→1（未归零），不退订：进度推送仍可达存活消费者
    scope1.stop()
    ipc.fireProgress({ stage: 'downloading', percent: 42 })
    expect(r2.state.percent).toBe(42)

    // 末位消费者 dispose → refCount 归零，退订：进度推送不再可达
    scope2.stop()
    ipc.fireProgress({ stage: 'downloading', percent: 99 })
    expect(r2.state.percent).toBe(42)
  })

  it('三个消费者：第 3 个 dispose 后才真正退订（onUpdateError 亦只注册一次）', () => {
    const scopes = [effectScope(), effectScope(), effectScope()]
    scopes.forEach((s) => {
      s.run(() => { controller.subscribeProgress() })
    })
    const results = [controller, controller, controller]
    expect(ipc.onUpdateError).toHaveBeenCalledTimes(1)

    scopes[0].stop()
    scopes[1].stop()
    // 还差一个存活：错误推送仍可达
    ipc.fireError({ stage: 'downloading', message: 'still alive' })
    expect(results[2].state.state).toBe('error')
    expect(results[2].state.errorMessage).toBe('still alive')

    // 末位 dispose → 退订，错误推送不再可达
    results[2].state.state = 'idle'
    scopes[2].stop()
    ipc.fireError({ stage: 'downloading', message: 'after teardown' })
    expect(results[2].state.state).toBe('idle')
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
    // initAutoCheck 必须在 scope 内调（onScopeDispose 需绑定活跃 scope），用 options 触发
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(ipc.checkForUpdate).toHaveBeenCalledWith({ force: false })
    stop()
  })

  it('autoUpdate=false → 恢复链照走但零定时器/零 listener/零联网（RM1，验收①）', async () => {
    ipc.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    const addListenerSpy = vi.spyOn(document, 'addEventListener')
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    // settings 读取是 fire-and-forget 异步：flush 微任务后再断言
    await vi.advanceTimersByTimeAsync(0)

    // 零联网：30s 首查从未发生
    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    // 零 listener：visibilitychange 未挂载
    expect(
      addListenerSpy.mock.calls.some(([name]) => name === 'visibilitychange'),
    ).toBe(false)
    // 恢复链照走（本地读取不联网）：getPreloaded/getLaunchResult 被调
    expect(ipc.getPreloaded).toHaveBeenCalled()
    expect(ipc.getLaunchResult).toHaveBeenCalled()
    addListenerSpy.mockRestore()
    stop()
  })

  it('首次完成后 60min 周期触发第二次 checkForUpdate', async () => {
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })

    // 30s 首次触发
    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 60min（60 * 60 * 1000ms）周期触发第二次
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(ipc.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('守卫：state.state="downloaded" 时定时器触发跳过 checkForUpdate，但仍排下一次', async () => {
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    // 置为升级流程态（downloaded），定时器触发时不应打断
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30000)
    // 守卫跳过本次检查
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    // 恢复可检测态后，下一个周期应恢复检测（证明仍排了下一次定时器）
    result.state.state = 'idle'
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('守卫：state.state="replacing" 时定时器触发跳过 checkForUpdate', async () => {
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    result.state.state = 'replacing'

    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('onScopeDispose 清理定时器：dispose 后周期不再触发 checkForUpdate', async () => {
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })

    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // 触发 onScopeDispose → clearAutoCheckTimer

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1) // 不再触发
  })

  it('可见性补查 10min 节流（RM2.4）：10min 内无重复联网补查（净效果断言）', async () => {
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    // flush settings promise → 30s 首查 timer 排上
    await vi.advanceTimersByTimeAsync(0)

    // 首查触发
    await vi.advanceTimersByTimeAsync(30000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // hidden（含 document.hidden，runAutoCheck 守卫读的是它）→ 周期触发置 skipped
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1) // hidden 期间周期跳过联网
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    hiddenSpy.mockReturnValue(false)

    // 恢复可见 → 距首查 60min+ > 10min 窗口 → 补查正常触发（第 2 次）
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)

    // 10min 窗口内再次切窗切回（skipped 未置）→ 无第二次补查联网（净效果）
    const hiddenSpy2 = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    hiddenSpy2.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })
})

// ── W4: 启动结果 toast（launch result）──────────────────────────
describe('W4: launch result toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('A4-done-toast-vitest: done status → info toast sidebar.update.upgradedToast（i18n 解析）', async () => {
    const stop = launchWithResult({ status: 'done', version: '0.9.9' })
    // initAutoCheck 内 checkLaunchResult 是 fire-and-forget，等微任务完成。
    // 断言真实 i18n（@/i18n 默认 zh-CN）解析插值后的完整文案，同时锁住 {version} 占位传参
    await vi.waitFor(() => {
      expect(toastFns.info).toHaveBeenCalledWith('已升级到 v0.9.9')
    })
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })

  it('A6-rolledback-toast-vitest: rolled-back status → warning toast sidebar.update.rolledBack（i18n 解析）', async () => {
    const stop = launchWithResult({ status: 'rolled-back', version: '0.9.7' })
    // 精确断言 {version} 插值位置在句尾旧版本处
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成，已恢复到 v0.9.7')
    })
    stop()
  })

  it('A5-failed-toast-vitest: failed status → warning toast sidebar.update.upgradeFailed（无版本号）', async () => {
    const stop = launchWithResult({ status: 'failed', version: '0.9.9' })
    // upgradeFailed 键不含 {version} 占位：精确断言完整文案 + 仅此一次调用（排除混入带版本的键）
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成')
    })
    expect(toastFns.warning).toHaveBeenCalledTimes(1)
    stop()
  })

  it('A5b-failed-error-mapping-vitest: failed + extract failed → 细分原因文案（A-D1 透传映射）', async () => {
    const stop = launchWithResult({ status: 'failed', version: '0.9.9', error: 'extract failed' })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('解压新版本失败，请检查磁盘空间后重试')
    })
    expect(toastFns.warning).toHaveBeenCalledTimes(1)
    stop()
  })

  it('A5c-failed-unknown-error-fallback-vitest: failed + 未收录 error 码 → 回退通用文案', async () => {
    const stop = launchWithResult({ status: 'failed', version: '0.9.9', error: 'future-code' })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('上次升级未完成')
    })
    stop()
  })

  it('A5d-failed-installer-exited-vitest: failed + win 动态码 installer exited 1626 → 安装器文案（前缀匹配）', async () => {
    const stop = launchWithResult({ status: 'failed', version: '0.9.9', error: 'installer exited 1626' })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('安装程序执行失败，请重新下载更新')
    })
    stop()
  })

  it('A7-null-no-toast-vitest: null result → no toast + getLaunchResult 被调用', async () => {
    const stop = launchWithResult(null)
    // 给微任务时间完成（0ms 宏任务让步足够——姊妹用例已证明，无需 50ms 真实等待）
    await new Promise((r) => setTimeout(r, 0))
    // A7: getLaunchResult 必须被调用（新实现的 checkLaunchResult 会调它）
    expect(ipc.getLaunchResult).toHaveBeenCalled()
    // null 结果不弹 toast
    expect(toastFns.info).not.toHaveBeenCalled()
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })
})
