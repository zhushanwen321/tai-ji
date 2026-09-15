/**
 * T4.6（e2e real）：跨进程持久化 record → 重启 → list 一致（AC-7.1）。
 *
 * 完整 real 链路：Electron（real renderer bundle）+ runtime（spawn pi 子进程）+ real WS。
 * 验证「文件作为跨进程介质」：app A record 落盘 → app B（新进程）读同一文件 → records 一致。
 *
 * 为什么 create 用 WS 而非 UI 点击：
 * - 选目录走 electron dialog.showOpenDialog（OS 原生，Playwright 不可自动化）
 * - TEST-STRATEGY 既定约定：OS 原生 dialog 标 [需手工]，E2E 用 WS 直连触发等效业务动作
 * - T4.6 核心是「持久化」，create 只是触发 record 的手段；record 触发点（session-lifecycle.create）
 *   在 real runtime 内部，WS session.create 与 UI 点击走同一 runtime 代码路径
 *
 * faux LLM 轨（L2.5 翻轨，2026-09-15）：全程无 LLM turn（responses: []）——本用例只验证
 * 跨进程持久化，凭证无关化 = 移除真实凭证拷贝，装配改 launchRealApp({ faux })。
 * pi 的 create 门禁（getDefaultModel）由 faux settings/models 预置满足。
 */
import { test, expect } from '@playwright/test'
import { launchRealApp, waitForRuntime, wsRoundTrip } from './fixtures/launch-app-real'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

test('T4.6 (e2e real): record → 重启 → list 一致（跨进程持久化 AC-7.1）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-t46-'))

  // ── app A：create session → record 落盘 ──────────────────────
  const appA = await launchRealApp({ dataDir, faux: { responses: [] } })
  try {
    await expect(appA.page).toHaveTitle(/太极/)
    const portA = await waitForRuntime(dataDir, 30_000)

    const createReply = await wsRoundTrip(portA, {
      type: 'session.create', id: 't46-create',
      payload: { cwd: SAMPLE_PROJECT, label: 't46-sample' },
    }, 't46-create')
    expect(createReply.type).toBe('session.created')

    // 等 record 落盘（debounce 500ms + flush）
    await new Promise((r) => setTimeout(r, 2500))
    const recordsFile = path.join(dataDir, 'recent-workspaces.json')
    expect(fs.existsSync(recordsFile), 'recent-workspaces.json 应已落盘').toBe(true)
    const recordsA = JSON.parse(fs.readFileSync(recordsFile, 'utf-8'))
    expect(recordsA.some((r: any) => r.cwd === SAMPLE_PROJECT)).toBe(true)
  } finally {
    await appA.cleanup()
  }

  // ── app B：新进程重启，读同一 dataDir ──────────────────────
  const appB = await launchRealApp({ dataDir, faux: { responses: [] } })
  try {
    await expect(appB.page).toHaveTitle(/太极/)
    const portB = await waitForRuntime(dataDir, 30_000)

    // AC-7.1 核心：WS listRecent → records 含 app A record 的 cwd
    const listReply = await wsRoundTrip(portB, {
      type: 'workspace.listRecent', id: 't46-list', payload: {},
    }, 't46-list')
    expect(listReply.type).toBe('workspace.recentList')
    const recordsB = listReply.payload.records
    expect(recordsB.some((r: any) => r.cwd === SAMPLE_PROJECT)).toBe(true)
    expect(recordsB.find((r: any) => r.cwd === SAMPLE_PROJECT)?.label).toBe('sample-project')

    // UI 断言（real renderer）：重启后 workspaceStore.load 自动拉 records，popover 展示
    await expect(appB.page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
    await appB.page.getByTestId('chip-directory').click()
    await expect(appB.page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
    await expect(appB.page.getByTestId('workspace-item').filter({ hasText: 'sample-project' })).toBeVisible()
  } finally {
    await appB.cleanup()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
