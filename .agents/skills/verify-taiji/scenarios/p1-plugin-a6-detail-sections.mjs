/**
 * p1-plugin-a6-detail-sections —— D3 验收场景 A6（设计 S6）：条目两区 DOM 边界。
 *
 * 装配：自建隔离实例 + demo fixture 插件（激活即向 provider.detail-extra 推演示树，
 * 哨兵串 DEMO-EXTRA-SENTINEL-7Q）+ config.setProvider 预置 demo-wool 条目。
 *
 * 路径：
 *   展开 demo 条目 → 唯一的 provider-detail-extra-boundary（宿主区/插件区分界，宿主分区
 *   标题「插件内容」）→ 边界内 view-host 渲染插件树（哨兵串命中）→ DOM 结构断言：
 *   ① 宿主字段（provider-edit-name / provider-models-editable）不在边界内（无字段重叠·上）；
 *   ② 插件哨兵串全展开体唯一且位于边界内（插件内容不溢出到宿主区，无字段重叠·下）；
 *   ③ B：plugin.ui.snapshot（global:provider.detail-extra:demo-wool）返回插件树
 *   （ADR-0155 拉为主的第二视角——runtime 快照与渲染同源）。
 *
 * 锚点事实（源码已核对）：边界容器 = ProviderRowCard.vue 的 provider-detail-extra-boundary
 * （宿主分区标题 + ViewHost(empty="hidden")）；展开时 watch 触发 refreshViewInScope 主动拉取；
 * 快照请求帧 = plugin.ui.snapshot { mountId, pluginId, viewId }，reply = plugin:uiSnapshot。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  launchFixtureInstance,
  waitPluginActive,
  seedDemoProvider,
  openProviderPage,
  demoCardSelector,
  expandDemoProviderRow,
  DEMO_PLUGIN_ID,
  DEMO_PROVIDER_ID,
  DEMO_ROW_NAME,
  DETAIL_EXTRA_MOUNT,
  DETAIL_SENTINEL,
} from './lib/plugin-provider-fixture.mjs'

export const meta = {
  id: 'p1-plugin-a6-detail-sections',
  priority: 'P1',
  title: 'D3/A6（设计 S6）：条目两区边界——宿主区（上）与 detail-extra 插件渲染区（下）无字段重叠',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 200,
  provable: [
    'A: 展开 demo 条目出现唯一 provider-detail-extra-boundary，宿主分区标题「插件内容」在场',
    'A: 边界内 view-host 渲染插件树（哨兵串 DEMO-EXTRA-SENTINEL-7Q 命中）——插件推树 → 拉取 → 渲染链路通',
    'A: 宿主字段不进插件区：provider-edit-name / provider-models-editable 均不在边界子树内',
    'A: 插件内容不溢出宿主区：哨兵串在展开体内唯一出现且位于边界子树内',
    'B: plugin.ui.snapshot（global scope）返回 detail-extra 树（含哨兵串）——快照与渲染同源第二视角',
  ],
  notProvable: [
    '羊毛真实数据字段（消耗系数/额度占用为设计形态示意——两区边界是断言对象，具体字段不是，设计 §3.1 样例注）',
    'S25 同挂载位多插件隔离（需要两个插件交替推树，另行覆盖）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    'detail-extra 挂载位 ViewHost 为 empty="hidden"（无树零 DOM）——哨兵串出现 = 插件树真实到达渲染端，不是占位',
    '展开动作触发 ProviderRowCard 的 refreshViewInScope 主动拉取（ADR-0155 拉为主）；插件激活期推送发生在 renderer 连接前也不丢（runtime 快照兜底）',
    '「无字段重叠」的断言口径 = 双向：宿主 testid 不在边界子树内 + 插件哨兵串不越出边界子树',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  let instance = null
  let proto = null
  try {
    const fixture = await launchFixtureInstance({ repo, ev, tag: 'a6' })
    instance = fixture.instance
    proto = fixture.proto
    const ui = createUI({ page: await instance.page(), evidence: ev, repo })
    const page = await instance.page()

    await waitPluginActive(proto, DEMO_PLUGIN_ID)
    await seedDemoProvider(proto, fixture.dataDir, ev)

    // A：展开 → 边界 + 插件树
    await openProviderPage(ui)
    const card = demoCardSelector()
    await ui.expectVisible(`${card} [data-testid="provider-plugin-badge"]`)
    await expandDemoProviderRow(ui)
    const boundary = `${card} [data-testid="provider-detail-extra-boundary"]`
    await ui.expectVisible(boundary)
    // 宿主分区标题（插件内容）+ 插件树哨兵（拉取到达渲染端）
    await ui.expectText(boundary, '插件内容', { timeoutMs: 10_000 })
    await ui.expectText(boundary, DETAIL_SENTINEL, { timeoutMs: 20_000 })
    await ui.screenshot('a6-detail-sections')

    // DOM 结构断言（双向无重叠）
    const structure = await page.evaluate(({ name, sentinel }) => {
      const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')]
        .find((el) => el.textContent?.includes(name))
      if (!cardEl) return { error: 'card not found' }
      const expandBody = cardEl.querySelector('[data-testid="provider-expand-body"]')
      const boundaries = cardEl.querySelectorAll('[data-testid="provider-detail-extra-boundary"]')
      const boundaryEl = boundaries[0]
      const hostAnchors = ['provider-edit-name', 'provider-models-editable', 'provider-edit-apikey', 'headers-editor']
      const hostInBoundary = Object.fromEntries(
        hostAnchors.map((id) => [id, Boolean(boundaryEl?.querySelector(`[data-testid="${id}"]`))]),
      )
      const expandText = expandBody?.textContent ?? ''
      const sentinelCount = expandText.split(sentinel).length - 1
      const sentinelInBoundary = Boolean(boundaryEl?.textContent?.includes(sentinel))
      return {
        boundaryCount: boundaries.length,
        boundaryHasViewHost: Boolean(boundaryEl?.querySelector('[data-testid="view-host"]')),
        hostInBoundary,
        sentinelCount,
        sentinelInBoundary,
        expandBodyExists: Boolean(expandBody),
      }
    }, { name: DEMO_ROW_NAME, sentinel: DETAIL_SENTINEL })

    ev.assert('A: provider-detail-extra-boundary 唯一', structure.boundaryCount === 1, {
      channel: 'A',
      expected: 1,
      actual: structure.boundaryCount,
    })
    ev.assert('A: 边界内 view-host 渲染插件树（哨兵命中）', structure.boundaryHasViewHost && structure.sentinelInBoundary, {
      channel: 'A',
      expected: `view-host 在场且含 ${DETAIL_SENTINEL}`,
      actual: JSON.stringify({ viewHost: structure.boundaryHasViewHost, sentinelInBoundary: structure.sentinelInBoundary }),
    })
    ev.assert('A: 宿主字段不进插件区（无字段重叠·上）', Object.values(structure.hostInBoundary).every((v) => v === false), {
      channel: 'A',
      expected: 'provider-edit-name / provider-models-editable / provider-edit-apikey / headers-editor 均不在边界内',
      actual: JSON.stringify(structure.hostInBoundary),
    })
    ev.assert('A: 插件内容不溢出宿主区（无字段重叠·下）', structure.sentinelCount === 1 && structure.sentinelInBoundary, {
      channel: 'A',
      expected: '哨兵串在展开体唯一出现且位于边界内',
      actual: `sentinelCount=${structure.sentinelCount} inBoundary=${structure.sentinelInBoundary}`,
    })
    ev.attach('a6-structure', JSON.stringify(structure, null, 2))

    // B：runtime 快照第二视角（拉为主的权威源）
    const snapshot = await proto.call(
      'plugin.ui.snapshot',
      { mountId: DETAIL_EXTRA_MOUNT, pluginId: DEMO_PLUGIN_ID, viewId: DETAIL_EXTRA_MOUNT },
      { replyType: 'plugin:uiSnapshot', timeoutMs: 30_000 },
    )
    const snapshotText = JSON.stringify(snapshot?.views ?? [])
    ev.assert('B: plugin.ui.snapshot 返回 detail-extra 树（含哨兵串，与渲染同源）', snapshotText.includes(DETAIL_SENTINEL), {
      channel: 'B',
      expected: `views 含 ${DETAIL_EXTRA_MOUNT} 树（哨兵串在场）`,
      actual: `views=${snapshot?.views?.length ?? 0} 哨兵=${snapshotText.includes(DETAIL_SENTINEL)}`,
    })
    ev.attach('a6-ui-snapshot', JSON.stringify(snapshot, null, 2).slice(0, 4_000))

    log('a6 done')
  } finally {
    try {
      await proto?.close()
    } catch { /* ignore */ }
    if (instance) {
      await instance.dispose()
      try {
        fs.rmSync(instance.dataDir, { recursive: true, force: true })
      } catch { /* 清理失败由证据目录暴露 */ }
    }
  }
  return { uncovered, gotchas }
}
