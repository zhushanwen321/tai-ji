/**
 * search —— 搜索编排聚合（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useSearch.ts（313 行），语义逐条等价。
 * C-W3-1 端口注入：isMock 改 deps.ports.isMock（替代 import.meta.env.VITE_MOCK）、
 * mockApi.search fixture 经 deps.ports.searchMock（SearchDataPort）、composerApi.getFileCandidates
 * 经 deps.ports.fileCandidates（FileCandidatesPort）、sessionApi.list 经 deps.ports.sessionList
 * （SessionListPort）。i18n.global.t 经 deps.ports.t（TranslatePort）。
 *
 * 数据流：SearchModal.watch(query) → debounce 120ms → query(q, ctx) →
 *   allSettled 并行查 3 源（命令内存 / file WS 直查 / session WS）→
 *   合并候选 → matchFilter 过滤 → DTO 映射 → 按类型分组（符号占位 D-001）→ Section[]
 *
 * 失败路径：
 *  - file 源 WS reject：error 从 fileCandidates 冒泡（AC-4.5 不经 useFileSearch.load 吞错层）
 *    → allSettled rejected → 分组空态（MR-4.2 单源静默）
 *  - WS 断连 pending 永不 settle（#17 F-1）：WS 超时 race 10s → reject → allSettled settled
 *    → 分组空态+toast（AC-17.1，不永久挂死）
 *  - 全源失败：四类空态 + toast（AC-17.3）
 *  - 乱序响应：loadSeq 守卫 seq!==loadSeq 丢弃旧结果（BC-9，D-022 骨架约束）
 *
 * 并发（BC-9）：loadSeq 模块级自增序列号，await 后比对，旧响应丢弃。
 */
import { matchFilter } from './match-engine'
import { toFileCandidates } from './file-candidates'
import type { FileCandidate } from './file-candidates'
import { filterAndSortFileCandidates } from './file-match'
import { WS_SOURCE_TIMEOUT_MS } from './types'
import type { SearchCtx, Section, SearchItem } from './types'
import { useCommandRegistry } from './command-registry'
import type { UnifiedCommand } from './command-registry'
import { useRecents } from './recents'
import type { SearchDeps } from './search-ports'
import type { AppCommand } from './types'
import type { SessionCommand } from './command-store'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

/**
 * 文件候选结果上限（D-021 校正值）。
 * 超过此值截断，防大仓库全量递归结果过多拖垮渲染（AC-4.7）。
 * UI 层基于 items.length===MAX_SEARCH_RESULTS 判断是否显示截断提示。
 */
const MAX_SEARCH_RESULTS = 5000
/** 空查询时显示的建议命令数量（对齐 mock SEARCH_SUGGESTED_COUNT） */
const SUGGESTED_COMMAND_COUNT = 3

/** AppCommand type guard（有 action 属性） */
function isAppCommand(c: UnifiedCommand): c is AppCommand {
  return typeof (c as AppCommand).action === 'function'
}

/** SessionCommand type guard（有 kind 属性） */
function isSessionCommand(c: UnifiedCommand): c is SessionCommand {
  return typeof (c as SessionCommand).kind === 'string'
}

export function useSearch(
  activeSessionId: { value: string | null },
  deps: SearchDeps,
) {
  const { ports } = deps
  const commandRegistry = useCommandRegistry(activeSessionId, deps.commandStore)
  const recents = useRecents(deps.storage)

  /** [BC-9 / D-022 骨架约束] loadSeq 序列号守卫（乱序响应不覆盖新结果） */
  let loadSeq = 0

  /**
   * 查询（核心入口）。
   * @param q 查询词（已 trim）
   * @param ctx 搜索上下文（activeSessionId）
   * @returns 四类分组 Section[]（空组过滤，符号占位 D-001）
   */
  async function query(q: string, ctx: SearchCtx): Promise<Section[]> {
    const seq = ++loadSeq // BC-9 守卫入口

    // AC-5.2：mock 模式走 searchMock fixture（search 无 real WS domain，D-026）。
    // 返回已是 Section[] 形态（{label, items}），符号占位恒加入（与 real 轨 groupByType 对齐 D-001）。
    if (ports.isMock) {
      // [tc u3/D4-②] searchMock 可选端口守卫：isMock=true 而未装配属壳装配错误——显式抛错
      // 指向恢复动作（恢复路径：检查 useSearchModalDeps 的 VITE_MOCK 分支与 mock 模块导入），
      // 不装配静默返空 stub（会掩盖装配错误，被否方案见设计 D4 契约前置决策）。
      if (!ports.searchMock) {
        throw new Error(
          'search: isMock=true 但 SearchPorts.searchMock 未装配——mock 构建下壳必须在 ' +
            'useSearchModalDeps 注入 core transport/mock 的 search.query；' +
            '请检查 VITE_MOCK 构建配置与 ports 装配（real 构建不应进入此分支）',
        )
      }
      const mockSections = await ports.searchMock(q)
      // BC-9 守卫：旧响应丢弃
      if (seq !== loadSeq) return []
      // 补符号占位 section（mock fixture 无符号数据，与 real 轨 groupByType 占位行为一致 D-001）
      const symbolLabel = ports.t('search.sectionSymbol')
      const hasSymbol = mockSections.some((s) => s.label === symbolLabel)
      return hasSymbol
        ? mockSections
        : [...mockSections, { kind: 'symbol', label: symbolLabel, items: [] }]
    }

    // 空查询：recents + 建议命令（不查 WS 源）
    if (!q) {
      const recentItems = mapRecentsToItems(await recents.read())
      const suggested = mapCommandsToItems(commandRegistry.list().value).slice(0, SUGGESTED_COMMAND_COUNT)
      const sections: Section[] = [
        { kind: 'recent', label: ports.t('search.recent'), items: recentItems },
        { kind: 'suggested', label: ports.t('search.suggestedCommand'), items: suggested },
      ]
      return sections.filter((s) => s.items.length > 0)
    }

    // 非空查询：allSettled 并行查 3 源
    // file 源在源内用 filterAndSortFileCandidates 过滤+排序（与 composer # 同管线，复用同一套文件匹配算法），
    // 故 file 结果不再进 matchFilter 二次过滤；command/session 仍走 matchFilter（纯子串，与 composer slash 同款）。
    const [commandRes, fileRes, sessionRes] = await Promise.allSettled([
      queryCommandSource(), // 内存，无 WS
      queryFileSource(ctx.activeSessionId, q), // WS 缓存优先 + #17 超时 race + 源内分级匹配
      querySessionSource(q), // WS + #17 超时 race + 源内子串过滤
    ])

    // BC-9 守卫：旧响应丢弃（seq !== loadSeq 说明有更新查询）
    if (seq !== loadSeq) return []

    // MR-4.2：单源 rejected 取空，不阻断其他源。file/session 源内已过滤，直接合并
    const commands = commandRes.status === 'fulfilled' ? commandRes.value : []
    const files = fileRes.status === 'fulfilled' ? fileRes.value : []
    const sessions = sessionRes.status === 'fulfilled' ? sessionRes.value : []
    // command 源返回全量（未过滤），此处统一 matchFilter；file/session 已在源内过滤
    const filteredCommands = matchFilter(commands, q)
    const allCandidates = [...filteredCommands, ...files, ...sessions]

    // 按类型分组 + 符号占位（D-001，GAP-E1）
    return groupByType(allCandidates)
  }

  /** 命令源（内存，无 WS）：useCommandRegistry 聚合 → SearchItem 映射 */
  async function queryCommandSource(): Promise<SearchItem[]> {
    return mapCommandsToItems(commandRegistry.list().value)
  }

  /**
   * file 源（WS 直查 + #17 超时 race + 源内分级匹配）。
   * 复用 composer # 的同一套匹配管线：FileNode[] → toFileCandidates → filterAndSortFileCandidates
   * （basename 前缀 > path 子串 + 文件优先 + 路径浅优先 + 排序），保证两处文件搜索行为一致。
   * AC-4.5：直调 fileCandidates（不经 useFileSearch.load 吞错层）；无缓存（缓存治理 U1 1-3
   * 退役）——每次现拉，外部建/删文件零陈旧窗。
   * #17：WS 源包 Promise.race timeout（防 pending 永不 settle）。
   */
  async function queryFileSource(sid: string | null, q: string): Promise<SearchItem[]> {
    if (!sid) return [] // AC-4.8 无 session → file 源空
    // #17：WS 超时 race（10s，防 WS 断连 pending 永不 settle 致浮层挂死）
    const nodes = await withWsTimeout(ports.fileCandidates(sid))
    // 复用 composer # 管线：DTO 映射 + 分级匹配过滤+排序（同一套算法）
    const candidates = toFileCandidates(nodes)
    const filtered = filterAndSortFileCandidates(candidates, q)
    return mapFileCandidatesToItems(filtered)
  }

  /** session 源（WS + #17 超时 race + 源内子串过滤）：sessionList 全量跨项目 */
  async function querySessionSource(q: string): Promise<SearchItem[]> {
    // #17：WS 超时 race
    const groups = await withWsTimeout(ports.sessionList())
    const items = mapSessionsToItems(groups)
    // session 源内子串过滤（与 matchFilter 同款，避免后续重复过滤）
    return matchFilter(items, q)
  }

  /**
   * #17 WS 源超时 race（D-023 F-1 漏洞修复）。
   * ws-client.ts onclose 不 reject in-flight pending（pending.ts 无 clear/flush），
   * WS 断连时 pending 永不 settle → allSettled 永不 resolve → 浮层永久 loading 挂死。
   * 本函数对 WS 源包 Promise.race timeout：超时→reject→allSettled settled→分组空态+toast。
   */
  function withWsTimeout<T>(wsCall: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(ports.t('composable.searchUnavailable'))), // AC-17.3
        WS_SOURCE_TIMEOUT_MS,
      )
    })
    return Promise.race([wsCall, timeout]).finally(() => {
      // AC-17.2 资源清理：成功时 clearTimeout（防泄漏，与 AC-8.4 同模式）
      if (timer) clearTimeout(timer)
    })
  }

  // ── DTO 映射（D-025：real 源异构 DTO → SearchItem，参考 lib/file-candidates.ts 模式）──
  function mapCommandsToItems(cmds: UnifiedCommand[]): SearchItem[] {
    return cmds.map((c) => toCommandItem(c))
  }
  /**
   * file 候选（已 filterAndSortFileCandidates 过滤+排序）→ SearchItem 映射。
   * AC-4.7 + D-003：SearchModal 只搜文件不搜目录（composer # 允许目录，两处语义不同——
   * 复用的是匹配+排序算法，非全行为），映射时排除目录（kind==='目录'）。
   * AC-4.7 + D-021：截断 MAX_SEARCH_RESULTS，防大仓库全量结果拖垮渲染。
   */
  function mapFileCandidatesToItems(candidates: FileCandidate[]): SearchItem[] {
    return candidates
      .filter((c) => c.kind !== '目录')
      .slice(0, MAX_SEARCH_RESULTS)
      .map((c) => ({
        type: 'file' as const,
        title: c.basename ?? c.name,
        sub: c.path ?? c.name, // AC-3.1 相对路径展示（非绝对路径）
      }))
  }
  function mapSessionsToItems(groups: SessionGroup[]): SearchItem[] {
    const out: SearchItem[] = []
    for (const g of groups) {
      for (const s of g.sessions) {
        out.push(toSessionItem(s)) // gitBranch 缺失降级（AC-4.1/T4.2）
      }
    }
    return out
  }
  function mapRecentsToItems(entries: { type: SearchItem['type']; title: string; sub: string }[]): SearchItem[] {
    return entries.map((e) => ({ type: e.type, title: e.title, sub: e.sub }))
  }

  function toCommandItem(c: UnifiedCommand): SearchItem {
    if (isAppCommand(c)) {
      // AppCommand：title=name，sub 优先 shortcut 无则 id。commandKind='app' 供 useSearchJump 精确分发
      return { type: 'command', title: c.name, sub: c.shortcut ?? c.id, commandKind: 'app' }
    }
    if (isSessionCommand(c)) {
      // SessionCommand（pi 扩展命令，name 不带 / 前缀如 'goal'/'skill:code-review'）：
      // title=name，sub 优先 description 无则 kind；icon + commandKind 透传给注入侧。
      // commandKind='slash' 是 useSearchJump 区分注入分支的唯一依据（不可靠 title 前缀猜测）。
      // isSkill/location：skill 命令（kind==='skill'，判据与 CommandPopover 的
      // buildPanelSlashCandidates 同源）带出 SKILL.md 路径与类型标记，供搜索注入侧按项类型
      // 分流到 skill 通路（裸名 + location + 多 chip 共存）；非 skill 项两者缺省。
      return {
        type: 'command',
        title: c.name,
        sub: c.description ?? c.kind,
        icon: c.icon,
        commandKind: 'slash',
        isSkill: c.kind === 'skill',
        location: c.sourceInfo?.path,
      }
    }
    // 防御性兜底（不应到达：UnifiedCommand 二选一）
    return { type: 'command', title: String((c as { name?: unknown }).name ?? ''), sub: '' }
  }
  function toSessionItem(s: SessionSummary): SearchItem {
    // T4.2 / D-025 gitBranch 缺失降级：有 gitBranch → `${cwd} · ${gitBranch}`；无 → 仅 cwd
    // 关键：sub 不能含 "undefined"（gitBranch 缺失不应让会话被排除，matchFilter 按 title/sub 子串匹配）
    const sub = s.gitBranch ? `${s.cwd} · ${s.gitBranch}` : s.cwd
    return { type: 'session', title: s.label, sub }
  }

  /** 按类型分组（符号占位 D-001，空组过滤） */
  function groupByType(items: SearchItem[]): Section[] {
    const byType = new Map<SearchItem['type'], SearchItem[]>()
    for (const it of items) {
      const arr = byType.get(it.type) ?? []
      arr.push(it)
      byType.set(it.type, arr)
    }
    const labels: Record<SearchItem['type'], string> = {
      command: ports.t('search.sectionCommand'),
      file: ports.t('search.sectionFile'),
      symbol: ports.t('search.sectionSymbol'),
      session: ports.t('search.sectionSession'),
    }
    const sections: Section[] = []
    for (const t of ['command', 'file', 'symbol', 'session'] as const) {
      if (t === 'symbol') {
        // D-001 符号占位：恒占位 section（始终加入，不被空组过滤，不随查询变化，不参与匹配）
        // 调用方（SearchModal）决定如何渲染空符号分组
        sections.push({ kind: 'symbol', label: labels[t], items: [] })
      } else {
        const its = byType.get(t) ?? []
        if (its.length > 0) sections.push({ kind: t, label: labels[t], items: its })
      }
    }
    return sections
  }

  return { query }
}
