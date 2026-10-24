#!/usr/bin/env node
/**
 * p1-btw-coldline-model-memory —— btw 冷线模型记忆 + 一个会话一个键全链走查 + 冷读零 spawn。
 *
 * 覆盖：会话架构四层分离设计 §7 项 1 真机段（btw 冷线显示自己创建时的模型，重启后仍成立）、
 * §7 项 9 W4a 全链走查（线的唯一标识恒为 pi 真实会话 id，无第二套 id）、§4 真机验收行。
 * 来源：dev-flow D3 真机验收剧本（A11 节点，session-identity-visibility-state 设计包），
 * 实跑 51/51 断言通过后按 compile.md「new 态」提升入场景库复用。
 *
 * 三条断言：
 *   1. btw 冷线模型记忆（§7 项 1 真机段）：主会话模型 A 发一条消息等回复 → 切 B → 撤回该消息
 *      （活跃叶子落回 A 侧）→ 建 btw 线（fork 全树含被撤分支）→ 主会话切 C/D → 打开冷线 →
 *      线显示 A（读线自身会话文件，不是主会话当前值）→ 重启应用后再开线仍显示 A →
 *      主会话再切后线仍显示 A。
 *   2. 一个会话一个键全链走查（W4a）：UI 可见标识与内部状态（CDP 可观测的 WS 网络帧 +
 *      pinia store）中，线的唯一标识恒为同一 pi 真实会话 id；无 btw: 前缀、无 vid 残留；
 *      切走切回、删除线后再建，键形态不变。
 *   3. 冷读零 spawn 佐证：打开冷线过程中 runtime 无新的 pi 子进程 spawn（进程表 / tee 树 /
 *      spawn-markers / runtime 日志四路佐证）。
 *
 * 装配：faux（零 token）。四演员 A=faux-1 / B=faux-1-b / C=faux-1-c / D=faux-1-reasoning。
 * 重启段：同 dataDir dispose → relaunch（reuse p0-session-persistence 的重启机制）。
 *
 * 与 §10.1 字面序列的一处受控差异（继承 A1 离线 fixture 的同一处置，W2 runlog 已登记待裁决）：
 * 撤回 user 消息后活跃路径上不含任何模型记录（assistant 条目随 user 一并离开活跃路径），
 * 故先做一次 B→A 显式切换把 `model_change A` 落到 trunk 上——A1 的离线等价 fixture 正是
 * 这样放显式 model_change A（「该断言成立的唯一支撑点」）。真实序列其余步骤逐字不变。
 *
 * 引擎调样（dev-flow wrapper 形态）：
 *   node .agents/skills/verify-taiji/scripts/run.mjs <本文件> \
 *     --artifacts-dir <A11 dir> --run-id <runId> --name verify-<runId> --repo <repo>
 *
 * ── r7 修正记录（相对 a11-item1-real-machine.mjs 原版；原版保留不动以便对账）────────
 * 原版（a11r6 及以前使用）有一处结构性缺陷：Phase 4e「删除线后再建」排在 Phase 5 重启 leg
 * **之前**，重启后仅存的重建线创建时模型 = D（主会话切 D 后重建），而重启 leg 的三条显示 /
 * 冷读断言期望 A。按任务书语义（「线显示自己创建时的模型值」）正确实现必然对该线返回 D，
 * 原版断言会把正确行为判成 FAIL；且冷开样本点主/线同为 D，「线读自身文件 vs 线跟随主会话
 * 当前值」失去判别力（正是本验收要抓的缺陷形态）。
 * r7 修正 = 三处，均不弱化任何断言：
 *   ① 重启 leg 改为对**线 1**（创建时模型 A，主会话已切 C/D，样本点主 D ≠ 线 A，判别力满格）
 *      断言 A——与任务书 §4 真机验收行「开创建时模型不同的 btw 线 → 重启 → 仍显示自己的值」
 *      的构造意图逐字一致；
 *   ② Phase 4e（btw.remove + 再建）整体移到重启 leg 之后（W4a 键形态断言集合不变，反而多
 *      覆盖「重启后再建」形态）；再建线期望值随主会话当时模型改为 B（重启 leg 末步主会话
 *      已切 B），其 getState 期望 = faux/faux-1-b（该线自己的创建时模型）；
 *   ③ 重启后激活探针增加 pinia panel store focusedSessionId 信号（修上一轮 driver 探针
 *      误 FAIL：panel-session-file 按钮在 sessionFile 未就绪时段不渲染，单信号探针把已激活
 *      判成未激活）。双信号任一命中即激活，两个信号都落证据。
 *   ④ （a11r7 后追加）激活探针由「单击后单次读」改为轮询收敛：a11r7 实测探针路径本身
 *      正常（同轮 cold-open pinia 探针 ok=true），但应用聚焦收敛（自动恢复 / 点选链完成）
 *      晚于 1500ms 单次读窗口，focusedSessionId 尚为 null——改为先等自动恢复窗口、再逐行
 *      点选并轮询（与剧本其余等待纪律一致：等状态出现，禁单次定时读）。断言意图不变。
 */

/** WS 帧钩子（renderer 侧注入）：记录 renderer ↔ runtime 全部 WS 帧（网络帧通道证据）。 */
const WS_HOOK = `(() => {
  const frames = []
  window.__wsFrames = frames
  const OrigWS = window.WebSocket
  if (!OrigWS) return
  class WrappedWS extends OrigWS {
    constructor(...args) {
      super(...args)
      this.addEventListener('open', () => frames.push({ dir: 'open', url: String(args[0]), t: Date.now() }))
      this.addEventListener('message', (e) => {
        if (frames.length < 12000) frames.push({ dir: 'in', data: String(e.data).slice(0, 1500), t: Date.now() })
      })
      const orig = this.send.bind(this)
      this.send = (data) => {
        if (frames.length < 12000) frames.push({ dir: 'out', data: String(data).slice(0, 1500), t: Date.now() })
        return orig(data)
      }
    }
  }
  window.WebSocket = WrappedWS
})()`

/** 四演员（seed-faux.mjs 写入 models.json 的确定性演员；name 为 UI 展示名）。 */
const MODELS = {
  A: { id: 'faux-1', wire: 'faux/faux-1', name: 'Faux 1 (reasoning off)' },
  B: { id: 'faux-1-b', wire: 'faux/faux-1-b', name: 'Faux 1 B (slot actor)' },
  C: { id: 'faux-1-c', wire: 'faux/faux-1-c', name: 'Faux 1 C (slot actor)' },
  D: { id: 'faux-1-reasoning', wire: 'faux/faux-1-reasoning', name: 'Faux 1 Reasoning (reasoning on)' },
}

/** pi 真实会话 id 形态（isPiSessionId 同域：禁 ':'）。 */
const PI_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const meta = {
  id: 'p1-btw-coldline-model-memory',
  priority: 'P0',
  title: 'btw 冷线模型记忆（§7 项 1 真机段）+ 一个会话一个键全链走查（W4a）+ 冷读零 spawn 佐证',
  covers: [
    'env.launch', 'env.ready', 'env.isolation', 'env.cleanup',
    'session.create', 'session.switch', 'session.list', 'session.delete',
    'model.switch', 'chat.send', 'chat.wait',
    'workspace.drawer',
    'evidence.logs', 'evidence.tree', 'evidence.screenshot',
  ],
  requires: ['faux'],
  estimateSec: 600,
  // 统一数组队列（非 model-keyed）：faux 选队按进程 argv --model 一次定型，热切模型不重选队，
  // 切换前后轮必须同队顺序消费（model.md Gotcha 8）。自动标题已由 instance.mjs 解除装配。
  faux: {
    responses: [
      { text: 'a11-main-turn-1-reply', stopReason: 'stop' },
      { text: 'a11-spare-reply', stopReason: 'stop' },
      { text: 'a11-line-diag-reply', stopReason: 'stop' },
    ],
  },
  provable: [
    '§10.1 六步序列构造（A 发消息等回复 → 切 B → 撤回 → 建线 → 切 C/D；model_change A 落 trunk）',
    '打开冷线：线 composer 显示自己创建时的模型值 A（非主会话当前值）',
    '重启应用后再开冷线仍显示 A',
    '主会话再切换后线仍显示 A',
    '协议侧 session.getState 对（冷）线返回 A（W2 冷读零 spawn 同入口）',
    'UI 可见标识与内部状态（WS 帧 + pinia store）中线的唯一标识恒为同一 pi 真实会话 id',
    '无 btw: 前缀形态、无 vid 字段残留（DOM + 全部 WS 帧）',
    '切走切回、删除线后再建，键形态不变',
    '打开冷线过程零 pi spawn（进程表 / tee 树 / spawn-markers / runtime 日志四路）',
  ],
  notProvable: [
    '「线真的在用模型 A 跑」的最终证据 responseModel：faux 回复与模型无绑定（model.md 证不了）',
    'btw 线 composer 的密度聚合态细节（窄宽下降级为单图标聚合钮）——本剧本两条读取路径都覆盖',
  ],
}

export async function run(ctx) {
  const { ev, log, repo, instance, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'faux 选队按进程 argv --model 一次定型：统一数组队列，切换模型后同队顺序消费（model.md Gotcha 8）',
    'pi 会话 JSONL 延迟写入：建线前主会话必须先发一轮消息落盘（§10.1 第 1 步不可省）',
    '协议建的 session 不改变 renderer 激活态：A 通道断言前必须点侧栏会话行激活（session.md）',
    '§10.1 字面机制下撤回后活跃路径不含模型记录（assistant 随 user 离开路径）——本剧本按 A1 离线 fixture 同一处置先落 model_change A 到 trunk（W2 runlog 待裁决项）',
    'Escape 会关 drawer：切模型的浮层关闭不用 Escape 盲按，改用「浮层仍在才关 + 读线视图前确保 drawer 开着」',
    '冷读结论成立范围 = ≤32MB 线文件（§10.1 已知退化）；本剧本 fixture 远小于该阈值',
  ]

  // ── 工具 ────────────────────────────────────────────────────────
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const skillLib = path.join(repo, '.agents', 'skills', 'verify-taiji', 'scripts', 'lib')
  const { createInstance } = await import(pathToFileURL(path.join(skillLib, 'instance.mjs')).href)
  const { createUI } = await import(pathToFileURL(path.join(skillLib, 'ui.mjs')).href)

  let proto = ctx.protocol
  let ui = ctx.ui
  let page = await instance.page()

  const assert = (name, ok, detail) => ev.assert(name, ok, detail)
  const attach = (name, data) => {
    try {
      ev.attach(name, typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, 60_000))
    } catch { /* attach 失败不阻断 */ }
  }

  /** 读某作用域内 composer 的模型显示（展开态 = popover 触发器文本；聚合态 = 弹层选中行）。 */
  async function readModelChip(scopeSel) {
    const trig = page.locator(`${scopeSel} [title="切换模型"]`)
    if ((await trig.count()) > 0) {
      const text = ((await trig.first().textContent()) ?? '').trim()
      return { form: 'popover-trigger', text }
    }
    const agg = page.locator(`${scopeSel} [data-testid="composer-model-thinking-aggregate"]`)
    if ((await agg.count()) > 0) {
      // 聚合态：开弹层读选中行。composer 可能在线列表重拉后重渲染（元素 detach），点击带重试。
      let sel = null
      for (let attempt = 0; attempt < 3 && !sel; attempt++) {
        try {
          await agg.first().click({ timeout: 8_000 })
          sel = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('[data-testid^="model-picker-item-"]'))
            for (const r of rows) {
              const check = r.querySelector('svg.opacity-100')
              if (check) return { testid: r.getAttribute('data-testid'), text: (r.textContent ?? '').trim() }
            }
            return null
          })
        } catch {
          await new Promise((r) => setTimeout(r, 1200))
        }
      }
      // 关弹层：点面板左上角空白（Escape 会连 drawer 一起关，禁用）
      await page.locator('[data-testid="drawer-btw-tab"]').click({ position: { x: 4, y: 4 }, timeout: 5_000 }).catch(() => {})
      return { form: 'aggregate-popover', text: sel?.text ?? '', testid: sel?.testid ?? null }    }
    return { form: 'none', text: '' }
  }

  /** 轮询等待某作用域 composer 显示目标模型名。 */
  async function waitForChip(scopeSel, expectedName, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await readModelChip(scopeSel)
      if (last.text.includes(expectedName)) return last
      await new Promise((r) => setTimeout(r, 700))
    }
    return last
  }

  /** UI 切模型：开模型选择器 → 点目标行 → 浮层若仍在才关（Escape 会关 drawer，禁盲按）。 */
  async function switchModelUI(scopeSel, model) {
    const trig = page.locator(`${scopeSel} [title="切换模型"]`)
    if ((await trig.count()) > 0) {
      await trig.first().click({ timeout: 10_000 })
    } else {
      const agg = page.locator(`${scopeSel} [data-testid="composer-model-thinking-aggregate"]`)
      if ((await agg.count()) === 0) throw new Error(`作用域 ${scopeSel} 内无模型触发器`)
      await agg.first().click({ timeout: 10_000 })
    }
    await ui.expectVisible(`testid=model-picker-item-${model.id}`, { timeoutMs: 15_000 })
    await ui.click(`testid=model-picker-item-${model.id}`, { timeoutMs: 15_000 })
    // 浮层点了行不一定自关；仅在仍可见时按 Escape 关（Escape 副作用 = 关 drawer，故先判）
    const panelOpen = (await page.locator('[data-testid="model-picker-panel"]').count()) > 0
    if (panelOpen) await page.keyboard.press('Escape')
  }

  /** 确保线视图开着：drawer 开 + btw tab + 有线条目且选中（返回是否成功）。 */
  async function ensureLineViewOpen() {
    if ((await page.locator('[data-testid="drawer-btw-tab"]').count()) === 0) {
      await ui.click('testid=composer-btw-button', { timeoutMs: 20_000 })
    }
    await ui.expectVisible('testid=drawer-btw-tab', { timeoutMs: 20_000 })
    if ((await page.locator('[data-testid="btw-thread-chip"]').count()) === 0) return false
    const chip = page.locator('[data-testid="btw-thread-chip"]').first()
    const selected = await chip.getAttribute('aria-pressed')
    if (selected !== 'true') await chip.click({ timeoutMs: 15_000 }).catch(() => {})
    await ui.expectVisible('testid=btw-composer', { timeoutMs: 20_000 })
    await new Promise((r) => setTimeout(r, 1500)) // 等线列表重拉/重渲染收敛（composer 可能重挂）
    return true
  }

  /** 协议侧生效值核验：条件轮询重订阅读 stateSnapshot 的 state_changed（model.md 确定性收敛路径）。 */
  async function pollStateModel(sid, expectedWire, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs
    let entry = null
    while (Date.now() < deadline) {
      const sub = await proto.call('session.subscribe', { sessionId: sid }, { timeoutMs: 20_000 })
      entry = (sub.stateSnapshot ?? []).find((s) => s?.type === 'session.state_changed') ?? null
      if (entry?.payload?.modelId === expectedWire) return entry
      await new Promise((r) => setTimeout(r, 600))
    }
    return entry
  }

  /** 读 pi 会话 JSONL 的结构证据：entry 类型链 + 活跃路径（leaf 回溯）+ 活跃路径/物理尾的 model_change。 */
  function inspectJsonl(file) {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const byId = new Map(lines.map((l) => [l.id, l]))
    const leaf = lines[lines.length - 1]
    const activePath = []
    const seen = new Set()
    let cur = leaf
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      activePath.push(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : null
    }
    const modelOf = (e) => (e?.type === 'model_change' ? `${e.provider}/${e.modelId}` : null)
    const activePathModels = activePath.map(modelOf).filter(Boolean)
    const physicalTailModels = [...lines].reverse().map(modelOf).filter(Boolean)
    return {
      file: path.basename(file),
      headerId: lines[0]?.id ?? null,
      entryCount: lines.length,
      types: lines.map((l) => l.type),
      leafType: leaf?.type ?? null,
      leafParentId: leaf?.parentId ?? null,
      activePathLen: activePath.length,
      activePathModels,
      firstModelChangeFromLeaf: activePathModels[0] ?? null,
      physicalTailModels,
      physicalTailFirst: physicalTailModels[0] ?? null,
    }
  }

  /** spawn 见证四路快照。 */
  async function spawnWitness(tag) {
    const markers = path.join(dataDir, 'run', 'pi-spawn-markers.json')
    let markersInfo = { exists: false }
    try {
      const st = fs.statSync(markers)
      const content = fs.readFileSync(markers, 'utf8')
      markersInfo = { exists: true, mtimeMs: st.mtimeMs, size: st.size, hash: `${content.length}:${content.slice(0, 64)}` }
    } catch { /* 不存在即零 spawn 见证的起点 */ }
    const teeFiles = []
    const root = path.join(dataDir, 'ext-sessions')
    try {
      for (const d of fs.readdirSync(root)) {
        const logsDir = path.join(root, d, 'logs')
        try {
          for (const f of fs.readdirSync(logsDir)) {
            if (/^pi-.*\.jsonl/.test(f)) {
              const st = fs.statSync(path.join(logsDir, f))
              teeFiles.push({ sid: d, file: f, mtimeMs: st.mtimeMs, size: st.size })
            }
          }
        } catch { /* 无 logs 子目录 */ }
      }
    } catch { /* 无 ext-sessions */ }
    const { spawnSync } = await import('node:child_process')
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const piProcs = (ps.stdout ?? '').split('\n').filter((l) => /--mode\s+rpc|mode=rpc/.test(l)).map((l) => l.trim().slice(0, 220))
    const runtimeLogs = []
    try {
      for (const f of fs.readdirSync(path.join(dataDir, 'logs'))) {
        if (/^runtime-.*\.log$/.test(f)) {
          const p = path.join(dataDir, 'logs', f)
          const st = fs.statSync(p)
          const text = fs.readFileSync(p, 'utf8')
          const lines = text.split('\n')
          runtimeLogs.push({
            file: f,
            size: st.size,
            mtimeMs: st.mtimeMs,
            lineCount: lines.length,
            // 窗口比对用：末 40 行哈希（spawn 行若落在窗口内必改变它）
            tailHash: `${lines.length}:${lines.slice(-40).join('\n').length}`,
            spawnLines: lines.filter((l) => /spawning pi|pi-respawn|spawn-markers/i.test(l)).length,
          })
        }
      }
    } catch { /* 无 logs 目录 */ }
    return { tag, at: new Date().toISOString(), markers: markersInfo, teeFiles, piProcs, runtimeLogs }
  }

  /** 读 WS 帧（renderer 侧 window.__wsFrames）。 */
  async function readFrames() {
    return page.evaluate(() => (Array.isArray(window.__wsFrames) ? window.__wsFrames : []))
  }

  /** pinia store 探针（CDP 可观测的内部状态）。 */
  async function piniaProbe(sid) {
    return page.evaluate((sessionId) => {
      const el = document.querySelector('#app')
      const app = el && el.__vue_app__
      const pinia = app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia
      if (!pinia) return { ok: false, reason: 'no $pinia on app instance' }
      const stores = pinia._s ? Array.from(pinia._s.keys()) : []
      const out = { ok: true, stores, liveState: null, chatPartition: null }
      const live = pinia._s && pinia._s.get('session-live-state')
      if (live && typeof live.liveStateOf === 'function') out.liveState = live.liveStateOf(sessionId) ?? null
      const chat = pinia._s && pinia._s.get('chat')
      if (chat && typeof chat.getMessages === 'function') {
        try {
          const msgs = chat.getMessages(sessionId)
          out.chatPartition = { hydrated: typeof chat.isHydrated === 'function' ? chat.isHydrated(sessionId) : null, count: Array.isArray(msgs) ? msgs.length : null }
        } catch (e) { out.chatPartition = { error: String(e).slice(0, 200) } }
      }
      return out
    }, sid)
  }

  /** 线 composer 的 DOM 细项（显示面取证：触发器/testid/文本）。 */
  async function dumpLineComposer() {
    return page.evaluate(() => {
      const root = document.querySelector('[data-testid="drawer-btw-tab"]')
      if (!root) return { present: false }
      const composer = root.querySelector('[data-testid="btw-composer"]') ?? root.querySelector('.composer-bar')
      const items = []
      if (composer) {
        for (const el of Array.from(composer.querySelectorAll('[data-testid],[title]'))) {
          items.push({
            testid: el.getAttribute('data-testid'),
            title: el.getAttribute('title'),
            text: (el.textContent ?? '').trim().slice(0, 60),
          })
        }
      }
      return { present: true, composerFound: Boolean(composer), items: items.slice(0, 40) }
    })
  }

  // ══════════════════════════════════════════════════════════════
  // Phase 0 — 注入 WS 帧钩子 + reload（网络帧通道就绪）
  // ══════════════════════════════════════════════════════════════
  await page.addInitScript(WS_HOOK)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 2500)) // reload 后 bootstrap 重跑，等连接稳定
  ev.step({ step: 'env.reload-with-ws-hook', channel: 'C', exitCode: 0, stats: { url: page.url() } })
  log('phase0: WS hook installed + renderer reloaded')

  // ══════════════════════════════════════════════════════════════
  // Phase 1 — 建主会话（模型 A = faux/faux-1 默认演员）+ UI 激活
  // ══════════════════════════════════════════════════════════════
  const created = await proto.call('session.create', { cwd: repo, label: 'a11-main' }, { timeoutMs: 120_000 })
  const mainSid = created.session?.id
  assert('B: session.create 返回 pi 会话 id 形态（SessionSummary 自 W3 起不带 modelId，模型值走 UI/状态通道核验）',
    Boolean(mainSid) && PI_ID_RE.test(mainSid) && !String(mainSid).includes(':') && created.session?.label === 'a11-main', {
      channel: 'B', expected: 'sid 为 pi id 形态、label=a11-main', actual: `sid=${mainSid} label=${created.session?.label}`,
    })
  attach('session-create', { sid: mainSid, label: created.session?.label, keys: Object.keys(created.session ?? {}) })

  await ui.expectVisible('css=.session-item', { timeoutMs: 30_000 })
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  await ui.expectVisible('testid=composer-box', { timeoutMs: 30_000 })
  const mainChip0 = await waitForChip('css=[data-testid="main-area"]', MODELS.A.name)
  assert('A: 主会话 composer 显示模型 A（Faux 1 (reasoning off)）', mainChip0.text.includes(MODELS.A.name), {
    channel: 'A', expected: `含 ${MODELS.A.name}`, actual: JSON.stringify(mainChip0),
  })
  ev.step({ step: 'session.activate.ui', channel: 'A', exitCode: 0, stats: { sid: mainSid, chip: mainChip0 } })
  await ev.shot(page, 'phase1-main-on-A')

  // ── fixture 物料化：B→A 显式切换把 model_change A 落到 trunk（A1 离线 fixture 同一处置）──
  await switchModelUI('css=[data-testid="main-area"]', MODELS.B)
  const chipAfterB = await waitForChip('css=[data-testid="main-area"]', MODELS.B.name)
  assert('A: 物料化切换①主会话显示 B', chipAfterB.text.includes(MODELS.B.name), {
    channel: 'A', expected: `含 ${MODELS.B.name}`, actual: JSON.stringify(chipAfterB),
  })
  await switchModelUI('css=[data-testid="main-area"]', MODELS.A)
  const chipBackA = await waitForChip('css=[data-testid="main-area"]', MODELS.A.name)
  assert('A: 物料化切换②主会话显示 A（model_change A 已落 trunk）', chipBackA.text.includes(MODELS.A.name), {
    channel: 'A', expected: `含 ${MODELS.A.name}`, actual: JSON.stringify(chipBackA),
  })
  const stateA = await pollStateModel(mainSid, MODELS.A.wire)
  assert('B: stateSnapshot 生效值回落到 faux/faux-1（A）', stateA?.payload?.modelId === MODELS.A.wire, {
    channel: 'B', expected: MODELS.A.wire, actual: JSON.stringify(stateA?.payload ?? null).slice(0, 300),
  })

  // §10.1 第 1 步：主会话在模型 A 发一条用户消息并等回复（无文件即无 fork 源）
  await proto.subscribe(mainSid)
  const since1 = proto.events.length
  await proto.send(mainSid, 'a11-turn1-user-message')
  const end1 = await proto.waitTurnEnd(mainSid, { since: since1, timeoutMs: 180_000 })
  assert('B: 主会话第一轮完成（message.complete，落盘条件满足）', end1.type === 'message.complete' && end1.ok, {
    channel: 'B', expected: 'message.complete 非 error', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
  })
  ev.step({ step: 'chat.send.turn1', channel: 'B', exitCode: end1.ok ? 0 : 1, stats: {} })

  // ══════════════════════════════════════════════════════════════
  // Phase 2 — §10.1 六步：切 B → 撤回 → 建 btw 线
  // ══════════════════════════════════════════════════════════════
  await switchModelUI('css=[data-testid="main-area"]', MODELS.B)
  const mainChipB = await waitForChip('css=[data-testid="main-area"]', MODELS.B.name)
  assert('A: 主会话 composer 切到模型 B（Faux 1 B (slot actor)）', mainChipB.text.includes(MODELS.B.name), {
    channel: 'A', expected: `含 ${MODELS.B.name}`, actual: JSON.stringify(mainChipB),
  })
  const stateB = await pollStateModel(mainSid, MODELS.B.wire)
  assert('B: stateSnapshot state_changed 生效值 = faux/faux-1-b（UI 切换真值核验）',
    stateB?.payload?.modelId === MODELS.B.wire, {
      channel: 'B', expected: MODELS.B.wire, actual: JSON.stringify(stateB?.payload ?? null).slice(0, 300),
    })
  await ev.shot(page, 'phase2-main-on-B')

  // 撤回：session.revokeMessage {targetId: <该 user message id>}
  const hist1 = await proto.history(mainSid, { limitTurns: 20 })
  const userMsg = (hist1.messages ?? []).find((m) => m.role === 'user')
  assert('B: history 含可撤回的 user 消息（targetId 可得）', Boolean(userMsg?.id), {
    channel: 'B', expected: 'role=user 且带 id', actual: JSON.stringify((hist1.messages ?? []).map((m) => ({ role: m.role, id: m.id }))).slice(0, 400),
  })
  const revokeReply = await proto.call('session.revokeMessage',
    { sessionId: mainSid, targetId: userMsg.id }, { replyType: 'session.revokeMessage', timeoutMs: 60_000 })
  attach('revoke-reply', revokeReply)
  const hist2 = await proto.history(mainSid, { limitTurns: 20 })
  const afterRevokeText = JSON.stringify(hist2.messages ?? [])
  assert('B: 撤回后 user 消息离开活跃路径（history 不再含 a11-turn1-user-message）',
    !afterRevokeText.includes('a11-turn1-user-message'), {
      channel: 'B', expected: 'history 无该 user 消息文本', actual: `messages=${(hist2.messages ?? []).length} text前120=${afterRevokeText.slice(0, 120)}`,
    })
  ev.step({ step: 'session.revokeMessage', channel: 'B', exitCode: 0, stats: { targetId: userMsg.id, afterCount: (hist2.messages ?? []).length } })

  // 主会话文件结构证据（撤回后）：trunk 上应有 model_change A、被撤分支带 B、label 成新叶
  const mainList = await proto.call('config.sessions', {})
  const mainSummary = (mainList.groups ?? []).flatMap((g) => g.sessions ?? []).find((s) => s.id === mainSid)
  if (mainSummary?.sessionFile && fs.existsSync(mainSummary.sessionFile)) {
    attach('main-session-file-after-revoke', inspectJsonl(mainSummary.sessionFile))
  } else {
    attach('main-session-file-after-revoke', { missing: true, sessionFile: mainSummary?.sessionFile ?? null })
  }

  // 建 btw 线（UI 真路径：composer btw 钮 → drawer btw tab → 新建提问）
  await ui.click('testid=composer-btw-button', { timeoutMs: 20_000 })
  await ui.expectVisible('testid=drawer-btw-tab', { timeoutMs: 20_000 })
  if ((await page.locator('[data-testid="btw-empty-new"]').count()) > 0) {
    await ui.click('testid=btw-empty-new', { timeoutMs: 20_000 })
  } else {
    await ui.click('testid=btw-new-thread', { timeoutMs: 20_000 })
  }
  await ui.expectVisible('testid=btw-thread-chip', { timeoutMs: 60_000 })
  await new Promise((r) => setTimeout(r, 1500)) // 等 create reply 落定 + fork pill

  const chipInfo = await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="btw-thread-chip"]')
    if (!chip) return null
    return {
      dataSessionId: chip.getAttribute('data-session-id'),
      dataVid: chip.getAttribute('data-vid'),
      text: (chip.textContent ?? '').trim(),
      title: chip.getAttribute('title'),
      ariaPressed: chip.getAttribute('aria-pressed'),
    }
  })
  const lineSid = chipInfo?.dataSessionId
  assert('A: 抽屉线 chip 的 data-session-id 是 pi 真实会话 id 形态（无 data-vid 残留）',
    Boolean(lineSid) && PI_ID_RE.test(lineSid) && !String(lineSid).includes(':') && chipInfo?.dataVid === null, {
      channel: 'A', expected: 'data-session-id = pi id（无冒号）；data-vid = null', actual: JSON.stringify(chipInfo),
    })
  attach('btw-chip', chipInfo)

  // 协议侧交叉核验：session.list {surface:'btw', mainSessionId}
  const listReply = await proto.call('session.list', { surface: 'btw', mainSessionId: mainSid }, { timeoutMs: 60_000 })
  const lineEntries = (listReply.groups ?? []).flatMap((g) => g.sessions ?? [])
  const lineEntry = lineEntries.find((s) => s.id === lineSid)
  assert('B: session.list {surface:btw} 返回该线且 id === chip 的 data-session-id（同一 pi id）',
    Boolean(lineEntry), {
      channel: 'B', expected: `条目 id=${lineSid}`, actual: JSON.stringify(lineEntries.map((s) => ({ id: s.id, label: s.label }))).slice(0, 400),
    })
  attach('session-list-btw', { mainSid, entries: lineEntries.map((s) => ({ id: s.id, label: s.label, surface: s.surface })) })
  ev.step({ step: 'btw.create.ui', channel: 'A', exitCode: 0, stats: { mainSid, lineSid, chipLabel: chipInfo?.text } })
  await ev.shot(page, 'phase2-line-created')

  // 线自身状态：活读 getState（W2 同一入口，活读实例快照）
  const liveStateOfLine = await proto.call('session.getState', { sessionId: lineSid }, { replyType: 'session.getState', timeoutMs: 60_000 })
  assert('B: 建线后 session.getState(线) 返回模型 A（线继承 fork 快照活跃路径 = A）',
    liveStateOfLine?.modelId === MODELS.A.wire, {
      channel: 'B', expected: MODELS.A.wire, actual: JSON.stringify(liveStateOfLine).slice(0, 300),
    })
  attach('getstate-line-live', liveStateOfLine)

  // 线 composer 显示（创建时点）+ 内部状态探针
  const lineChipAtCreate = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  const piniaAtCreate = await piniaProbe(lineSid)
  attach('line-observation-at-create', { chip: lineChipAtCreate, pinia: piniaAtCreate, composerDom: await dumpLineComposer() })
  ev.step({ step: 'line.observation.at-create', channel: 'A', exitCode: 0, stats: { chip: lineChipAtCreate, liveState: piniaAtCreate.liveState } })

  // ══════════════════════════════════════════════════════════════
  // Phase 3 — 主会话切 C / D，线显示不随主会话切换而变
  // ══════════════════════════════════════════════════════════════
  await switchModelUI('css=[data-testid="main-area"]', MODELS.C)
  const mainChipC = await waitForChip('css=[data-testid="main-area"]', MODELS.C.name)
  assert('A: 主会话 composer 切到模型 C（Faux 1 C (slot actor)）', mainChipC.text.includes(MODELS.C.name), {
    channel: 'A', expected: `含 ${MODELS.C.name}`, actual: JSON.stringify(mainChipC),
  })
  const viewOpenC = await ensureLineViewOpen()
  const lineChipC = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  assert('A: 主会话切 C 后线 composer 仍显示 A（不随主会话切换而变）', lineChipC.text.includes(MODELS.A.name), {
    channel: 'A', expected: `线含 ${MODELS.A.name}`, actual: JSON.stringify({ viewOpenC, chip: lineChipC }),
  })
  const stateLineC = await proto.call('session.getState', { sessionId: lineSid }, { replyType: 'session.getState', timeoutMs: 60_000 })
  assert('B: 主会话切 C 后 getState(线) 仍为 faux/faux-1（协议真值）', stateLineC?.modelId === MODELS.A.wire, {
    channel: 'B', expected: MODELS.A.wire, actual: JSON.stringify(stateLineC).slice(0, 300),
  })
  await ev.shot(page, 'phase3-main-C-line-A')

  await switchModelUI('css=[data-testid="main-area"]', MODELS.D)
  const mainChipD = await waitForChip('css=[data-testid="main-area"]', MODELS.D.name)
  assert('A: 主会话 composer 切到模型 D（Faux 1 Reasoning (reasoning on)）', mainChipD.text.includes(MODELS.D.name), {
    channel: 'A', expected: `含 ${MODELS.D.name}`, actual: JSON.stringify(mainChipD),
  })
  await ensureLineViewOpen()
  const lineChipD = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  assert('A: 主会话切 D 后线 composer 仍显示 A（不随主会话切换而变）', lineChipD.text.includes(MODELS.A.name), {
    channel: 'A', expected: `线含 ${MODELS.A.name}`, actual: JSON.stringify(lineChipD),
  })
  await ev.shot(page, 'phase3-main-D-line-A')

  // ══════════════════════════════════════════════════════════════
  // Phase 4 — 一个会话一个键全链走查（W4a）
  // ══════════════════════════════════════════════════════════════
  // 4a. DOM：全页无 btw: 前缀形态、无 data-vid 残留
  const domScan = await page.evaluate(() => {
    const html = document.body.innerHTML
    return {
      btwColon: (html.match(/btw:/g) ?? []).length,
      dataVidEls: Array.from(document.querySelectorAll('[data-vid]')).map((el) => el.getAttribute('data-vid')),
      vidKeys: (html.match(/"vid"\s*:/g) ?? []).length,
      bodyLen: html.length,
    }
  })
  assert('A: 全页 DOM 无 btw: 前缀形态、无 data-vid 元素、无 "vid": 键',
    domScan.btwColon === 0 && domScan.dataVidEls.length === 0 && domScan.vidKeys === 0, {
      channel: 'A', expected: 'btw:=0 / data-vid=0 / "vid":=0', actual: JSON.stringify(domScan),
    })
  attach('dom-scan', domScan)

  // 4b. WS 网络帧：btw.create reply 键形态 + 全帧无 vid / 无 btw:
  const frames = await readFrames()
  const parsedFrames = frames.map((f) => { try { return { ...f, json: JSON.parse(f.data) } } catch { return null } }).filter(Boolean)
  attach('ws-frames-summary', {
    total: frames.length,
    dirs: frames.reduce((acc, f) => { acc[f.dir] = (acc[f.dir] ?? 0) + 1; return acc }, {}),
    types: parsedFrames.reduce((acc, f) => { acc[f.json.type] = (acc[f.json.type] ?? 0) + 1; return acc }, {}),
    lineRelated: parsedFrames.filter((f) => f.data.includes(lineSid)).map((f) => ({ dir: f.dir, type: f.json.type, t: f.t })),
  })
  const btwCreateFrame = parsedFrames.find((f) => f.json.type === 'btw.create' && f.dir === 'in')
  assert('B: WS 帧 btw.create reply 携带 sessionId = 线 pi id（W4a 键形态）',
    Boolean(btwCreateFrame) && btwCreateFrame.json.payload?.sessionId === lineSid, {
      channel: 'B', expected: `payload.sessionId=${lineSid}`, actual: btwCreateFrame ? JSON.stringify(btwCreateFrame.json.payload).slice(0, 300) : '<未捕获>',
    })
  const vidFrames = parsedFrames.filter((f) => /"vid"\s*:/.test(f.data))
  const btwColonFrames = parsedFrames.filter((f) => f.data.includes('btw:'))
  assert('B: 全部 WS 帧无 "vid" 字段、无 btw: 前缀 id', vidFrames.length === 0 && btwColonFrames.length === 0, {
    channel: 'B', expected: 'vid 帧=0 / btw: 帧=0', actual: `vidFrames=${vidFrames.length} btwColonFrames=${btwColonFrames.length}（总帧 ${parsedFrames.length}）`,
  })
  attach('ws-getstate-frames', parsedFrames.filter((f) => f.json.type === 'session.getState').map((f) => ({ dir: f.dir, payload: f.json.payload })))
  attach('ws-subscribe-frames', parsedFrames.filter((f) => f.json.type === 'session.subscribe').map((f) => ({ dir: f.dir, payload: f.json.payload })))

  // 4c. pinia store（CDP 可观测内部状态）：线分区键 = pi id
  const piniaLine = await piniaProbe(lineSid)
  attach('pinia-line', piniaLine)
  assert('A/CDP: pinia chat 分区按线 pi id 寄存（getMessages 可达）',
    piniaLine.ok && (piniaLine.chatPartition?.count ?? -1) >= 0, {
      channel: 'A', expected: 'chat 分区以线 pi id 可达', actual: JSON.stringify(piniaLine).slice(0, 400),
    })

  // 4d. 切走切回：建第二主会话 → 切过去 → 切回 → 线列表与键不变
  const created2 = await proto.call('session.create', { cwd: repo, label: 'a11-alt' }, { timeoutMs: 120_000 })
  const altSid = created2.session?.id
  await ui.click('css=.session-item:has-text("a11-alt")', { timeoutMs: 30_000 })
  await ui.expectVisible('testid=composer-box', { timeoutMs: 30_000 })
  await new Promise((r) => setTimeout(r, 1000))
  const chipCountOnAlt = await page.locator('[data-testid="btw-thread-chip"]').count()
  assert('A: 切到第二主会话后 btw 面板不显示第一条线（线按主会话归属）', chipCountOnAlt === 0, {
    channel: 'A', expected: 'chip 数=0', actual: `chipCount=${chipCountOnAlt}`,
  })
  await ui.click('css=.session-item:has-text("a11-main")', { timeoutMs: 30_000 })
  await ui.expectVisible('testid=composer-box', { timeoutMs: 30_000 })
  await ensureLineViewOpen()
  const chipAfterSwitchBack = await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="btw-thread-chip"]')
    return chip ? { dataSessionId: chip.getAttribute('data-session-id'), text: (chip.textContent ?? '').trim() } : null
  })
  assert('A: 切走切回后线 chip 的 data-session-id 恒为同一 pi id（键形态不变）',
    chipAfterSwitchBack?.dataSessionId === lineSid, {
      channel: 'A', expected: lineSid, actual: JSON.stringify(chipAfterSwitchBack),
    })
  const lineChipAfterSwitch = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  assert('A: 切走切回后线 composer 仍显示 A', lineChipAfterSwitch.text.includes(MODELS.A.name), {
    channel: 'A', expected: `含 ${MODELS.A.name}`, actual: JSON.stringify(lineChipAfterSwitch),
  })
  await ev.shot(page, 'phase4-key-walkthrough')

  // ══════════════════════════════════════════════════════════════
  // Phase 5 — 重启应用（同 dataDir relaunch）→ 开冷线 → 仍显示 A + 零 spawn
  // ══════════════════════════════════════════════════════════════
  await proto.close()
  await instance.dispose()
  ev.step({ step: 'env.dispose.1', channel: 'C', exitCode: 0, stats: { dataDirKept: fs.existsSync(dataDir) } })
  log('phase5: instance 1 disposed, relaunching same dataDir')

  const inst2 = createInstance({ repo, name: `verify-restart-${Date.now().toString(36)}`, dataDir, faux: { responses: meta.faux.responses, force: true }, background: true })
  await inst2.launch()
  await inst2.waitReady({ timeoutMs: 180_000 })
  const proto2 = await inst2.protocol()
  page = await inst2.page()
  await page.addInitScript(WS_HOOK)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const ui2 = createUI({ page, evidence: ev, repo })
  proto = proto2
  ui = ui2
  await new Promise((r) => setTimeout(r, 2500))
  ev.step({ step: 'env.relaunch', channel: 'C', exitCode: 0, stats: { dataDir } })

  // 重启后激活主会话。注意：重启后侧栏 label 走扫描口径（s.name ?? basename(cwd)），
  // 未必还是 'a11-main'——按行逐个点，激活判据取双信号（r7 修正③）：pinia panel store
  // 的 focusedSessionId（内部状态直接证据）+ panel-session-file 文本前缀（UI 证据，
  // 该按钮 v-if=sessionFile，sessionFile 未就绪时段不渲染，故作辅信号）。
  await ui2.expectVisible('css=.session-item', { timeoutMs: 60_000 })
  const sidebarRows = await page.$$eval('.session-item', (els) =>
    els.map((e) => ({ text: (e.textContent ?? '').trim().slice(0, 80), aria: e.getAttribute('aria-label') })))
  attach('sidebar-rows-after-restart', sidebarRows)
  const probeActivation = () => page.evaluate((wantPrefix) => {
    const el = document.querySelector('[data-testid="panel-session-file"]')
    const headerFile = el ? (el.textContent ?? '').trim() : ''
    let focused = null
    try {
      const app = document.querySelector('#app')
      const pinia = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties && app.__vue_app__.config.globalProperties.$pinia
      const panel = pinia && pinia._s && pinia._s.get('panel')
      if (panel) focused = panel.focusedSessionId?.value ?? panel.focusedSessionId ?? null
    } catch { /* 探针异常不阻断，落到 headerFile 信号 */ }
    return { headerFile, filePrefixOk: headerFile.startsWith(wantPrefix), focused }
  }, mainSid.slice(0, 8))
  let activated = false
  const activationTrail = []
  // 轮询收敛（r7 修正④）：先等自动恢复窗口（应用可能自行恢复上次会话），未命中再逐行点选，
  // 每次点选后轮询至收敛。禁「单击 + 固定 sleep + 单次读」——聚焦链完成时机不稳（a11r7 实证）。
  const pollActivation = async (tag, budgetMs = 12_000) => {
    const deadline = Date.now() + budgetMs
    let last = null
    while (Date.now() < deadline) {
      last = await probeActivation()
      if (last.filePrefixOk || last.focused === mainSid) {
        activated = true
        activationTrail.push({ tag, ...last })
        return
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    activationTrail.push({ tag, timeout: true, ...(last ?? {}) })
  }
  await pollActivation('auto-restore-window')
  for (let i = 0; i < sidebarRows.length && !activated; i++) {
    await page.locator('.session-item').nth(i).click({ timeoutMs: 20_000 }).catch(() => {})
    await pollActivation(`row-${i}`)
  }
  attach('activation-trail-after-restart', activationTrail)
  assert('A: 重启后侧栏可激活主会话（focusedSessionId 或 panel-session-file 前缀命中 mainSid）', activated, {
    channel: 'A', expected: `focusedSessionId=${mainSid} 或 panel-session-file 以 ${mainSid.slice(0, 8)} 开头`, actual: JSON.stringify(activationTrail).slice(0, 400),
  })
  await ui2.expectVisible('testid=composer-box', { timeoutMs: 30_000 })
  const mainChipAfterRestart = await waitForChip('css=[data-testid="main-area"]', MODELS.D.name, 40_000)
  assert('A: 重启后主会话 composer 显示 D（持久生效值；与线的 A 形成对照）', mainChipAfterRestart.text.includes(MODELS.D.name), {
    channel: 'A', expected: `含 ${MODELS.D.name}`, actual: JSON.stringify(mainChipAfterRestart),
  })
  ev.step({ step: 'restart.main-activated', channel: 'A', exitCode: 0, stats: { chip: mainChipAfterRestart } })

  // 重启后线仍在册（rebuildFromDisk）
  const listAfterRestart = await proto2.call('session.list', { surface: 'btw', mainSessionId: mainSid }, { timeoutMs: 60_000 })
  const restartLineIds = (listAfterRestart.groups ?? []).flatMap((g) => g.sessions ?? []).map((s) => s.id)
  assert('B: 重启后 session.list 仍含该线且 id 形态不变（rebuildFromDisk）', restartLineIds.includes(lineSid), {
    channel: 'B', expected: `含 ${lineSid}`, actual: JSON.stringify(restartLineIds),
  })
  attach('session-list-after-restart', { ids: restartLineIds })

  // ── 零 spawn 见证：先取开线前快照 ──
  const before = await spawnWitness('before-open-cold-line')
  attach('spawn-witness-before', before)

  // 打开冷线（UI 真路径：composer btw 钮 → drawer btw tab → 线自动选中/点选）
  await ui2.click('testid=composer-btw-button', { timeoutMs: 20_000 })
  await ui2.expectVisible('testid=drawer-btw-tab', { timeoutMs: 20_000 })
  await ui2.expectVisible('testid=btw-thread-chip', { timeoutMs: 30_000 })
  const coldChip = page.locator('[data-testid="btw-thread-chip"]').first()
  if ((await coldChip.getAttribute('aria-pressed')) !== 'true') {
    await coldChip.click({ timeoutMs: 15_000 }).catch(() => {})
  }
  await ui2.expectVisible('testid=btw-composer', { timeoutMs: 30_000 })
  await new Promise((r) => setTimeout(r, 5000)) // 等回放/拉取收敛（排除延迟拉取）

  // ── 零 spawn 见证：开后快照 + 比对 ──
  const after = await spawnWitness('after-open-cold-line')
  attach('spawn-witness-after', after)
  const newTee = after.teeFiles.filter((f) => !before.teeFiles.some((b) => b.sid === f.sid && b.file === f.file))
  const markersUnchanged = before.markers.exists === after.markers.exists
    && before.markers.hash === after.markers.hash
    && before.markers.mtimeMs === after.markers.mtimeMs
  const newPiProcs = after.piProcs.length - before.piProcs.length
  assert('C: 打开冷线过程零 pi spawn——进程表无新增（OS 侧 ps 快照比对）', newPiProcs <= 0, {
    channel: 'C', expected: 'pi 进程数不增', actual: `before=${before.piProcs.length} after=${after.piProcs.length} 差=${newPiProcs}`,
  })
  assert('C: 打开冷线过程零 pi spawn——无新 tee 文件（ext-sessions/*/logs/pi-*.jsonl）', newTee.length === 0, {
    channel: 'C', expected: '新增 tee 文件=0', actual: JSON.stringify(newTee).slice(0, 400),
  })
  assert('C: 打开冷线过程零 pi spawn——pi-spawn-markers.json 未被重写（mtime+内容哈希不变）', markersUnchanged, {
    channel: 'C', expected: 'markers 不变', actual: JSON.stringify({ before: before.markers, after: after.markers }).slice(0, 500),
  })
  const runtimeLogDelta = after.runtimeLogs.map((a) => {
    const b = before.runtimeLogs.find((x) => x.file === a.file)
    return {
      file: a.file,
      grew: b ? a.size - b.size : a.size,
      linesGrew: b ? a.lineCount - b.lineCount : a.lineCount,
      spawnLinesGrew: b ? a.spawnLines - b.spawnLines : a.spawnLines,
      tailChanged: b ? a.tailHash !== b.tailHash : true,
    }
  })
  attach('runtime-log-delta', runtimeLogDelta)
  const spawnLinesInWindow = runtimeLogDelta.reduce((n, d) => n + Math.max(0, d.spawnLinesGrew), 0)
  assert('C: runtime 日志窗口内无新增 pi spawn 记录行（spawning pi / pi-respawn / spawn-markers 行数不增）',
    spawnLinesInWindow === 0, {
      channel: 'C', expected: '窗口内 spawn 行增量=0', actual: JSON.stringify(runtimeLogDelta).slice(0, 500),
    })
  ev.step({ step: 'cold-open.zero-spawn', channel: 'C', exitCode: 0, stats: { newPiProcs, newTee: newTee.length, markersUnchanged, runtimeLogDelta } })

  // ── 冷读显示断言 ──
  const lineChipCold = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  const piniaCold = await piniaProbe(lineSid)
  const frames2 = await readFrames()
  const parsed2 = frames2.map((f) => { try { return { ...f, json: JSON.parse(f.data) } } catch { return null } }).filter(Boolean)
  attach('cold-open-observation', {
    chip: lineChipCold,
    pinia: piniaCold,
    composerDom: await dumpLineComposer(),
    getStateFrames: parsed2.filter((f) => f.json.type === 'session.getState').map((f) => ({ dir: f.dir, payload: f.json.payload })),
    subscribeFrames: parsed2.filter((f) => f.json.type === 'session.subscribe').map((f) => ({ dir: f.dir, payload: f.json.payload })),
    lineRelatedFrames: parsed2.filter((f) => f.data.includes(lineSid)).map((f) => ({ dir: f.dir, type: f.json.type })),
    frameCount: frames2.length,
  })
  assert('A: 重启后打开冷线，线 composer 显示 A（自己创建时的模型值）', lineChipCold.text.includes(MODELS.A.name), {
    channel: 'A', expected: `含 ${MODELS.A.name}`, actual: JSON.stringify(lineChipCold),
  })
  // 冷读断言（重启 leg 的协议真值）：失败不中断——错误本身即是断言证据
  let coldGetState = null
  let coldGetStateError = null
  try {
    coldGetState = await proto2.call('session.getState', { sessionId: lineSid }, { replyType: 'session.getState', timeoutMs: 60_000 })
  } catch (e) {
    coldGetStateError = String(e?.message ?? e).slice(0, 300)
  }
  attach('getstate-line-cold', coldGetState ? coldGetState : { error: coldGetStateError })
  assert('B: 冷读 session.getState(线) = faux/faux-1（A；读线自身会话文件，非主会话当前值 D）',
    coldGetState?.modelId === MODELS.A.wire, {
      channel: 'B', expected: MODELS.A.wire, actual: coldGetState ? JSON.stringify(coldGetState).slice(0, 300) : `ERROR: ${coldGetStateError}`,
    })
  await ev.shot(page, 'phase5-cold-line')

  // 线文件结构证据（活跃路径 vs 物理尾——门的判定器）+ btw 目录文件名清单
  const btwDir = path.join(dataDir, 'ext-sessions', mainSid, 'btw')
  let lineFileEvidence = { dir: btwDir, exists: false }
  try {
    const files = fs.readdirSync(btwDir).filter((f) => f.endsWith('.jsonl'))
    lineFileEvidence = {
      dir: btwDir,
      exists: true,
      // 文件名清单：pi forkFrom 落盘命名 = `<fileTimestamp>_<piSessionId>.jsonl`（非裸 id）
      fileNames: files,
      files: files.map((f) => inspectJsonl(path.join(btwDir, f))),
    }
  } catch (e) {
    lineFileEvidence = { dir: btwDir, exists: false, error: String(e).slice(0, 200) }
  }
  attach('btw-line-file', lineFileEvidence)
  // 选当前线（headerId === lineSid）的文件；btw 目录可能留有已删线的文件
  const coldLineInspect = (lineFileEvidence.files ?? []).find((f) => f.headerId === lineSid) ?? lineFileEvidence.files?.[0]
  assert('C: 线会话文件活跃路径（leaf 回溯）首条 model_change = faux-1（A）',
    Boolean(coldLineInspect) && String(coldLineInspect.firstModelChangeFromLeaf ?? '').includes('faux-1')
      && !String(coldLineInspect.firstModelChangeFromLeaf ?? '').includes('faux-1-b')
      && !String(coldLineInspect.firstModelChangeFromLeaf ?? '').includes('faux-1-c'), {
      channel: 'C', expected: '活跃路径首条 model_change = faux/faux-1', actual: JSON.stringify({
        first: coldLineInspect?.firstModelChangeFromLeaf ?? null,
        activePathModels: coldLineInspect?.activePathModels ?? null,
      }),
    })
  assert('C: 线文件物理尾向含 B 侧 model_change（被撤分支在文件里——活跃路径裁剪是门的判定器）',
    Boolean(coldLineInspect) && (coldLineInspect.physicalTailModels ?? []).some((m) => String(m).includes('faux-1-b')), {
      channel: 'C', expected: '物理尾向含 faux/faux-1-b', actual: JSON.stringify(coldLineInspect?.physicalTailModels ?? null),
    })

  // 主会话再切（六步第 ⑥ 步「主会话再切 D 后线仍 A」——重启后主已在 D，改切 B 形成新对照）
  await switchModelUI('css=[data-testid="main-area"]', MODELS.B)
  const mainChipFinal = await waitForChip('css=[data-testid="main-area"]', MODELS.B.name)
  assert('A: 主会话再切 B 后 composer 显示 B', mainChipFinal.text.includes(MODELS.B.name), {
    channel: 'A', expected: `含 ${MODELS.B.name}`, actual: JSON.stringify(mainChipFinal),
  })
  await ensureLineViewOpen()
  const lineChipFinal = await readModelChip('css=[data-testid="drawer-btw-tab"]')
  assert('A: 主会话再切 B 后线 composer 仍显示 A（重启后仍不随主会话切换而变）', lineChipFinal.text.includes(MODELS.A.name), {
    channel: 'A', expected: `含 ${MODELS.A.name}`, actual: JSON.stringify(lineChipFinal),
  })
  await ev.shot(page, 'phase5-main-B-line-A-cold')

  // ══════════════════════════════════════════════════════════════
  // Phase 4e（r7 修正②：重启 leg 之后执行）— 删除线后再建：键形态不变
  // （新 pi id、同形态、无前缀）；新线显示它自己的创建时模型（此刻主会话在 B）
  // ══════════════════════════════════════════════════════════════
  await proto.call('btw.remove', { sessionId: lineSid }, { replyType: 'btw.remove', timeoutMs: 60_000 })
  await new Promise((r) => setTimeout(r, 1500))
  const listAfterRemove = await proto.call('session.list', { surface: 'btw', mainSessionId: mainSid }, { timeoutMs: 60_000 })
  const afterRemoveIds = (listAfterRemove.groups ?? []).flatMap((g) => g.sessions ?? []).map((s) => s.id)
  assert('B: btw.remove 后 session.list 不再含该线 id', !afterRemoveIds.includes(lineSid), {
    channel: 'B', expected: `无 ${lineSid}`, actual: JSON.stringify(afterRemoveIds),
  })
  await ensureLineViewOpen().catch(() => false)
  if ((await page.locator('[data-testid="btw-new-thread"]').count()) > 0) {
    await ui.click('testid=btw-new-thread', { timeoutMs: 20_000 })
  } else {
    await ui.click('testid=btw-empty-new', { timeoutMs: 20_000 })
  }
  // 等到出现 data-session-id ≠ 旧线 id 的新 chip（面板可能在 remove 后仍显示旧 chip 直至重拉）
  let chip2 = null
  {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      const chips = await page.$$eval('[data-testid="btw-thread-chip"]', (els) =>
        els.map((e) => ({ dataSessionId: e.getAttribute('data-session-id'), dataVid: e.getAttribute('data-vid'), text: (e.textContent ?? '').trim() })))
      chip2 = chips.find((c) => c.dataSessionId && c.dataSessionId !== lineSid) ?? null
      if (chip2) break
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  const lineSid2 = chip2?.dataSessionId
  assert('A: 删除线后再建，新线 chip 的 data-session-id 仍是 pi 真实会话 id 形态（键形态不变）',
    Boolean(lineSid2) && PI_ID_RE.test(lineSid2) && !String(lineSid2).includes(':') && chip2?.dataVid === null, {
      channel: 'A', expected: '新 pi id、异于旧线、无 data-vid', actual: JSON.stringify(chip2),
    })
  if (lineSid2) {
    await page.locator(`[data-testid="btw-thread-chip"][data-session-id="${lineSid2}"]`).first().click({ timeout: 15_000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  }
  attach('btw-chip-2', chip2)
  const listAfterRecreate = await proto.call('session.list', { surface: 'btw', mainSessionId: mainSid }, { timeoutMs: 60_000 })
  const recreatedIds = (listAfterRecreate.groups ?? []).flatMap((g) => g.sessions ?? []).map((s) => s.id)
  assert('B: 再建后 session.list 只含新线 id（旧线已注销）',
    recreatedIds.length === 1 && recreatedIds[0] === lineSid2, {
      channel: 'B', expected: `[${lineSid2}]`, actual: JSON.stringify(recreatedIds),
    })
  const stateLine2 = await proto.call('session.getState', { sessionId: lineSid2 }, { replyType: 'session.getState', timeoutMs: 60_000 })
  attach('getstate-line2-live', stateLine2)
  assert('B: 再建线 getState = 它自己的创建时模型 faux/faux-1-b（主会话此刻在 B；各线读各自文件）',
    stateLine2?.modelId === MODELS.B.wire, {
      channel: 'B', expected: MODELS.B.wire, actual: JSON.stringify(stateLine2).slice(0, 300),
    })
  ev.step({ step: 'btw.remove-recreate', channel: 'A', exitCode: 0, stats: { oldLine: lineSid, newLine: lineSid2, newLineModel: stateLine2?.modelId } })

  // ── 诊断（非验收断言）：线内发一条消息 → ensureStreamSubscription(线) 建订阅 →
  //    stateSnapshot 回放线自身 state_changed → 显示面应显示 A。
  //    用途 = 隔离「显示面本身坏」 vs 「开线缺拉取/订阅」两种根因。
  try {
    await ui2.type('css=[data-testid="btw-composer"] [contenteditable]', 'a11-line-diag', { timeoutMs: 15_000 })
    await page.keyboard.press('Enter')
    await new Promise((r) => setTimeout(r, 8000))
    const diagChip = await readModelChip('css=[data-testid="drawer-btw-tab"]')
    const diagPinia = await piniaProbe(lineSid2)
    const diagFrames = await readFrames()
    const diagParsed = diagFrames.map((f) => { try { return { ...f, json: JSON.parse(f.data) } } catch { return null } }).filter(Boolean)
    attach('diagnostic-line-send', {
      chip: diagChip,
      pinia: diagPinia,
      getStateFrames: diagParsed.filter((f) => f.json.type === 'session.getState').map((f) => ({ dir: f.dir, payload: f.json.payload })),
      subscribeFrames: diagParsed.filter((f) => f.json.type === 'session.subscribe').map((f) => ({ dir: f.dir, payload: f.json.payload })),
      stateChangedForLine: diagParsed.filter((f) => f.json.type === 'session.state_changed' && f.data.includes(lineSid2)).map((f) => f.json.payload),
    })
    ev.step({ step: 'diagnostic.line-send', channel: 'A', exitCode: 0, stats: { chip: diagChip, liveState: diagPinia.liveState } })
  } catch (e) {
    attach('diagnostic-line-send-error', String(e?.message ?? e).slice(0, 500))
    ev.step({ step: 'diagnostic.line-send', channel: 'A', exitCode: 1, stats: { error: String(e?.message ?? e).slice(0, 200) } })
  }

  // ── 收尾：dispose 实例 2 ──
  await proto2.close()
  await inst2.dispose()
  ev.step({ step: 'env.dispose.2', channel: 'C', exitCode: 0, stats: { dataDir } })

  return { uncovered, gotchas }
}
