/**
 * a6-dual-window-revision —— 验收场景 6（设计 §8）：双窗口并发编辑（负面）+ P-5 探针。
 *
 * 回溯目标 4。第二窗口无用户入口——经主进程建窗 IPC 直调创建（preload electronAPI.createWindow
 * → bridge-handlers CREATE_WINDOW，设计 §8 场景 6 注明的验收脚本手段）。
 *
 * 通过标准（设计 §8 场景 6）：
 *   最终 projects.json 内容与最后一命令一致且含全部新建；无整表互相覆盖丢数据；
 *   后发命令若因 revision 过期被拒，窗口自动重拉最新状态（project.changed 广播）并提示用户重试。
 * 随场景断言 P-5（双窗口并发命令串行且互不覆盖）与 P-4 写侧（存量无 revision 文件首写补 1）。
 *
 * 机制（源码核对）：runtime 命令入口串行队列 + revision 校验（project-store.ts:237-245，
 * 失配抛 project_revision_mismatch）；命令成功广播 project.changed 失效信号
 * （project-message-handler.ts:91，各窗口据此重拉）；renderer 同窗口命令串行排队、
 * 执行时读最新水位（stores/project.ts runCommand）。
 */
import path from 'node:path'

import { PROD_DATA_DIR, pollUntil, readJsonFile, seedRealisticDataDir, waitForSidebarGroups } from './lib-conn-datasync.mjs'

export const meta = {
  id: 'a6-dual-window-revision',
  priority: 'P1',
  title: '场景 6：双窗口并发编辑 revision 保护（P-5 + P-4 写侧）',
  covers: ['env.launch', 'env.ready', 'session.list'],
  requires: ['none'],
  estimateSec: 360,
  provable: [
    '第二窗口经 electronAPI.createWindow 建出并独立完成连接与加载',
    '双窗口近同时改名（并发）：最终 projects.json 与最后一命令一致、无整表互相覆盖（全部项目在场）',
    'P-5：两窗口经 project.changed 广播自动收敛到同一终态（组名清单一致）',
    'P-4 写侧：存量无 revision 文件首写补 revision=1，后续写递增',
    '双窗口各新建 1 个项目均落盘且双边可见',
  ],
  notProvable: [
    '同一窗口内的快速连续命令竞争（由 U6a 单测「串行队列：并发到达的两命令依序执行」承载）',
    'revision 拒绝时的 toast 文案细节（UI 通道只断言收敛结果；拒绝路径由单测层断言）',
  ],
}

/** 组头重命名 UI 驱动（hover 出操作钮 → 点 rename → 填输入 → Enter）。 */
async function renameGroupInWindow(page, ev, projectId, newName, label) {
  await page.hover(`[data-testid="project-group"][data-project-id="${projectId}"] [data-testid="project-group-head"]`, { timeout: 15_000 })
  await page.click(`[data-testid="project-group"][data-project-id="${projectId}"] [data-testid="project-group-rename"]`, { timeout: 15_000 })
  const inputSel = `[data-testid="project-rename-input-${projectId}"]`
  await page.waitForSelector(inputSel, { timeout: 15_000 })
  await page.fill(inputSel, newName)
  await page.press(inputSel, 'Enter')
  ev.step({ step: `rename.${label}`, channel: 'A', exitCode: 0, stats: { projectId, newName } })
}

/** 新建项目 UI 驱动（区头 + → 草稿输入 → Enter）。 */
async function addProjectInWindow(page, ev, name, label) {
  await page.click('[data-testid="project-add-btn"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="project-create-input"]', { timeout: 15_000 })
  await page.fill('[data-testid="project-create-input"]', name)
  await page.press('[data-testid="project-create-input"]', 'Enter')
  ev.step({ step: `create.${label}`, channel: 'A', exitCode: 0, stats: { name } })
}

/** 读取窗口内指定 projectId 的组名（null = 组不在）。 */
async function groupNameInWindow(page, projectId) {
  const groups = await page.$$eval('[data-testid="project-group"]', (nodes, pid) => {
    const n = nodes.find((x) => x.getAttribute('data-project-id') === pid)
    return n?.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? null
  }, projectId)
  return groups
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    '并发形态 = 两窗口改名指令间隔 ~300ms 背靠背发出（不等首个回执）——runtime 串行队列 + revision 校验裁决，后至的失配命令被拒并经 project.changed 广播收敛',
  ]

  // ── 段 0：种子 + 基线 + 建第二窗口 ──────────────────────────────
  await instance.stop()
  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR })
  const seeded = readJsonFile(path.join(dataDir, 'projects.json'))
  const namedProjects = seeded.projects.filter((p) => p.id !== 'proj-default' && p.name)
  const target = namedProjects[0]
  ev.step({ step: 'seed.realistic-data', channel: 'C', exitCode: 0, stats: { boundSessions: seed.sessions.length, renameTarget: target.id } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  const page1 = await instance.page()
  const baseGroups = await waitForSidebarGroups(page1, { minGroups: namedProjects.length, timeoutMs: 60_000 })
  const projectsFile = path.join(dataDir, 'projects.json')
  ev.assert('基线：projects.json 为存量无 revision 形态（P-4 写侧前提）', readJsonFile(projectsFile).revision === undefined, {
    channel: 'C',
    expected: 'revision 缺位',
    actual: `revision=${readJsonFile(projectsFile).revision ?? '(缺)'}`,
  })
  await ev.shot(page1, 'a6-window1-baseline')

  // 第二窗口：electronAPI.createWindow（主进程建窗 IPC 直调）
  const created = await page1.evaluate(async () => {
    const api = window.electronAPI
    if (!api?.createWindow) return { ok: false, reason: 'electronAPI.createWindow 缺失' }
    const r = await api.createWindow()
    return { ok: true, windowId: r?.windowId ?? null }
  })
  ev.assert('A: 第二窗口经 electronAPI.createWindow 建出', created.ok === true, {
    channel: 'A',
    expected: '{ok:true}',
    actual: JSON.stringify(created),
  })
  const browser = page1.__verifyBrowser
  const page2 = await pollUntil(
    async () => {
      const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes(`:${instance.info().vitePort}`))
      const other = pages.find((p) => p !== page1)
      return other ?? null
    },
    { timeoutMs: 30_000, intervalMs: 500, label: '第二窗口 CDP 页面出现' },
  )
  const w2Groups = await waitForSidebarGroups(page2, { minGroups: namedProjects.length, timeoutMs: 90_000 })
  ev.assert('A: 第二窗口独立完成连接与加载（分组呈现）', w2Groups.length >= namedProjects.length, {
    channel: 'A',
    expected: `≥${namedProjects.length} 组`,
    actual: `${w2Groups.length} 组`,
  })
  await ev.shot(page2, 'a6-window2-baseline')

  // ── 段 1：三轮背靠背并发改名（同一项目） ────────────────────────
  // 拒绝 toast 观察（软证据：是否命中「后发命令因 revision 过期被拒 + 提示重试」路径）
  let rejectionToastSeen = false
  const toastWatcher = setInterval(() => {
    void page2
      .evaluate(() => document.body.innerHTML.includes('项目操作失败'))
      .then((hit) => {
        if (hit) rejectionToastSeen = true
      })
      .catch(() => {})
  }, 500)

  const rounds = []
  for (let r = 1; r <= 3; r += 1) {
    const name1 = `A6-W1-R${r}`
    const name2 = `A6-W2-R${r}`
    // 背靠背发出（不等回执）——并发形态
    const p1Rename = renameGroupInWindow(page1, ev, target.id, name1, `w1-r${r}`)
    await new Promise((res) => setTimeout(res, 300))
    const p2Rename = renameGroupInWindow(page2, ev, target.id, name2, `w2-r${r}`)
    await Promise.allSettled([p1Rename, p2Rename])

    // 收敛：两窗口组名一致（project.changed 广播驱动重拉）
    const converged = await pollUntil(
      async () => {
        const [n1, n2] = await Promise.all([groupNameInWindow(page1, target.id), groupNameInWindow(page2, target.id)])
        return n1 && n1 === n2 ? { name: n1, w1: n1, w2: n2 } : null
      },
      { timeoutMs: 30_000, intervalMs: 400, label: `第 ${r} 轮双窗口收敛` },
    )
    // 落盘收敛：WriteBackCache flushMs=500（project-store.ts:113）——DOM 收敛（回执驱动）
    // 早于 debounce 落盘，直接读文件会读到上一轮状态。等文件出现本轮收敛名 + revision 字段。
    const fileNow = await pollUntil(
      async () => {
        try {
          const f = readJsonFile(projectsFile)
          const t = f.projects.find((x) => x.id === target.id)
          if (t?.name === converged.name && typeof f.revision === 'number') return f
        } catch {
          /* 写盘中（atomicWrite tmp+rename 窗口） */
        }
        return null
      },
      { timeoutMs: 15_000, intervalMs: 200, label: `第 ${r} 轮落盘收敛（debounce flush）` },
    )
    rounds.push({ round: r, name1, name2, convergedTo: converged.name, revision: fileNow.revision })
    ev.step({ step: `round.${r}.converged`, channel: 'A', exitCode: 0, stats: { ...rounds[rounds.length - 1] } })
    log(`round ${r}: 收敛到 ${converged.name}（revision=${fileNow.revision}）`)
  }
  clearInterval(toastWatcher)

  // P-4 写侧：存量无 revision 文件首写补 revision（第 1 轮至多两窗各一条命令 → revision ∈ {1,2}）
  ev.assert('P-4 写侧：存量无 revision 文件首写即补 revision 水位（第 1 轮后 ∈ {1,2}）', rounds[0].revision >= 1 && rounds[0].revision <= 2, {
    channel: 'C',
    expected: '1 或 2（每窗至多一条命令）',
    actual: rounds[0].revision,
  })
  ev.assert('P-5: 并发命令串行不互相覆盖（revision 逐轮单调不减、无跳变回退）', rounds.every((r, i) => (i === 0 ? r.revision >= 1 : r.revision >= rounds[i - 1].revision)), {
    channel: 'C',
    expected: '单调不减',
    actual: rounds.map((r) => r.revision).join(','),
  })
  ev.attach('a6-rejection-toast', JSON.stringify({ seen: rejectionToastSeen, note: '后发命令 revision 过期被拒时的 toast 提示（软证据：命中与否取决于并发时序）' }, null, 2))

  // ── 段 2：双窗口各新建 1 个项目 ─────────────────────────────────
  await addProjectInWindow(page1, ev, 'A6-NEW-W1', 'w1')
  await addProjectInWindow(page2, ev, 'A6-NEW-W2', 'w2')
  const bothCreated = await pollUntil(
    async () => {
      const names1 = (await page1.$$eval('[data-testid="project-group"]', (ns) => ns.map((n) => n.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? ''))).sort()
      const names2 = (await page2.$$eval('[data-testid="project-group"]', (ns) => ns.map((n) => n.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? ''))).sort()
      const has = (ns) => ns.includes('A6-NEW-W1') && ns.includes('A6-NEW-W2')
      return has(names1) && has(names2) ? { names1, names2 } : null
    },
    { timeoutMs: 30_000, intervalMs: 500, label: '双窗口新建项目收敛' },
  )
  ev.assert('P-5: 双窗口新建项目双边可见（含全部新建）', Boolean(bothCreated), {
    channel: 'A',
    expected: '两窗均含 A6-NEW-W1/W2',
    actual: JSON.stringify(bothCreated ?? null),
  })

  // ── 段 3：终态对账（磁盘权威源 + 双窗收敛） ─────────────────────
  // 落盘收敛：同段 1 注释——DOM 收敛（回执驱动）早于 WriteBackCache debounce 落盘
  // （flushMs=500，project-store.ts:113），直接读文件会读到新建前的旧状态。
  // 等文件含两条新建且 revision 为数字（不预判值，线性性留给下方断言校验）再取终态。
  const finalFile = await pollUntil(
    async () => {
      try {
        const f = readJsonFile(projectsFile)
        const names = f.projects.map((p) => p.name).filter(Boolean)
        if (names.includes('A6-NEW-W1') && names.includes('A6-NEW-W2') && typeof f.revision === 'number') return f
      } catch {
        /* 写盘中（atomicWrite tmp+rename 窗口） */
      }
      return null
    },
    { timeoutMs: 15_000, intervalMs: 200, label: '终态落盘收敛（两条新建 debounce flush）' },
  )
  const finalNames = finalFile.projects.map((p) => p.name).filter(Boolean).sort()
  const expectedFinal = [...namedProjects.map((p) => p.name).filter((n) => n !== target.name), rounds[2].convergedTo, 'A6-NEW-W1', 'A6-NEW-W2'].sort()
  ev.assert('A6: 最终 projects.json 与最后一命令一致且含全部新建（无整表互相覆盖丢数据）', JSON.stringify(finalNames) === JSON.stringify(expectedFinal), {
    channel: 'C',
    expected: expectedFinal.join(','),
    actual: finalNames.join(','),
  })
  ev.assert('A6: 终态 revision = 末轮落盘 revision + 2（两条新建各 +1，写数线性无跳变）', finalFile.revision === rounds[2].revision + 2, {
    channel: 'C',
    expected: rounds[2].revision + 2,
    actual: finalFile.revision,
  })
  ev.assert('A6: activeProjectId 指向盘内存在的项目', finalFile.projects.some((p) => p.id === finalFile.activeProjectId), {
    channel: 'C',
    expected: 'activeProjectId ∈ projects',
    actual: finalFile.activeProjectId,
  })
  const names1 = (await page1.$$eval('[data-testid="project-group"]', (ns) => ns.map((n) => n.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? ''))).sort()
  const names2 = (await page2.$$eval('[data-testid="project-group"]', (ns) => ns.map((n) => n.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? ''))).sort()
  ev.assert('P-5: 双窗口 UI 收敛到同一终态（组名清单一致）', JSON.stringify(names1) === JSON.stringify(names2), {
    channel: 'A',
    expected: names1.join(','),
    actual: names2.join(','),
  })
  await ev.shot(page1, 'a6-window1-final')
  await ev.shot(page2, 'a6-window2-final')
  ev.attach('a6-final-file', JSON.stringify({ revision: finalFile.revision, projects: finalFile.projects.map((p) => ({ id: p.id, name: p.name })), activeProjectId: finalFile.activeProjectId }, null, 2))
  ev.attach('a6-rounds', JSON.stringify(rounds, null, 2))

  if (uncovered.length === 0) log('a6: 全部断言通过')
  return { uncovered, gotchas }
}
