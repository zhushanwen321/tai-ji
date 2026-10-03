/**
 * PS-60 探针：pi session 树重放规则（重启后叶子 = 文件最后一条 entry）（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json PS-60）：SessionManager 加载路径
 * （_setSessionFile → loadEntriesFromFile → _buildIndex）重建内存 leafId =
 * 文件序最后一条非 header entry 的 id；活跃上下文路径 = buildSessionPath 从该叶子
 * 沿 parentId 回溯。承重两处：
 * - ADR-0076 撤回持久化安全——navigateTree 回退后 appendLabelChange 落 LabelEntry
 *   到文件尾（parentId = 回退后 leaf），重启重放叶子的 parentId 链不含被撤子树，
 *   回退不复活；
 * - message-revoke U6a/U6d 文件腿裁剪——taiji trimFileEntriesToActivePath /
 *   computeActivePathEntries 取文件尾 entry id 回溯，与 pi 重放语义同构全靠本条。
 *
 * 断言方式（P-D1 代码形态断言）：静态直读 dist/core/session-manager.js 与
 * dist/core/agent-session.js 的方法/函数窗口，关键代码片段存在性 + 次序断言，
 * 失真即红（重放准则改形 = 撤回可能复活/文件腿裁剪错叶，ADR-0076 降级路径 P1
 * 触发评估）。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-session-replay.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const SM_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'session-manager.js'), 'utf-8') : ''
const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

/** 模块级函数窗口：header 起到下一个列 0 闭括（`\n}`）止；找不到下界截 3000 字符兜底。 */
function moduleFnWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const end = text.indexOf('\n}', start + header.length)
  return end === -1 ? text.slice(start, start + 3000) : text.slice(start, end)
}

describe.skipIf(!PI_DIST)(
  `PS-60 探针：树重放规则——加载后 leafId = 文件尾非 header entry（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('_buildIndex：文件序循环遍历 this.fileEntries，跳过 session header 后逐条赋 leafId（终值 = 最后一条非 header entry）', () => {
      const win = methodWindow(SM_SRC, '_buildIndex() {')
      expect(win, 'PS-60 漂移：_buildIndex 方法消失/改名——重放建索引改形，复核 PS-60').not.toBe('')
      const loopIdx = win.indexOf('for (const entry of this.fileEntries)')
      expect(
        loopIdx,
        'PS-60 漂移：_buildIndex 不再按文件序遍历 fileEntries——重放准则变化（按持久化指针？），复核 PS-60（撤回复活风险）',
      ).toBeGreaterThanOrEqual(0)
      const headerSkipIdx = win.indexOf('if (entry.type === "session")')
      expect(
        headerSkipIdx,
        'PS-60 漂移：header 跳过判定消失——header 会被当作叶子/树节点，复核 PS-60',
      ).toBeGreaterThan(loopIdx)
      const assignIdx = win.indexOf('this.leafId = entry.id')
      expect(
        assignIdx,
        'PS-60 漂移：循环内 leafId 赋值形态消失——叶子不再是「文件序最后一条」，复核 PS-60',
      ).toBeGreaterThan(headerSkipIdx)
    })

    it('_setSessionFile（resume/branching 加载路径）：loadEntriesFromFile 装载文件后经共享 _loadEntries 调 _buildIndex', () => {
      const win = methodWindow(SM_SRC, '_setSessionFile(sessionFile, preloadedFileEntries) {')
      expect(win, 'PS-60 漂移：_setSessionFile 方法消失/改签名——加载路径改形，复核 PS-60').not.toBe('')
      const loadIdx = win.indexOf('loadEntriesFromFile(this.sessionFile)')
      expect(
        loadIdx,
        'PS-60 漂移：加载路径不再经 loadEntriesFromFile 读全文件——复核 PS-60（文件腿裁剪喂数前提）',
      ).toBeGreaterThanOrEqual(0)
      // pi 1.0.0 起「装载 + 建索引」抽成共享 _loadEntries（构造器 preloaded 分支与本路径共用），
      // _buildIndex 移入其中尾部——链式两跳断言：_setSessionFile → _loadEntries → _buildIndex
      const loadEntriesIdx = win.indexOf('this._loadEntries(entries)')
      expect(
        loadEntriesIdx,
        'PS-60 漂移：加载路径不再经共享 _loadEntries 装载——装载链改形，复核 PS-60',
      ).toBeGreaterThan(loadIdx)
      const loadWin = methodWindow(SM_SRC, '_loadEntries(entries, options) {')
      expect(
        loadWin.includes('this._buildIndex()'),
        'PS-60 漂移：_loadEntries 末尾不再调 _buildIndex——重放不发生或换了准则，复核 PS-60',
      ).toBe(true)
    })

    it('buildSessionPath：从叶子沿 parentId 回溯到根；leaf 缺失兜底 = entries 末条', () => {
      const win = moduleFnWindow(SM_SRC, 'function buildSessionPath(entries, leafId, byId)')
      expect(win, 'PS-60 漂移：buildSessionPath 函数消失/改签名——活跃路径构造改形，复核 PS-60').not.toBe('')
      expect(
        win.includes('leaf ??= entries[entries.length - 1]'),
        'PS-60 漂移：leaf 缺失兜底不再是数组末条——兜底语义变化，复核 PS-60',
      ).toBe(true)
      expect(
        win.includes('current.parentId ? index.get(current.parentId) : undefined'),
        'PS-60 漂移：parentId 回溯形态消失——路径构造不再沿父链，复核 PS-60',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-60 探针：撤回持久化链——追加恒推进叶子 + navigateTree 两步形态（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('_appendEntry：追加即置 leafId = entry.id（运行时不变量：叶子恒 = 文件尾）', () => {
      const win = methodWindow(SM_SRC, '_appendEntry(entry) {')
      expect(win, 'PS-60 漂移：_appendEntry 方法消失/改名——复核 PS-60').not.toBe('')
      expect(
        win.includes('this.fileEntries.push(entry)'),
        'PS-60 漂移：追加不再 push 进 fileEntries（文件尾）——复核 PS-60',
      ).toBe(true)
      expect(
        win.includes('this.leafId = entry.id'),
        'PS-60 漂移：追加不再推进 leafId——叶子≠文件尾，taiji 文件腿裁剪取尾将错叶，复核 PS-60',
      ).toBe(true)
    })

    it('appendLabelChange：LabelEntry 以 parentId = 当前 leaf 落文件尾（撤回锚落尾的前提）', () => {
      const win = methodWindow(SM_SRC, 'appendLabelChange(targetId, label) {')
      expect(win, 'PS-60 漂移：appendLabelChange 方法消失/改签名——复核 PS-60').not.toBe('')
      expect(
        win.includes('parentId: this.leafId'),
        'PS-60 漂移：LabelEntry 不再挂当前 leaf 下——撤回锚不再落活跃路径尾部，重启后回退可能复活，复核 PS-60（ADR-0076）',
      ).toBe(true)
    })

    it('branch：仅移内存指针（this.leafId = branchFromId），窗口内不重写文件', () => {
      const win = methodWindow(SM_SRC, 'branch(branchFromId) {')
      expect(win, 'PS-60 漂移：branch 方法消失/改签名——树内回退形态变化，复核 PS-60').not.toBe('')
      expect(
        win.includes('this.leafId = branchFromId'),
        'PS-60 漂移：branch 不再移动 leafId 指针——回退机制改形，复核 PS-60（ADR-0076）',
      ).toBe(true)
      expect(
        win.includes('_rewriteFile'),
        'PS-60 漂移：branch 开始重写文件——append-only 前提被破坏（被撤内容物理删除？），复核 PS-60 与 ADR-0076 审计保留前提',
      ).toBe(false)
    })

    it('navigateTree（agent-session.js）：无摘要时 branch(newLeafId) 移指针 + label && !summaryText 时 appendLabelChange 落锚', () => {
      const win = methodWindow(SESSION_SRC, 'async navigateTree(targetId, options = {}) {')
      expect(win, 'PS-60 漂移：navigateTree 方法消失/改签名——ADR-0076 撤回机制整体重审（降级路径 P1）').not.toBe('')
      expect(
        win.includes('this.sessionManager.branch(newLeafId)'),
        'PS-60 漂移：navigateTree 不再经 branch 移指针——回退实现改形，复核 PS-60 与 ADR-0076',
      ).toBe(true)
      const guardIdx = win.indexOf('if (label && !summaryText)')
      expect(
        guardIdx,
        'PS-60 漂移：label 落锚的守卫形态（label && !summaryText）消失——复核 PS-60',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.indexOf('this.sessionManager.appendLabelChange(targetId, label)'),
        'PS-60 漂移：navigateTree 不再 appendLabelChange 落锚（或换锚形态）——撤回锚落文件尾前提失效，复核 PS-60（ADR-0076）',
      ).toBeGreaterThan(guardIdx)
    })

    it('sessionEntryToContextMessages：label 类型不在投影分支内（落文件尾的撤回锚不进 LLM 上下文）', () => {
      const win = moduleFnWindow(SM_SRC, 'export function sessionEntryToContextMessages(entry)')
      expect(win, 'PS-60 漂移：sessionEntryToContextMessages 函数消失/改签名——复核 PS-60').not.toBe('')
      for (const t of ['message', 'custom_message', 'branch_summary', 'compaction']) {
        expect(
          win.includes(`entry.type === "${t}"`),
          `PS-60 漂移：投影分支 ${t} 消失——entry 投影词表变化，复核 PS-60`,
        ).toBe(true)
      }
      expect(
        win.includes('entry.type === "label"'),
        'PS-60 漂移：label 类型开始投影为 LLM 消息——撤回锚将进入模型上下文，复核 PS-60 与 ADR-0076',
      ).toBe(false)
      expect(
        win.includes('return [];'),
        'PS-60 漂移：非投影类型的 return [] 兜底消失——投影词表改形，复核 PS-60',
      ).toBe(true)
    })
  },
)
