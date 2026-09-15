/**
 * search-jump —— 选中项跳转编排（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useSearchJump.ts（166 行），语义逐条等价。
 * C-NT-3 裁决：command 分支（app/slash 分发）保留（command store 域内访问）、file 分支
 * fileApi.read 经 FileReadPort 注入（deps.ports.fileRead）、fileTreeStore.selectFile 经
 * FileTreePort.selectFile 注入（deps.fileTree）、session 分支 sessionApi.list 经
 * SessionListPort 注入（deps.ports.sessionList）+ selectSession 经 SessionSelectPort 注入
 * （deps.ports.selectSession，C-W3-2）。JumpResult.drawerTab 意图返回（'detail'）保持——
 * 本域只返跳转意图，接收点（SearchModal）据 drawerTab 打开 SideDrawer。
 *
 * 数据流：SearchModal.confirmSel → confirm(item, ctx) → type switch →
 *   command: AppCommand → commandStore 取 action 执行；
 *            slash 命令 → commandStore.requestSlashInjection 写一次性通道（Composer watch 消费调 insertSlashChip）
 *   file: 直调 fileRead（AC-6.9 不经 useDetailPane 的预览加载吞错层）→ 成功后 selectFile 触发 useDetailPane watch 链渲染
 *   session: selectSession（id 经 sessionList 按 title 反查，因 SearchItem 无 id 字段）
 *   symbol: 占位不跳转（D-001）
 * → useRecents.write + 返回 JumpResult（AC-6.7：成功才关浮层，失败浮层保持打开）
 *
 * 失败路径（AC-6.5/6.6/6.8/6.9）：
 *  - command action 抛错 → {ok:false} + toast + 浮层保持打开（AC-6.8）
 *  - file.read reject → {ok:false} + toast + 浮层保持打开（AC-6.5/6.9，直调不经吞错层）
 *  - session.switch reject / id 反查失败 → {ok:false} + toast + 浮层保持打开（AC-6.6）
 *
 * 职责分离：本编排只返 JumpResult，不直接 toast（toast 由 SearchModal 据 ok===false 触发）。
 */
import type { SearchItem, JumpCtx, JumpResult, RecentEntry } from './types'
import { useRecents } from './recents'
import type { SearchDeps } from './search-ports'

export function useSearchJump(deps: SearchDeps) {
  const { ports } = deps
  const recents = useRecents(deps.storage)

  /**
   * 确认跳转（按 item.type switch 分发）。
   * AC-6.7 异常恢复：先 await 成功再关浮层（调用方据 JumpResult.ok 决定关否），失败浮层保持打开让用户重选。
   */
  async function confirm(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    switch (item.type) {
      case 'command':
        return confirmCommand(item, ctx)
      case 'file':
        return confirmFile(item, ctx)
      case 'session':
        return confirmSession(item)
      case 'symbol':
        // D-001 占位不跳转（不调任何 domain/store）
        return { ok: false, error: ports.t('search.symbolUnavailable') }
    }
  }

  /**
   * command 分支：按 commandKind 区分应用命令 vs slash 命令（不靠 title 前缀猜测）。
   * - 应用命令（commandKind='app'）：commandStore.appCommands 找 name 匹配项，调 cmd.action()（AC-6.8 action 抛错→{ok:false}）
   * - slash 命令（commandKind='slash'）：commandStore.requestSlashInjection 写一次性通道，Composer watch 消费（landing 态也放行，sessionId 透传 null）
   */
  async function confirmCommand(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    try {
      if (item.commandKind === 'slash') {
        // slash 命令注入 composer：写 commandStore.pendingSlash 一次性通道。
        // landing 态（ctx.activeSessionId=null）也放行——landing composer 存在，sessionId 透传 null
        // 供消费侧 Composer 按 sessionId 过滤（双方 null 命中 landing composer）。
        // icon 从 item.icon 透传（保证搜索注入 chip 与 CommandPopover 选中 chip 图标一致）。
        // isSkill/location 同透传（SearchItem ← SessionCommand 映射带出）：消费侧据此把 skill
        // 项分流到 insertSkillChip（裸名 + location + 多 chip 共存），否则维持 insertSlashChip。
        deps.commandStore.requestSlashInjection({
          command: item.title,
          icon: item.icon,
          sessionId: ctx.activeSessionId,
          isSkill: item.isSkill,
          location: item.location,
        })
      } else {
        // 应用命令：commandStore.appCommands 取 action 执行
        const cmd = deps.commandStore.appCommands.value.find((c) => c.name === item.title)
        if (!cmd) {
          return { ok: false, error: ports.t('search.commandNotFound', { title: item.title }) }
        }
        cmd.action() // AC-6.8：action 抛错由 catch 捕获
      }
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      // AC-6.8：action 抛错 → {ok:false,error}
      return { ok: false, error: (e as Error)?.message ?? ports.t('search.commandExecFailed') }
    }
  }

  /**
   * file 分支（AC-6.9 关键约束）：直调 fileRead 校验，不经 useDetailPane 的预览加载吞错层。
   * useDetailPane 的预览加载方法现状 try/catch 吞错（设 status='error' 不抛），致本编排层 catch 永不触发，
   * AC-6.5 假性 PASS。read 成功后调 fileTree.selectFile(path) 触发 useDetailPane 的
   * watch([selectedPath, sessionId]) 链自动渲染（渲染靠 store 响应式驱动，错误已由直调 read 捕获）。
   */
  async function confirmFile(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    const sid = ctx.activeSessionId
    try {
      // AC-6.9：直调 fileRead（不经 useDetailPane 预览吞错层），reject 真冒泡
      await ports.fileRead(item.sub, sid ?? undefined)
      // read 成功后：selectFile(path) 设置 selectedPath → useDetailPane watch 链自动渲染（绕过吞错层直调）
      deps.fileTree.selectFile(item.sub)
      writeRecent(item)
      // drawerTab:'detail' 提示调用方（SearchModal）打开 SideDrawer detail tab——
      // DetailPane 只在 activeTab==='detail' 时挂载，selectFile 单独设置 selectedPath 无法触发渲染。
      // 对比 FileTreeRow.onSelectFile：selectFile(path) + drawer.open('detail') 双步，此处同构。
      return { ok: true, drawerTab: 'detail' }
    } catch (e) {
      // AC-6.5：file.read reject → {ok:false}（直调使 reject 真冒泡，不经吞错层）
      return { ok: false, error: (e as Error)?.message ?? ports.t('search.fileOpenFailed') }
    }
  }

  /**
   * session 分支：selectSession(id)。
   *
   * id 反查（SearchItem 无 id 字段，DTO 映射时丢了）：session 跳转需 session id，
   * 但 SearchItem 只有 title/sub。优先复用 sessionList() 按 title（session.label）反查 id，
   * 命中后调 selectSession(id)。反查未命中 / switch reject → {ok:false}（AC-6.6）。
   *
   * 备注：selectSession 内部已对 switchSession reject 抛错（mock id 不存在时），错误在此 catch。
   */
  async function confirmSession(item: SearchItem): Promise<JumpResult> {
    try {
      const id = await resolveSessionId(item.title)
      if (!id) {
        return { ok: false, error: ports.t('search.sessionNotFound', { title: item.title }) }
      }
      await ports.selectSession(id) // AC-6.6：switchSession reject 抛错由 catch 捕获
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      // AC-6.6：session.switch reject → {ok:false,error}
      return { ok: false, error: (e as Error)?.message ?? ports.t('search.sessionSwitchFailed') }
    }
  }

  /**
   * 按 title（session.label）反查 session id。
   * sessionList() 返回 SessionGroup[]，扁平化后按 label 匹配取 id。
   */
  async function resolveSessionId(label: string): Promise<string | null> {
    const groups = await ports.sessionList()
    for (const g of groups) {
      for (const s of g.sessions) {
        if (s.label === label) return s.id
      }
    }
    return null
  }

  /** 写 recents（AC-6.4 副作用，跳转成功后；async fire-and-forget，C-W3-4） */
  function writeRecent(item: SearchItem): void {
    const entry: RecentEntry = {
      type: item.type,
      key: `${item.type}:${item.title}`, // AC-3.5 key 规则
      timestamp: Date.now(), // recents.write 内部会做 Math.max+1 兜底（AC-3.6）
      title: item.title,
      sub: item.sub,
    }
    void recents.write(entry)
  }

  return { confirm }
}
