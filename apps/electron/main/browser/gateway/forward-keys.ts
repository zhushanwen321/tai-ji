/**
 * view 转发键清单（display-containers §7.4 [MANDATORY]）。
 *
 * 背景：点过浏览器页面元素后焦点进入 WebContentsView 自己的 webContents，宿主 renderer 的
 * window keydown 与主窗口 webContents 的 before-input-event 都收不到输入——主进程对 view 的
 * webContents 挂 before-input-event，命中**转发键清单**的键统一转发主窗口处理链
 * （⌃` 走 toggle、⌘W 走编排器层级关、app 快捷键族走各自注册动作）。
 *
 * 清单构成：
 * 1. 容器键（⌃` / ⌘W，无条件转发）——判定与 window-factory 窗口级 before-input-event **逐字同源**
 *    （焦点位移不得改变键语义，两处判定漂移 = 「时灵时不灵」）；
 * 2. app 快捷键族（useGlobalShortcuts 注册项 + settings 可配置项）——renderer 注册处经 IPC 上报
 *    （本模块的 ForwardKeyRegistry），主进程不硬编码。同步触发面（§7.4 全量重报）：
 *    清单初始化上报 + 注册/注销增量 + settings 重录快捷键（shortcutOverrides 运行时可变）
 *    + renderer 重载（刷新 / 崩溃恢复后启动即重报）——漏报面 = 改键用户与崩溃恢复后页面聚焦态快捷键失灵。
 *
 * 入清单约束（[MANDATORY]）：仅含 **mod 前缀组合**（mod=meta||ctrl，可带 shift）。
 * 裸键与 shift-only 组合不入清单（反例：'j' 入清单则页面文本框输入字母 j 触发 app 动作——
 * 劫持页面输入通道）；**Esc 不入清单**（§6.7 所有权第 4 层：页面聚焦态 Esc 归页面自身语义——
 * dev server 错误浮层 / 页内 IME 组合取消 / 全屏退出；关浮层键盘兜底 = ⌘W 无条件转发）。
 * 不采用「view 注入 preload 探测页面是否消费 Esc」——零信任嵌入立场明文无 preload 零注入
 * （§6.7 不采用④），browser-view-manager 头注不变量 1。
 *
 * 双端匹配配对契约（§7.4）：mod = input.control || input.meta（两分皆认）；shift 严格双分
 * （⌘⇧P 与 ⌘P 是不同键——shift 项要求 shift、非 shift 项要求无 shift）；alt / 裸键 / shift-only
 * 一律不匹配。等价性由转发链单测键矩阵对账（两侧各跑同一键矩阵断言同判定）。
 * 已知不对称（登记为已知边界）：renderer 的 matchOverrideKey 对未声明修饰键不拒绝（'mod+n'
 * override 在 ⌥⌘N 下也命中），主进程按配对契约严格拒绝——严格侧只会少转发不会误转发。
 *
 * 依赖方向：纯函数模块（无 electron 运行时依赖，可独立单测）；attachForwardKeyBridge 以
 * 结构化接口接收 webContents / window，由 browser-view-manager 在 create 时挂载。
 */

/** 容器键转发类型（与 'shortcut' IPC 通道既有字面量同词表：useCloseShortcut / 编排器消费） */
export type ContainerShortcutType = 'close' | 'toggle-bottom-drawer'

/** before-input-event 的 input 子集（Electron Input 的键判定相关字段） */
export interface ForwardInput { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  key: string
  control?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

/** 转发命中结果 */
export type ForwardedKey =
  | { kind: 'container'; type: ContainerShortcutType }
  | { kind: 'app'; accelerator: string }

/** 解析后的 accelerator（mod 前缀组合） */
export interface ParsedAccelerator { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  key: string
  shift: boolean
}

/** Esc 不入清单（[MANDATORY]，§6.7 所有权第 4 层）——'mod+escape' 也不收 */
const EXCLUDED_KEYS = new Set(['escape'])

/** 修饰符字面量（不是键） */
const MODIFIER_TOKENS = new Set(['mod', 'shift', 'alt', 'ctrl', 'control', 'meta', 'command', 'cmd', 'option'])

/**
 * 解析 mod 前缀 accelerator（'mod+k' / 'mod+shift+p'）。返回 null = 不入清单
 * （裸键 / shift-only / alt 组合 / 转义键 / 非法格式）。
 */
export function parseForwardAccelerator(accelerator: string): ParsedAccelerator | null {
  if (typeof accelerator !== 'string') return null
  const parts = accelerator
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const key = parts.pop()
  const modifiers = parts
  if (key === undefined || modifiers.length === 0) return null // 裸键不入清单
  if (EXCLUDED_KEYS.has(key)) return null
  if (MODIFIER_TOKENS.has(key)) return null // 'mod+shift' 这类畸形项
  if (!modifiers.includes('mod')) return null // shift-only / alt-only / 无前缀一律不入清单
  if (modifiers.includes('alt')) return null // alt 组合不入清单（§7.4 入清单约束）
  if (modifiers.some((m) => m !== 'mod' && m !== 'shift')) return null // 未知修饰符不入清单
  const shift = modifiers.includes('shift')
  return { key, shift }
}

/**
 * 容器键判定——与 window-factory.ts 的窗口级 before-input-event **逐字同源**：
 * - ⌘W / Ctrl+W（type='close'）：`key==='w' && (control||meta)`（含 shift/alt 不排除的现状，
 *   与窗口级同款——两处判定必须等价，否则焦点位移即行为漂移）
 * - ⌃`（type='toggle-bottom-drawer'）：Control+Backquote 严格匹配（无 shift/alt/meta 附加）
 */
export function matchContainerShortcut(input: ForwardInput): ContainerShortcutType | null {
  const key = (input.key ?? '').toLowerCase()
  if (key === 'w' && (input.control || input.meta)) return 'close'
  if (input.key === '`' && input.control && !input.meta && !input.alt && !input.shift) return 'toggle-bottom-drawer'
  return null
}

/** app 快捷键族单条 accelerator 匹配（配对契约：mod 两分皆认 / shift 严格双分 / alt 拒绝） */
export function matchAppAccelerator(input: ForwardInput, accelerator: string): boolean {
  const parsed = parseForwardAccelerator(accelerator)
  if (!parsed) return false // 不入清单的项永不匹配（裸键 / shift-only / Esc 等已知边界）
  if (input.alt) return false
  if (!(input.control || input.meta)) return false
  if (parsed.shift !== !!input.shift) return false
  return (input.key ?? '').toLowerCase() === parsed.key
}

/**
 * 转发判定（容器键优先——容器键无条件转发，app 族不得抢占 ⌘W / ⌃` 语义）。
 * 返回 null = 不转发（含 Esc：页面自身语义优先）。
 */
export function matchForwardedKey(input: ForwardInput, accelerators: Iterable<string>): ForwardedKey | null {
  const container = matchContainerShortcut(input)
  if (container) return { kind: 'container', type: container }
  for (const accelerator of accelerators) {
    if (matchAppAccelerator(input, accelerator)) return { kind: 'app', accelerator }
  }
  return null
}

/** 清单变更报告（accepted = 实际入清单；rejected = 违反入清单约束被拒） */
export interface ForwardKeyReport { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  accepted: string[]
  rejected: string[]
}

/** 增量变更（注册/注销；§7.4「注册/注销时增量」触发面） */
export interface ForwardKeyDelta { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  add?: readonly string[]
  remove?: readonly string[]
}

/**
 * 按入清单约束切分 keys：合法项规范化（trim + 小写）去重，非法项进 rejected（不入清单）。
 * 同一 key 重复注册幂等。
 */
export function normalizeForwardKeys(keys: readonly string[]): ForwardKeyReport {
  const accepted: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const raw of keys) {
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!parseForwardAccelerator(normalized)) {
      rejected.push(typeof raw === 'string' ? raw : String(raw))
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    accepted.push(normalized)
  }
  return { accepted, rejected }
}

/**
 * 转发键清单注册表（renderer 上报 → 主进程匹配）。
 * Set 保插入序（匹配结果确定性）；set = 全量重报（初始化 / settings 重录 / renderer 重载），
 * update = 注册/注销增量。两者幂等可乱序补报——上报是「允许丢失的提示 + 全量重报收敛」，
 * 不做时间窗兜底（AGENTS 时间平抑红线）。
 */
export class ForwardKeyRegistry {
  private keys = new Set<string>()

  /** 全量替换（幂等：同清单重复 set 无副作用） */
  set(keys: readonly string[]): ForwardKeyReport {
    const report = normalizeForwardKeys(keys)
    this.keys = new Set(report.accepted)
    return report
  }

  /** 注册/注销增量 */
  update(delta: ForwardKeyDelta): ForwardKeyReport {
    const addReport = normalizeForwardKeys(delta.add ?? [])
    for (const key of addReport.accepted) this.keys.add(key)
    for (const raw of delta.remove ?? []) {
      this.keys.delete(typeof raw === 'string' ? raw.trim().toLowerCase() : '')
    }
    return addReport
  }

  /** 当前清单（插入序） */
  list(): string[] {
    return [...this.keys]
  }
}

/** 进程级默认注册表（browser:forward-keys IPC 写入；attachForwardKeyBridge 读取） */
export const forwardKeyRegistry = new ForwardKeyRegistry()

/** before-input-event 的 event 子集 */
export interface ForwardKeyEvent { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  preventDefault(): void
}

/** 转发目标窗口（取自 IWindowManager.get(windowId)） */
export interface ForwardBridgeTargetWindow { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  isDestroyed(): boolean
  webContents: {
    send(channel: string, payload: unknown): void
  }
}

/** view 的 webContents 子集（结构化接口：真实 WebContents 与测试桩均适用） */
export interface ForwardBridgeWebContents { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  on(event: 'before-input-event', listener: (event: ForwardKeyEvent, input: ForwardInput) => void): unknown
}

/**
 * 挂载转发桥：view webContents 的 before-input-event 命中清单键 → preventDefault（键被宿主消费，
 * 页面不再收到）→ 转发主窗口处理链：
 * - 容器键 → `webContents.send('shortcut', 'close' | 'toggle-bottom-drawer')`
 *   （与 window-factory 窗口级链同一通道同一字面量——renderer 编排器/useCloseShortcut 无差别消费）
 * - app 快捷键族 → `webContents.send('shortcut:forward', { accelerator })`
 *   （renderer 注册处按 accelerator 派发各自注册动作）
 * 未命中（含 Esc）→ 不 preventDefault、不转发（页面自身语义优先）。
 */
export function attachForwardKeyBridge(
  wc: ForwardBridgeWebContents,
  getTargetWindow: () => ForwardBridgeTargetWindow | null | undefined,
  registry: ForwardKeyRegistry = forwardKeyRegistry,
): void {
  wc.on('before-input-event', (event, input) => {
    const hit = matchForwardedKey(input, registry.list())
    if (!hit) return
    event.preventDefault()
    const win = getTargetWindow()
    if (!win || win.isDestroyed()) return
    if (hit.kind === 'container') {
      win.webContents.send('shortcut', hit.type)
    } else {
      win.webContents.send('shortcut:forward', { accelerator: hit.accelerator })
    }
  })
}
