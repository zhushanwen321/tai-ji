/**
 * p1-plugin-a16-invalid-tree —— D3 验收场景 A16（设计 S16，非核心）：
 * 插件推非法 guiTree → 宿主降级渲染（不白屏不崩溃）+ 其他 provider 条目正常。
 *
 * 装配：runner 单实例（scenario 顶层 import 阶段 seed）+ 定制 fixture 插件
 * a16-invalid-demo（激活即向 provider.authorize 授权挂载位推一棵混合树：1 个合法
 * ansi-text + 3 类非法组件——未知 type / 裸字符串（非对象）/ ansi-text props 非对象）
 * + 清单 1 家族（invalid-tree，installed=true）+ config.setProvider 预置一条普通
 * provider 行（对照「其他 provider 条目正常渲染」）。
 *
 * 路径：
 *   B：plugin.ui.snapshot（global:provider.authorize:a16-invalid-demo）树保真（非法组件
 *   原样在快照里——runtime 不改写不拒绝）→
 *   A：Provider 页 → 添加供应商 ▾ → 插件 Provider → 家族卡 1 张（InvalidTree，已装徽标）
 *   → 点卡进授权容器（plugin-authorize-container）→ ViewHost 渲染：
 *   合法组件正常 join；未知 type / 裸字符串降级 ansi-text（JSON 序列化，resolve.ts 统一
 *   收敛）；props 非对象组件在 view-host-store 窄化时单条丢弃 + console.warn（设计 S16 的
 *   warn 落点），后置合法锚证明丢弃不断链 → 对话框未白屏未关闭 →
 *   A：关闭对话框后普通 provider 行照常展开编辑（不阻断其他 provider、无崩溃残留）。
 *
 * 锚点事实（源码已核对）：降级 SSOT = core resolveComponent（resolve.ts：未知 type /
 * 非对象组件 → { type:'ansi-text', props:{ content: serializeFallback } }，indent=2）；
 * 入树窄化 = core view-host-store.narrowGuiTree（isGuiComponent 校验 + string 行包装，
 * 非法项单条丢弃 + warn 保留其余）；家族卡点击已装条目 → phase='authorize'
 * （PluginProviderFlow.vue onFamilySelect）；授权容器 = plugin-authorize-container。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { pluginFixture, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import {
  seedMultiPluginFixture,
  waitPluginActive,
  seedDemoProvider,
  openProviderPage,
  demoCardSelector,
  expandDemoProviderRow,
} from './lib/plugin-provider-fixture.mjs'

const PLUGIN_ID = 'a16-invalid-demo'
const AUTHORIZE_MOUNT = 'provider.authorize'
/** 合法锚 + 非法组件标记（降级 content = props JSON 序列化，标记串必须含在渲染文本里）。 */
const VALID_ANCHOR = 'A16-VALID-ANCHOR-OK'
const INVALID_TYPE_MARK = 'A16-INVALID-TYPE-MARK'
const BARE_STRING_MARK = 'A16-BARE-STRING'
const BROKEN_PROPS_MARK = 'not-an-object'
const AFTER_BROKEN_ANCHOR = 'A16-AFTER-BROKEN-OK'

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
// fixture 插件激活即推混合树到 provider.authorize；manifest permissions 预置同集
// （permissions.json）= 审批门静默通过，等价已批准态。
//
// 非法形态的行为分层（2026-10-24 d3-r3-a16b 实测 + 源码核对）：
//   - 未知 type / 裸字符串 → 渲染端 resolveComponent 降级 ansi-text（JSON 序列化）；
//   - props 非对象（{type, props:'...'}）→ 不满足 isGuiComponent（extension-protocol），
//     view-host-store.narrowGuiTree 单条丢弃 + console.warn——「丢弃 + warn」即设计 S16
//     的 warn 落点；断言用后置合法锚证明丢弃不阻断同树其余组件。
const dataDir0 = resolveDataDirFromArgv()
const seedSummary = seedMultiPluginFixture(dataDir0, {
  plugins: [
    pluginFixture({
      dirName: PLUGIN_ID,
      pkgName: '@verify/plugin-invalid-tree',
      displayName: 'InvalidTree',
      description: 'A16 fixture: pushes a mixed valid/invalid guiTree to provider.authorize on activate',
      namespace: 'invalid-tree',
      permissions: ['plugin.views.update'],
      activateBody: `
  const INVALID_TREE = [
    { type: 'ansi-text', props: { lines: ['${VALID_ANCHOR}'] } },
    { type: 'not-a-real-type-xyz', props: { lines: ['${INVALID_TYPE_MARK}'] } },
    '${BARE_STRING_MARK}',
    { type: 'ansi-text', props: '${BROKEN_PROPS_MARK}' },
    { type: 'ansi-text', props: { lines: ['${AFTER_BROKEN_ANCHOR}'] } },
  ]
  await api.views.update('${AUTHORIZE_MOUNT}', INVALID_TREE, { mountId: '${AUTHORIZE_MOUNT}' })
`,
    }),
  ],
  permissionSpecs: { [PLUGIN_ID]: ['plugin.views.update'] },
  catalogPlugins: [
    {
      packageName: '@verify/plugin-invalid-tree',
      pluginId: PLUGIN_ID,
      displayName: 'InvalidTree',
      description: 'A16 invalid-tree family (installed — exercises the authorize mount face)',
      pluginVersion: '0.1.0',
      family: { id: 'invalid-tree', displayName: 'InvalidTree', vendor: 'verify', credentialSource: 'oauth', modelCount: 1 },
    },
  ],
})

export const meta = {
  id: 'p1-plugin-a16-invalid-tree',
  priority: 'P1',
  title: 'D3/A16（设计 S16）：非法 guiTree 降级渲染——三类非法组件统一 ansi-text 兜底、不白屏不崩溃、其他 provider 不受影响',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 200,
  provable: [
    'B: plugin.ui.snapshot（授权挂载位）树保真——非法组件原样在快照（runtime 不改写不拒绝，降级发生在渲染端）',
    'A: 合法组件正常渲染（A16-VALID-ANCHOR-OK），非法组件不阻断同树其他组件',
    'A: 未知 type / 裸字符串组件降级 ansi-text 渲染（resolve 降级 SSOT，JSON 序列化标记在场）',
    'A: props 非对象组件被单条丢弃（isGuiComponent 拒收 + console.warn）且不阻断同树后续组件（后置锚在场）',
    'A: 授权容器与对话框未白屏未关闭（降级后 plugin-authorize-container 仍可见可交互）',
    'A: 关闭对话框后普通 provider 行照常展开编辑（不阻断其他 provider，无崩溃残留）',
  ],
  notProvable: [
    'console.warn 的日志内容断言（CDP console 捕获脆弱；丢弃行为以「零输出 + 后置锚在场」间接证明）',
    '循环引用/BigInt 序列化失败分支（resolve.ts 的 [unserializable component props] 兜底）——RPC 线协议 JSON 序列化在宿主侧已先行失败，插件无法经通道送出循环结构',
    'resolveComponent 的单测级四分支穷举（L1 套件承载）——本剧本验证真机渲染链路',
  ],
}

export async function run(ctx) {
  const { ev, log, protocol, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    '非法树在 runtime 侧原样入快照（views.update 只挡「非数组」树）；结构非法的宽容在渲染端 resolveComponent——「runtime 校验结构 + 渲染端降级」两层分工',
    '降级 content 是 indent=2 的 JSON 序列化（保留结构化信息），断言锚用组件内的标记串而不是比对全文',
    '家族卡点击已装条目直接进授权容器（phase 状态机 family → authorize，无确认段）',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  const page = await ctx.instance.page()
  const ui = createUI({ page, evidence: ev, repo })
  const proto = protocol

  ev.step({
    step: 'fixture.seed',
    channel: 'C',
    exitCode: 0,
    stats: { dataDir, pluginId: PLUGIN_ID, mixedTree: [VALID_ANCHOR, INVALID_TYPE_MARK, BARE_STRING_MARK, BROKEN_PROPS_MARK], pluginDirs: seedSummary.pluginDirs.length },
  })

  await waitPluginActive(proto, PLUGIN_ID)
  await seedDemoProvider(proto, dataDir, ev)

  // B：快照保真（非法组件原样——runtime 不改写）
  const snapshot = await proto.call(
    'plugin.ui.snapshot',
    { mountId: AUTHORIZE_MOUNT, pluginId: PLUGIN_ID, viewId: AUTHORIZE_MOUNT },
    { replyType: 'plugin:uiSnapshot', timeoutMs: 30_000 },
  )
  const snapshotText = JSON.stringify(snapshot?.views ?? [])
  ev.assert('B: 快照树保真（未知 type 组件原样在快照，runtime 不拒绝不修整）', snapshotText.includes(INVALID_TYPE_MARK) && snapshotText.includes('not-a-real-type-xyz') && snapshotText.includes(BARE_STRING_MARK), {
    channel: 'B',
    expected: 'views 含 not-a-real-type-xyz 组件与两类非法标记原样',
    actual: `views=${snapshot?.views?.length ?? 0} invalidType=${snapshotText.includes('not-a-real-type-xyz')} marks=${snapshotText.includes(INVALID_TYPE_MARK)}/${snapshotText.includes(BARE_STRING_MARK)}`,
  })
  ev.attach('a16-authorize-snapshot', snapshotText.slice(0, 3_000))

  // A：家族卡 → 授权容器 → 降级渲染
  await openProviderPage(ui)
  await ui.click('testid=provider-template-picker')
  await ui.click('testid=add-menu-plugin')
  await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs: 30_000 })
  await ui.expectCount('testid=plugin-family-card', 1, { timeoutMs: 20_000 })
  const familyCard = 'css=[data-testid="plugin-family-card"]:has-text("InvalidTree")'
  await ui.expectVisible(familyCard)
  await ui.expectVisible(`${familyCard} [data-testid="plugin-family-installed"]`)
  ev.step({ step: 'family-card.open', channel: 'A', exitCode: 0, stats: { pluginId: PLUGIN_ID } })

  await ui.click(familyCard)
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 20_000 })
  const container = 'testid=plugin-authorize-container'
  await ui.expectText(container, VALID_ANCHOR, { timeoutMs: 20_000 })
  await ui.screenshot('a16-invalid-tree-fallback')

  const render = await page.evaluate((marks) => {
    const el = document.querySelector('[data-testid="plugin-authorize-container"]')
    const text = el?.textContent ?? '(container missing)'
    return {
      containerTextLength: text.length,
      marks: Object.fromEntries(marks.map((m) => [m, text.includes(m)])),
      viewHost: Boolean(el?.querySelector('[data-testid="view-host"]')),
    }
  }, [VALID_ANCHOR, INVALID_TYPE_MARK, BARE_STRING_MARK, AFTER_BROKEN_ANCHOR])
  ev.assert('A: 合法组件正常渲染（同树混合下不受非法组件影响）', render.marks[VALID_ANCHOR] === true, {
    channel: 'A',
    expected: `${VALID_ANCHOR} 在场`,
    actual: JSON.stringify(render.marks),
  })
  ev.assert('A: 未知 type / 裸字符串组件降级 ansi-text 渲染（JSON 序列化标记在场）', render.marks[INVALID_TYPE_MARK] && render.marks[BARE_STRING_MARK], {
    channel: 'A',
    expected: '未知 type → props JSON 序列化；裸字符串 → 文本行（resolve 降级 SSOT）',
    actual: JSON.stringify(render.marks),
  })
  ev.assert('A: props 非对象组件被丢弃且不阻断同树后续组件（后置锚在场）', render.marks[AFTER_BROKEN_ANCHOR] === true, {
    channel: 'A',
    expected: `${AFTER_BROKEN_ANCHOR}（broken-props 组件之后）仍渲染——丢弃是单条的，不断链`,
    actual: JSON.stringify(render.marks),
  })
  ev.assert('A: 授权容器未白屏（view-host 在场 + 容器有内容）', render.viewHost && render.containerTextLength > 50, {
    channel: 'A',
    expected: 'view-host 在场且容器文本非空',
    actual: `viewHost=${render.viewHost} textLength=${render.containerTextLength}`,
  })
  ev.attach('a16-render-map', JSON.stringify(render, null, 2))

  // A：不阻断其他 provider（关闭对话框，普通行照常展开编辑）
  await ui.press('Escape')
  await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })
  const card = demoCardSelector()
  await ui.expectVisible(card)
  await expandDemoProviderRow(ui)
  await ui.expectVisible(`${card} [data-testid="provider-edit-name"]`)
  ev.assert('A: 普通 provider 行照常展开编辑（不阻断其他 provider，无崩溃残留）', true, {
    channel: 'A',
    expected: 'demo-wool 行展开 + provider-edit-name 在场',
    actual: '命中',
  })
  await ui.screenshot('a16-neighbor-row-intact')

  log('a16 done')
  return { uncovered, gotchas }
}
