/**
 * useAppUpdate · 手动通道衔接测试（update-network-resilience renderer 侧 D2/D9）。
 *
 * 覆盖：
 *  - D9 suggestion 追加：四类网络/代理错误码（UPDATE_PROXY_UNREACHABLE /
 *    UPDATE_PROXY_ERROR / UPDATE_NETWORK_FAILED / UPDATE_NETWORK_TIMEOUT）→
 *    errorSuggestion 末尾追加手动下载指引；非网络类错误码 / 无错误码不追加
 *  - D2 交错缓解：performInstall 返回实装 version ≠ latestRelease.version →
 *    版本显示对齐（其他字段保留）；version 相同/缺失 → 不动 latestRelease
 *
 * Mock 策略：族级共享 harness（../helpers/app-update-mount.ts）注入内存 adapter 与
 * markdown 桩 '<p>test</p>'；onUpdateError 捕获 cb 供 ipc.fireError 手动触发。
 *  - vi.mock('@/i18n') t 返回 key（追加文案断言 key 本身即可，文案正确性由
 *    update-manual-channel.test.ts 的真实 zh-CN 文案断言守卫）
 *  - 用例体统一经 inUpdateScope 包 effectScope（onScopeDispose 依赖活跃 scope）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.manual-channel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo, UpdateInstallResult } from '@taiji/shared'
// app-update-markdown-stub 必须先于 app-update-mount import（后者加载 SUT 时 mock 工厂立即执行）
import { markdownStubModule } from '../helpers/app-update-markdown-stub'
import { ipc, controller, setupAppUpdateLifecycle, type AppUpdateControllerInternal } from '../helpers/app-update-mount'

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@/composables/logic/markdown', () => markdownStubModule())

// mock t 返回 key：追加段断言 key 本身（真实文案断言在 update-manual-channel.test.ts）
vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => 'zh-CN'),
  default: { global: { t: (key: string) => key } },
}))

setupAppUpdateLifecycle({ markdownHtml: '<p>test</p>' })

beforeEach(() => {
  vi.clearAllMocks()
})

/** 在独立 effectScope 内执行用例体（subscribeProgress/onScopeDispose 需活跃 scope），完跑统一 stop */
async function inUpdateScope(body: (controller: AppUpdateControllerInternal) => Promise<void>): Promise<void> {
  const scope = effectScope()
  await scope.run(() => body(controller))
  scope.stop()
}

/** 构造带完整字段的 release（断言「其他字段保留」用；notes/url 与族级 fixture 不同，留本文件） */
function makeRelease(version: string): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: `notes for ${version}`,
    publishedAt: '2026-08-30T00:00:00Z',
    htmlUrl: `https://github.com/zhushanwen321/tai-ji/releases/tag/v${version}`,
    assets: {},
  }
}

/** D2 公共断言：latestRelease 显示 version、htmlUrl 指向 urlVersion（对齐后其他字段保留的读回核对） */
function expectReleaseShown(state: AppUpdateControllerInternal['state'], version: string, urlVersion: string): void {
  expect(state.latestRelease?.version).toBe(version)
  expect(state.latestRelease?.htmlUrl).toContain(`v${urlVersion}`)
}

/**
 * D2 公共执行体：mock updateInstall 返回 installResult → 认领 0.9.11 → 执行安装 →
 * 断言终态 restarting 与版本显示（url 指向认领版：对齐只覆 version/url，其余字段不动）；
 * then 在 scope 内追加断言（交错场景「其他字段保留」的读回核对）。
 */
async function installClaimedRelease(
  installResult: UpdateInstallResult,
  shownVersion: string,
  then?: (state: AppUpdateControllerInternal['state']) => void,
): Promise<void> {
  ipc.updateInstall.mockResolvedValue(installResult)
  await inUpdateScope(async ({ state, performInstall }) => {
    state.latestRelease = makeRelease('0.9.11')
    await performInstall()
    expect(state.state).toBe('restarting')
    expectReleaseShown(state, shownVersion, '0.9.11')
    then?.(state)
  })
}

describe('D9 suggestion 追加手动下载指引', () => {
  it.each([
    'UPDATE_PROXY_UNREACHABLE',
    'UPDATE_PROXY_ERROR',
    'UPDATE_NETWORK_FAILED',
    'UPDATE_NETWORK_TIMEOUT',
  ])(
    '%s → errorSuggestion 末尾追加手动下载指引',
    async (code) => {
      await inUpdateScope(async (c) => {
        c.subscribeProgress()
        const { state } = c
        ipc.fireError({
          stage: 'downloading',
          message: '下载失败',
          errorCode: code,
          suggestion: '基础恢复指引',
        })
        expect(state.state).toBe('error')
        expect(state.errorSuggestion).toBe('基础恢复指引\nsidebar.update.manualDownloadHint')
      })
    },
  )

  it('网络类错误无 suggestion → errorSuggestion 仅含手动下载指引（无前导换行）', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({ stage: 'downloading', message: '下载失败', errorCode: 'UPDATE_NETWORK_TIMEOUT' })
      expect(state.errorSuggestion).toBe('sidebar.update.manualDownloadHint')
    })
  })

  it('非网络类错误码（UPDATE_INTEGRITY_FAILED）→ 不追加', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({
        stage: 'downloading',
        message: '校验失败',
        errorCode: 'UPDATE_INTEGRITY_FAILED',
        suggestion: '重新下载更新',
      })
      expect(state.errorSuggestion).toBe('重新下载更新')
    })
  })

  it('无 errorCode → 不追加', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({ stage: 'downloading', message: '未知错误', suggestion: '基础指引' })
      expect(state.errorSuggestion).toBe('基础指引')
    })
  })
})

describe('D2 performInstall 实装版本对齐', () => {
  it('install 返回 version ≠ latestRelease.version → 版本显示对齐且其他字段保留', async () => {
    // 实装 0.9.12 覆写显示（认领 0.9.11 → 后台预下载 0.9.12 交错场景）；
    // 其他字段保留（旧 release 的 notes，app 即将重启，生命周期以秒计）
    await installClaimedRelease({ triggerRestart: true, version: '0.9.12' }, '0.9.12', (state) => {
      expect(state.latestRelease?.releaseNotes).toBe('notes for 0.9.11')
    })
  })

  it('install 返回 version 与显示一致 → 不触发对齐（版本保持不变）', async () => {
    ipc.updateInstall.mockResolvedValue({ triggerRestart: true, version: '0.9.11' })
    await inUpdateScope(async ({ state, performInstall }) => {
      state.latestRelease = makeRelease('0.9.11')
      await performInstall()
      // reactive 读回是 proxy，引用断言不可用；版本未变即证明对齐分支未执行
      expectReleaseShown(state, '0.9.11', '0.9.11')
    })
  })

  it('install 返回无 version（读取失败容错）→ latestRelease 不动', async () => {
    await installClaimedRelease({ triggerRestart: true }, '0.9.11')
  })
})
