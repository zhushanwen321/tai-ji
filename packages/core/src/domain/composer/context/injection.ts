/**
 * useComposerInjection —— Composer 侧消费 drawer 注入请求（target 路由 + file chip 注入）。
 *
 * ## 职责
 * watch injectionStore.pendingInjection：
 * 1. target='new'（仅 session composer 触发）→ 调 deps.startFlow(cwd) 进 landing
 *    → store.routeToLanding()（把 target 改 current + sessionId=null）→ 本实例不注入
 *    （landing composer 接手阶段二）
 * 2. target='current' → 按目标侧判定匹配 → applyInjection（session/file chip 或纯文本）→ clearInjection
 *
 * ## 目标侧匹配（FR-2.1）
 * landing composer 的 sessionId 可能为 null（W3 移除公共 session 后，Landing.vue 的 composerSid
 * 无公共 session fallback，真 landing 态为 null），不能用 sessionId=null 匹配 landing。改用 **variant** 判定：
 * - variant='landing'：消费 target=current 且 sessionId=null 的请求（routeToLanding 改写后）
 * - variant='panel'：消费 target=current 且 sessionId===当前 session 的请求
 * target=new 的原始请求（未 routeToLanding 前）只被 session composer 触发 startFlow，
 * 不被任何 composer 直接消费（避免 session composer 误注）。
 *
 * ## target='new' 两阶段时序
 * 阶段一（session composer）：watch 收到 target=new → startFlow → routeToLanding
 *   （store 把 target 改 current + sessionId=null）→ 本实例 variant=panel 且 sessionId≠null → 不匹配 → 不注入
 * 阶段二（landing composer 挂载）：onMounted 补检查遗留请求（此时 target=current，
 *   sessionId=null）→ variant=landing 匹配 → insertFileChip → clearInjection
 *
 * routeToLanding 重置 ts 是关键：让已挂载的 landing composer watch 也能被触发。
 * onMounted 补检查覆盖「landing composer 挂载早于 routeToLanding」，watch 覆盖「晚于」。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerInjection.ts。改动：
 * - 去掉 renderer 跨域依赖（useComposerInjectionStore/useSessionStore/useNewTaskFlow 3 个），
 *   改为经 deps 注入（injectionStore/startFlow/getSessionCwd/getActiveSessionId），core 零 store 依赖。
 * - ComposerInput.vue 实例类型改用局部 ComposerInputInstance 结构类型（insertFileChip/insertTextAtCursor/
 *   focus），与 input/types.ts 的完整实例契约互补——壳层 ComposerInput.vue 的 defineExpose 同时满足两者。
 * - injectionStore 改为 factory 返回的 ref 实例（不经 pinia 自动 unwrap），所有 pendingInjection
 *   访问显式 `.value`（watch source / 引用相等判定 / onMounted 读取）。
 * - 注意：deps 设 4 字段（非 task 规格 3 字段）。补 getActiveSessionId 因 consume 的 target=new 分支
 *   需判定「仅活跃 session 的 panel composer 触发 startFlow」（review M2 防护，避免 dual 挂载多 panel
 *   误拆活跃 session），byte-level 保持该防护必须此依赖。
 * 路由矩阵 byte-level 保持。
 */
import { onMounted, watch, type Ref } from 'vue'
import type { ComposerInjectionStore, PendingInjection } from './injection-store'

// 本模块消费面（focus / insertSessionChip? / insertTextAtCursor / insertFileChip）全部在
// 域级权威接口 ComposerInputInstance（../types，ADR-0058 归位）之内，直接消费权威接口，
// 不再局部窄契约——与 send/submit/context-chips 的局部最小契约（dispatch 消费面字段不在
// 权威接口内）是两种互补形态，非漂移。
import type { ComposerInputInstance } from '../types'

/** useComposerInjection 的注入依赖（壳层 Composer 从各 store/composable 派生后注入）。 */
export interface InjectionDeps {
  /** composer injection store（pendingInjection/clearInjection/routeToLanding 经此访问） */
  injectionStore: ComposerInjectionStore
  /** 进 landing 流程（壳层从 useNewTaskFlow().startFlow 取，target=new 时触发） */
  startFlow: (cwd?: string) => Promise<void>
  /** 按 sessionId 查 cwd（壳层从 sessionStore.list.find 派生，target=new 时 startFlow 预设） */
  getSessionCwd: (sessionId: string) => string | undefined
  /**
   * 取当前活跃 session id（壳层从 sessionStore.active?.id 派生）。
   * target=new 分支判定「仅活跃 session 的 panel composer 触发 startFlow」，
   * 避免 dual 挂载（landing+panel）时多个 panel composer 都触发 startFlow 误拆活跃 session（review M2）。
   */
  getActiveSessionId: () => string | null
}

/**
 * @param inputRef ComposerInput 实例 ref（insertFileChip/insertTextAtCursor/focus 经 defineExpose 暴露）
 * @param sessionId 当前 session id ref（target=current 匹配用）
 * @param variant composer 变体（'panel' | 'landing'，目标侧判定用）
 * @param deps injectionStore/startFlow/getSessionCwd/getActiveSessionId（壳层注入）
 */
export function useComposerInjection(
  inputRef: Ref<ComposerInputInstance | null>,
  sessionId: Ref<string | null>,
  variant: Ref<'panel' | 'landing'>,
  deps: InjectionDeps,
): void {
  const store = deps.injectionStore

  /** 取注入用 cwd：target=new 时 startFlow 预设。用当前 session 的 cwd，无则 undefined。 */
  function resolveCwdForNewSession(): string | undefined {
    if (!sessionId.value) return undefined
    return deps.getSessionCwd(sessionId.value) ?? undefined
  }

  /**
   * 执行注入（session chip / file chip / 纯文本）。
   * - 有 refSessionId → insertSessionChip（四符号体系 §3.3.4 sidebar 直引，显示 label 非 uuid）
   * - 有 text → insertTextAtCursor（Phase 4 联动 1：TerminalView 选区「发给 AI」）
   * - 有 path → insertFileChip（file chip + 可选行范围）
   * refSessionId / path / text 三互斥（store schema 保证），refSessionId 优先判断。
   */
  function applyInjection(req: {
    path?: string
    lineStart?: number
    lineEnd?: number
    text?: string
    refSessionId?: string
    label?: string
  }): void {
    const input = inputRef.value
    if (!input) return
    input.focus()
    // session chip 注入（§3.3.4 sidebar 直引）
    if (req.refSessionId !== undefined) {
      // label 兜底 refSessionId：写入侧漏传 label 时 chip 不显示空串（uuid 也可读）
      input.insertSessionChip?.(req.refSessionId, req.label ?? req.refSessionId)
      return
    }
    // text 注入（Phase 4 联动 1）
    if (req.text !== undefined) {
      input.insertTextAtCursor(req.text)
      return
    }
    // file chip 注入（原有路径）
    if (req.path !== undefined) {
      const lineRange =
        req.lineStart !== undefined && req.lineEnd !== undefined
          ? ([req.lineStart, req.lineEnd] as [number, number])
          : undefined
      input.insertFileChip(req.path, lineRange)
    }
  }

  /**
   * 消费注入请求（target 路由 + 匹配 + 注入）。抽出供 watch 和 onMounted 复用。
   * 返回 true 表示已消费（注入或路由），false 表示不匹配（留给其他 composer）。
   */
  async function consume(req: PendingInjection): Promise<boolean> {
    if (req.target === 'new') {
      if (variant.value === 'landing') {
        // landing composer 已挂载（用户已在 landing 态）→ 直接消费，不需 startFlow。
        // 覆盖「landing composer 先于注入请求存在」的时序（用户停在 landing，从 drawer 注入新对话）。
        applyInjection(req)
        store.clearInjection()
        return true
      }
      // 阶段一：session composer 触发 startFlow + routeToLanding（store 把 target 改 current）。
      // 仅当前 session 是活跃 session 时才 startFlow——避免 dual 挂载（landing+panel）时
      // 多个 panel composer 都触发 startFlow 误拆活跃 session（review M2）。
      // landing composer 若也挂载会直接消费 target=new（上方分支），但 routeToLanding 改写后
      // 它看到 target=current；panel 这里只做路由触发，不注入。
      if (sessionId.value !== deps.getActiveSessionId()) return false
      const cwd = resolveCwdForNewSession()
      try {
        await deps.startFlow(cwd)
      } catch {
        // startFlow 失败（如 landing 已占用 / 创建 session 失败）：清空占位请求，
        // 否则 pendingInjection 残留永久占槽位，后续注入被误判为「阶段二遗留」误消费（W8）。
        // 仅当本次请求未被新请求覆盖时才清（覆盖时新请求自己管生命周期）。
        if (store.pendingInjection.value === req) store.clearInjection()
        return true
      }
      // 竞态防护：await 期间若 pendingInjection 被新请求覆盖（用户连续点注入），
      // 不再 routeToLanding（新请求会自己走 watch 流程）。引用相等 = 未被覆盖。
      if (store.pendingInjection.value !== req) return true
      store.routeToLanding()
      return true
    }
    // target='current'：按 variant + sessionId 匹配
    // landing composer：消费 sessionId=null 的请求（routeToLanding 改写后，阶段二）
    if (variant.value === 'landing') {
      if (req.sessionId !== null) return false
      applyInjection(req)
      store.clearInjection()
      return true
    }
    // panel composer：消费 sessionId 匹配当前 session 的请求
    if (req.sessionId !== sessionId.value) return false
    applyInjection(req)
    store.clearInjection()
    return true
  }

  watch(
    () => store.pendingInjection.value,
    (req) => {
      if (!req) return
      // consume 内部应自处理错误；此处 catch 兜底防 watch 回调 reject 漏成 unhandled rejection。
      void consume(req).catch(() => {
        /* consume 内部应自处理错误 */
      })
    },
  )

  /**
   * 挂载时检查遗留注入请求（target='new' 阶段二 + 组件重建的遗留 target=current）。
   *
   * landing composer 挂载时，遗留请求的 target 可能已被 routeToLanding 改成 current
   * （阶段一已完成）。组件重建（panel 切换）时，target=current 的遗留请求若匹配也补消费。
   */
  onMounted(() => {
    const req = store.pendingInjection.value
    if (!req) return
    // 仅消费 target=current 的遗留请求（target=new 的阶段一由 session composer 触发，
    // landing composer 首次挂载若看到原始 target=new 说明阶段一未执行，不在此触发 startFlow）
    if (req.target !== 'current') return
    consume(req).catch(() => {
      /* consume 内部应自处理错误，此处兜底防 unhandled rejection */
    })
  })
}
