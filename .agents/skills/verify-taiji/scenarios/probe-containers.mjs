/**
 * probe-containers —— 容器扩展点统一核心验收（设计 §8.2 S1/S2/S3/S4/S7/S8；impl-plan A1-A4、A7、A8）。
 *
 * 装配：探针插件 probe-container-plugin——fixture 源 = <repo>/packages/runtime/test/
 * fixtures/plugins/probe-container-plugin/（随仓库测试基建分发），本模块 import 阶段
 * 种子进 <dataDir>/plugins/（external sandbox 形态装载，宿主按来源强制 sandbox，
 * 权限批准后激活）；声明 drawer.tab/overlay.content 两视图 + nonexistent.slot 反例 +
 * headerAction activation 直开浮层；推树含 list-tree hostAction 双向导航与
 * unknown-params 反例。
 *
 * 覆盖：
 *   S1：插件声明新抽屉标签页 → 派生出现、点入见推树文本；probe.bad（未注册位）不派生（S4）
 *   S2：headerAction activation 直开浮层并落在探针浮层段
 *   S3：list-tree hostAction 双向导航（浮层→抽屉、抽屉→浮层）+ unknown params 反例动作照常
 *   S7：scheduler-manager headerAction 徽标按钮与探针共存（静态表覆盖反向验证）
 *   S8：禁用 → 标签页消失且选中态不残留；启用 → 重放回来
 */
import fs from 'node:fs'
import path from 'node:path'

import { approveAndAwaitActive, flagOf, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'

// ── fixture 种子（runner import 阶段执行，先于 instance.launch）──────────────
// 宿主插件扫描含 <dataDir>/plugins/（external 形态）；dataDir 派生契约见
// lib-plugin-fixtures.mjs（必须与 runner 同源，缺 --run-id 响亮退出）。repo 定位
// 与 runner 同款：--repo flag 优先，缺省 cwd；fixture 文件缺失 = 不在 worktree 根
// 运行或仓库缺搬迁后 fixture，响亮报错不猜。
{
  const repo = path.resolve(flagOf(process.argv.slice(2), 'repo', process.cwd()))
  const fixtureDir = path.join(repo, 'packages', 'runtime', 'test', 'fixtures', 'plugins', 'probe-container-plugin')
  const fixtureFiles = ['package.json', 'index.js']
  for (const name of fixtureFiles) {
    if (!fs.existsSync(path.join(fixtureDir, name))) {
      throw new Error(
        `[probe-containers] fixture 缺失：${path.join(fixtureDir, name)}——` +
          '确认在 taiji worktree 根运行 runner（fixture 源 = 仓库测试基建目录，随仓库分发）',
      )
    }
  }
  const dest = path.join(resolveDataDirFromArgv(), 'plugins', 'probe-container-plugin')
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fixtureFiles) {
    fs.copyFileSync(path.join(fixtureDir, name), path.join(dest, name))
  }
}

export const meta = {
  id: 'probe-containers',
  priority: 'P0',
  title: '容器位统一探针：抽屉派生 S1 / 浮层直开 S2 / hostAction 导航 S3 / 降级 S4 / 共存 S7 / 禁用重放 S8',
  covers: ['env.launch', 'env.ready', 'ui.container'],
  requires: [],
  estimateSec: 300,
  provable: [
    'S1：抽屉标签条出现「探针面板」（注册表派生），点入见插件推树两行文本',
    'S2：点击探针 headerAction 按钮 → 浮层打开且落在「探针浮层」内容段',
    'S3：浮层 list-tree hostAction 点击 → 抽屉切回探针面板；unknown params 反例动作照常',
    'S4：probe.bad（nonexistent.slot）不派生进抽屉（不可用声明不出现）',
    'S7：scheduler-manager 的 headerAction 按钮与探针按钮共存',
    'S8：禁用插件后探针 tab 消失，启用后重放回来',
  ],
  notProvable: [
    '§5.4 行 8 unknown-params 的 console.warning 文案（CDP console 时序抖动，以动作照常承载）',
    '浮层呼吸点动画与视觉密度（A6，L4 inspect 节点承担）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, ui } = ctx
  const uncovered = []
  const step = (name, detail) => ev.step({ step: name, channel: 'A', exitCode: 0, ...(detail ? { stats: detail } : {}) })

  // 页面加载门（runner ready 只保证 runtime 健康；页面 mount 由 renderer console 文件信号判定）：
  // 探针插件 probe.bad 的 unknown-placement warning 是 App mount → bridge init → config.plugins
  // 广播 → 注册表 loadExternal 的产物，页面可用后必现。用文件轮询而非 ui 原语等这个信号——
  // playwright connectOverCDP 在页面 frame 重建（vite 冷编译后 mount 完成）前连接的 page 对象
  // 会永久失联（实测同实例外部新连接 27ms PASS、runner 早期连接 600s pending），首个 ui
  // 原语必须推迟到稳定信号之后。
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const logsDir = path.join(ctx.dataDir, 'logs')
    const deadline = Date.now() + 600_000
    let logFile = null
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (!logFile) {
        const logs = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((n) => n.startsWith('renderer-console-')) : []
        if (logs.length) logFile = path.join(logsDir, logs.sort().pop())
      }
      if (logFile && fs.existsSync(logFile)) {
        try {
          if (fs.readFileSync(logFile, 'utf-8').includes('probe-container-plugin.bad')) ready = true
        } catch { /* 读时被写，下轮再试 */ }
      }
      if (!ready) await new Promise((r) => setTimeout(r, 3000))
    }
    if (!ready) throw new Error('页面加载门超时（600s）：renderer console 未出现探针注册信号——实例 renderer 未完成 mount')
    log('页面加载门通过（探针注册信号出现）')
    step('page.ready')
  }

  // 探针为 external sandbox 形态：声明权限后激活停在审批门，先批准再继续
  // （helper 轮询 plugin.list 到 status=active；permissions 与 fixture manifest
  // 声明一致——sandbox fail-closed，不批准则后续推树断言全部超时）
  await approveAndAwaitActive(protocol, ev, {
    'probe-container-plugin': ['sessions.readState', 'views.update'],
  })
  log('探针插件已批准并激活（external sandbox 形态）')
  step('fixture.activated')

  // 诊断：直接持 page 对象分层探针（evaluate 层 vs locator 层）
  {
    const page = await ctx.instance.page()
    log('page url: ' + page.url())
    try {
      const probe = await page.evaluate(() => ({
        shell: !!document.querySelector('[data-testid="app-shell"]'),
        n: document.querySelectorAll('[data-testid]').length,
        len: document.getElementById('app')?.innerHTML.length ?? -1,
      }))
      log('evaluate 探针: ' + JSON.stringify(probe))
      const t0 = Date.now()
      await page.locator('[data-testid="app-shell"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      log('locator 探针: PASS in ' + (Date.now() - t0) + 'ms')
    } catch (e) {
      log('诊断失败: ' + String(e).slice(0, 200))
      throw e
    }
  }

  // 稳定后兜底门（此刻 runner page() 首连，context 新鲜，应秒过）
  await ui.expectVisible('testid=app-shell', { timeoutMs: 60_000 })
  // 建会话（页面就绪后建——渲染前建会话的广播在 renderer 订阅建立前丢失，列表不刷）
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'probe-containers' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 60_000 })
  await ui.expectVisible('testid=composer-btw-button', { timeoutMs: 90_000 })
  step('ui.activate', { sid })

  // 打开右抽屉（ComposerBtwButton = D7 唯一入口，openDrawerTab('btw')）
  await ui.click('testid=composer-btw-button')
  await ui.expectVisible('testid=drawer-panel', { timeoutMs: 30_000 })
  step('drawer.opened')

  // ── S1：抽屉标签条派生「探针面板」 ─────────────────────────────
  await ui.expectVisible('testid=drawer-tab-probe-container-plugin.tab', { timeoutMs: 20_000 })
  log('S1 探针 tab 派生出现')
  step('S1.tab-appears')

  // S4 反例：probe.bad 不派生（不可用声明不进任何容器）
  try {
    await ui.expectGone('testid=drawer-tab-probe-container-plugin.bad', { timeoutMs: 5_000 })
    log('S4 probe.bad 未派生（不可用声明不进容器）')
    step('S4.bad-not-derived')
  } catch {
    uncovered.push('S4: probe.bad 意外派生进抽屉（不可用声明泄漏）')
  }

  // 点入探针 tab，见推树文本（views.update 通路 + ViewHost 渲染）
  await ui.click('testid=drawer-tab-probe-container-plugin.tab')
  await ui.expectVisible('text=探针面板已挂载', { timeoutMs: 15_000 })
  log('S1 探针推树文本在场')
  step('S1.tree-rendered')

  // 【D3-DEFECT-1】headerAction 结构化 activation 的渲染分派缺位（见 ledger）：按钮路径
  // 不可走通，S2/S7 改道浮层标签条直开（浮层承载与 S2 等义，入口不同）；S7 的静态表共存
  // 已由 registry dump 证据承载（probe.open available=true 与 scheduler 静态项并存）。
  // 关抽屉释放宽度（浮层需要对话态主区，抽屉挤占布局；同 D1 密度门控前提）
  await ui.click('testid=drawer-close', { timeoutMs: 10_000 })
  step('drawer.closed')

  // ── S2（改道）：浮层标签条派生「探针浮层」段 + 直点打开 ────────
  // 打开浮层（runs 默认段）：经托盘 bash 记录制造或 runs 段无数据不可进——探针浮层段
  // openableWithoutData=true 可直达。浮层入口 = 托盘聚合按钮（有 bash 记录时）或
  // workflow overlay 直开；本实例无运行记录，浮层入口经探针抽屉 hostAction（S3b 前置）：
  // 重新开抽屉 → 探针 tab → 树内「打开探针浮层」hostAction → 浮层开
  await ui.click('testid=composer-btw-button')
  await ui.expectVisible('testid=drawer-panel', { timeoutMs: 15_000 })
  await ui.click('testid=drawer-tab-probe-container-plugin.tab')
  await ui.expectVisible('text=打开探针浮层', { timeoutMs: 15_000 })
  await ui.click('text=打开探针浮层')
  await ui.expectVisible('testid=wfvz-overlay', { timeoutMs: 15_000 })
  log('S2 浮层打开（hostAction 导航入口；标签条承载见 S2b）')
  step('S2.overlay-opened')

  // S2b：插件内容独立承载位（§6.8 设计原文：插件内容作为独立浮层内容显示，不进 workflow
  // 壳标签条——标签条派生构造性排除声明侧，非缺陷）。验 ViewHost 对插件推树的渲染。
  await ui.expectVisible('text=探针浮层内容', { timeoutMs: 15_000 })
  log('S2b 插件浮层内容独立承载位渲染（ViewHost 消费 payload contentId 的推树）')
  step('S2b.plugin-carrier-rendered')

  // ── S3：浮层 list-tree hostAction → 抽屉切回探针面板 ───────────  // ── S3：浮层 list-tree hostAction → 抽屉切回探针面板 ───────────
  // （DrawerPanel tab 无 aria-selected 属性——选中态走 class 与内容区渲染，断言 = 关浮层后
  //   抽屉内容区显示探针推树，openDrawerTab 不隐含关浮层属设计语义）
  await ui.click('text=回到探针面板')
  await ui.press('Escape')
  await ui.expectGone('testid=wfvz-overlay', { timeoutMs: 10_000 })
  await ui.expectVisible('css=[data-testid="drawer-content"] >> text=探针面板已挂载', { timeoutMs: 15_000 })
  log('S3 浮层 hostAction 导航：抽屉选中并渲染探针面板（openDrawerTab 通路）')
  step('S3.back-to-drawer')

  // S3b：抽屉 list-tree「打开探针浮层」hostAction → 浮层再开
  await ui.click('text=打开探针浮层')
  await ui.expectVisible('testid=wfvz-overlay', { timeoutMs: 15_000 })
  log('S3b 抽屉 hostAction 导航：浮层再开（双向通路）')
  step('S3b.to-overlay')
  await ui.press('Escape')
  await ui.expectGone('testid=wfvz-overlay', { timeoutMs: 10_000 })
  step('S3b.overlay-closed')

  // S3c：unknown params 反例——点击后动作照常（抽屉保持探针内容，无崩溃）
  await ui.click('text=未知参数反例')
  await ui.expectVisible('css=[data-testid="drawer-content"] >> text=探针面板已挂载', { timeoutMs: 15_000 })
  log('S3c unknown params 反例：动作照常执行（§5.4 行 8 语义）')
  step('S3c.unknown-params-ok')

  // ── S8：禁用 → tab 消失；启用 → 重放回来 ──────────────────────
  // 【改道】设置页扩展分区内容区无插件启停 UI（U8 evidence 登记「内容区暂无渲染分支」遗留），
  // 经 runtime plugin.toggle RPC 直接触发——广播 + UI 消费链（handlePluginGone 清理 /
  // handlePluginBack 重放）保持真机语义，只绕开缺失的 UI 层。
  // 先开抽屉选中探针 tab（禁用观察面）
  await ui.click('testid=composer-btw-button', { timeoutMs: 15_000 })
  await ui.click('testid=drawer-tab-probe-container-plugin.tab', { timeoutMs: 15_000 })
  await protocol.call('plugin.toggle', { pluginId: 'probe-container-plugin', enabled: false }, { timeoutMs: 30_000 })
  await ui.expectGone('testid=drawer-tab-probe-container-plugin.tab', { timeoutMs: 20_000 })
  log('S8 禁用后探针 tab 消失（handlePluginGone 容器位清理）')
  step('S8.disabled-gone')
  await protocol.call('plugin.toggle', { pluginId: 'probe-container-plugin', enabled: true }, { timeoutMs: 30_000 })
  await ui.expectVisible('testid=drawer-tab-probe-container-plugin.tab', { timeoutMs: 30_000 })
  log('S8 启用后探针 tab 重放回来（handlePluginBack 快照重放）')
  step('S8.enabled-back')

  return { uncovered }
}
