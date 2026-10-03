// @vitest-environment node

/**
 * HTML 渲染态状态机 + local-file URL 编码单测（chat-html-support §6.4 D4）。
 *
 * 覆盖：
 * - servable 预检三原因（not_found / is_dir / out_of_whitelist）→ 占位带原因
 * - IPC invoke 拒绝 → 占位（原因：预览服务不可用）
 * - servable=true → ready + iframe src；重入 mount（刷新）→ ?r=n 递增 + 重走预检
 * - 占位态 src=null（「刷新」按钮存在性由 src 判定 → 占位态只显「重试」，不并存两按钮）
 * - 并发守卫：旧预检的 stale 结果不覆盖新挂载
 * - URL 路径段百分号编码：`#` / `?` / `%` / 空格文件名
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/file-tree/__tests__/html-preview.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createHtmlPreviewController,
  buildLocalFileUrl,
  encodeLocalFilePath,
  HTML_PREVIEW_REASON_KEYS,
  type HtmlServableResult,
} from '@/composables/features/file-tree/html-preview'

/** 预检桩：按入参返回固定结果 */
function probeOf(result: HtmlServableResult) {
  return vi.fn(async () => result)
}

describe('local-file URL 路径编码（D4 编码规格）', () => {
  it('普通路径：保留 `/` 分隔符，规范化为单个前导 `/`', () => {
    expect(encodeLocalFilePath('/Users/demo/a/report.html')).toBe('/Users/demo/a/report.html')
  })

  it('文件名含 `#`：编码为 %23（裸拼会被 URL 解析吞成 fragment → handler 静默 404）', () => {
    expect(encodeLocalFilePath('/Users/demo/report#1.html')).toBe('/Users/demo/report%231.html')
  })

  it('文件名含 `?`：编码为 %3F（裸拼会被吞成 query）', () => {
    expect(encodeLocalFilePath('/Users/demo/what?.html')).toBe('/Users/demo/what%3F.html')
  })

  it('文件名含 `%`：编码为 %25（裸拼会错解码）', () => {
    expect(encodeLocalFilePath('/Users/demo/100%done.html')).toBe('/Users/demo/100%25done.html')
  })

  it('文件名含空格：编码为 %20', () => {
    expect(encodeLocalFilePath('/Users/demo/my report.html')).toBe('/Users/demo/my%20report.html')
  })

  it('buildLocalFileUrl：local-file:// + 编码路径 + ?r=n（n 仅触发重导航）', () => {
    expect(buildLocalFileUrl('/Users/demo/my report#1.html', 3)).toBe(
      'local-file:///Users/demo/my%20report%231.html?r=3',
    )
  })
})

describe('渲染态挂载状态机 · servable 三原因 → 占位', () => {
  const cases = [
    ['not_found', '文件不存在'],
    ['is_dir', '目标是一个目录'],
    ['out_of_whitelist', '不在预览白名单'],
  ] as const

  for (const [reason, _label] of cases) {
    it(`servable=false reason=${reason} → unavailable + 原因 key，不开 iframe`, async () => {
      const controller = createHtmlPreviewController(probeOf({ servable: false, reason }))
      await controller.mount('/Users/demo/x.html')

      expect(controller.status.value).toBe('unavailable')
      expect(controller.reason.value).toBe(reason)
      expect(controller.reasonKey.value).toBe(HTML_PREVIEW_REASON_KEYS[reason])
      // src=null → 占位态不渲染 iframe，也不显示「刷新」按钮（占位态只显「重试」）
      expect(controller.src.value).toBeNull()
    })
  }

  it('servable=true → ready + src（含 ?r=n），并附 size 不参与状态机', async () => {
    const controller = createHtmlPreviewController(probeOf({ servable: true, size: 2048 }))
    await controller.mount('/Users/demo/report.html')

    expect(controller.status.value).toBe('ready')
    expect(controller.reason.value).toBeNull()
    expect(controller.reasonKey.value).toBeNull()
    expect(controller.src.value).toBe('local-file:///Users/demo/report.html?r=1')
  })

  it('挂载 / 刷新 / 重试是同一入口：重入 mount → 重走预检 + ?r 递增', async () => {
    const probe = probeOf({ servable: true })
    const controller = createHtmlPreviewController(probe)
    await controller.mount('/Users/demo/report.html')
    await controller.mount('/Users/demo/report.html')

    expect(probe).toHaveBeenCalledTimes(2)
    expect(controller.revision.value).toBe(2)
    expect(controller.src.value).toBe('local-file:///Users/demo/report.html?r=2')
  })

  it('刷新时重检：文件被删（预检后残余窗口）→ 占位（原因：文件不存在）', async () => {
    const probe = vi
      .fn<(abs: string) => Promise<HtmlServableResult>>()
      .mockResolvedValueOnce({ servable: true })
      .mockResolvedValueOnce({ servable: false, reason: 'not_found' })
    const controller = createHtmlPreviewController(probe)
    await controller.mount('/Users/demo/report.html')
    expect(controller.status.value).toBe('ready')

    await controller.mount('/Users/demo/report.html')
    expect(controller.status.value).toBe('unavailable')
    expect(controller.reasonKey.value).toBe(HTML_PREVIEW_REASON_KEYS.not_found)
    expect(controller.src.value).toBeNull()
  })
})

describe('渲染态挂载状态机 · IPC invoke 拒绝 → 预览服务不可用', () => {
  it('probe reject → unavailable（原因：预览服务不可用）+ 可重试', async () => {
    const probe = vi
      .fn<(abs: string) => Promise<HtmlServableResult>>()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce({ servable: true })
    const controller = createHtmlPreviewController(probe)

    await controller.mount('/Users/demo/report.html')
    expect(controller.status.value).toBe('unavailable')
    expect(controller.reason.value).toBe('service_unavailable')
    expect(controller.reasonKey.value).toBe(HTML_PREVIEW_REASON_KEYS.service_unavailable)
    expect(controller.src.value).toBeNull()

    // 重试（同一 mount 入口）→ 恢复 ready
    await controller.mount('/Users/demo/report.html')
    expect(controller.status.value).toBe('ready')
    expect(controller.src.value).toBe('local-file:///Users/demo/report.html?r=1')
  })
})

describe('渲染态挂载状态机 · 并发守卫与 reset', () => {
  it('快速切换文件：旧预检的慢响应不覆盖新挂载（stale write 防护）', async () => {
    let resolveFirst: (v: HtmlServableResult) => void = () => {}
    const first = new Promise<HtmlServableResult>((r) => {
      resolveFirst = r
    })
    const probe = vi
      .fn<(abs: string) => Promise<HtmlServableResult>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ servable: true })
    const controller = createHtmlPreviewController(probe)

    const p1 = controller.mount('/Users/demo/a.html')
    const p2 = controller.mount('/Users/demo/b.html')
    await p2
    expect(controller.src.value).toBe('local-file:///Users/demo/b.html?r=1')

    // 旧预检后到：丢弃
    resolveFirst({ servable: true })
    await p1
    expect(controller.src.value).toBe('local-file:///Users/demo/b.html?r=1')
    expect(controller.status.value).toBe('ready')
  })

  it('reset → idle + src/reason 清空（切文件 / 关抽屉）', async () => {
    const controller = createHtmlPreviewController(probeOf({ servable: true }))
    await controller.mount('/Users/demo/report.html')
    controller.reset()

    expect(controller.status.value).toBe('idle')
    expect(controller.src.value).toBeNull()
    expect(controller.reason.value).toBeNull()
  })
})
