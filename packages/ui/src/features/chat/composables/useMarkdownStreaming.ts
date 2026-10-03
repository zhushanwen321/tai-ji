/**
 * useMarkdownStreaming —— MarkdownRenderer 的 D-5 增量流式渲染状态机（从 MarkdownRenderer.vue
 * 拆出：vue_rules_checker 的 <script setup> ≤300 行上限处方「提取 composable」，W23 review 修复
 * 叠加后组件 script 超限。本文件是原组件内逻辑的零行为迁移，测试覆盖见
 * __tests__/MarkdownRenderer.test.ts 与 renderer markdown-renderer-incremental.test.ts）。
 *
 * 职责（markdown 流式消费编排，展示层不感知）：
 * - 渲染模式：deps.renderMarkdownIncremental（前缀段引用恒等缓存 + tail 段每帧重建 +
 *   streaming-fence 占位，D-5/W23）。
 * - rAF trailing 节流（H2）：每帧多次 content 变化合并为单次渲染；序号守卫防旧覆盖；
 *   失败降级转义纯文本（console.error 出声，不静默）+ 增量缓存作废重建。
 * - latest-wins 串行（W23）：增量缓存是单个可变对象（W22 原地更新），并发调用会交叉改写
 *   （旧渲染 resume 后按陈旧 boundary 追加 → 前缀段重复，append-only 校验对「重复但文本一致」
 *   无法自愈）→ in-flight 期间新请求合并为待执行项（queuedRender 覆盖），完成后只跑最新一条。
 * - streaming-fence 占位 finalize（D-5/W23，R-20）：未闭合 fence 流式期不跑 shiki/mermaid，
 *   静默 ≥阈值（deps.streamingFenceSilenceMs）或消息 complete（props.streaming 翻 false）后
 *   finalizeOpenFence:true 转完整渲染；tail 含占位且未完成时每帧重排静默定时器。
 * - silence-finalize 粘滞（W23 review Fix-1）：已 finalize 的 open fence 在新 token 到达后
 *   保持 finalize=true 不回占位横跳——「静默 ≥阈值 → finalize 转完整代码块 → 新 token 到达
 *   silenceMs≈0 → finalize=false → 占位回归（已渲染代码从屏幕消失）→ 再静默又完整」每次
 *   「停顿后继续」横跳的修复。协议（IncrementalMarkdownResult）不暴露 openFence offset，
 *   用内容前缀等价判据：流式 content 只会 append，finalize 快照的前缀未变则保持 finalize，
 *   改写/清空即解除。代价：粘滞期间同消息后续新开 fence 不再走占位（闭合 fence 渲染与
 *   finalize 无关、输出相同，仅损失占位优化，无正确性影响）。
 * - 生命周期：实例生命周期与所属消息的组件子树一致——同一条消息流式期间跨 content 变化
 *   保活（增量缓存持续累积），卸载即弃。无跨 session 残留的依据不是本 composable 自身机制，
 *   而是壳层 MessageStream 的 <Virtualizer :key="sessionId">（session 切换整树强制重建）
 *   （对比 TurnRenderCache 需 per-session 分区——MessageStream 实例不随 session 销毁，ADR-0049）。
 *   卸载（onScopeDispose，W23 review Fix-3）：置 disposed 短路 in-flight 结果应用与 finally
 *   分支的 queued 消费/timer 重挂 + 丢弃 queued + 取消 pending rAF + 清 finalize 定时器。
 *
 * 不含：段 DOM 渲染/复制按钮/歧义文件浮层（展示关注点，留 MarkdownRenderer.vue）。
 */
import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ChatViewDeps } from '../chat-view-deps'
import type { IncrementalMarkdownCache, MarkdownSegment } from '../markdown-types'

/** HTML 特殊字符转义（渲染失败降级路径用）：deps 抛错时把原始 content 转义后作为单个
 *  text segment 回填——保证消息气泡可读。 */
function escapeHtmlForFallback(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * streaming-fence finalize 判定（纯函数，状态写回由调用方负责）：
 * 显式判定（forceFinalize / complete / 静默 ≥ deps.streamingFenceSilenceMs 阈值——审计
 * 候选 18 收单阈值字段，原壳层谓词生产实现即此公式）叠加
 * silence-finalize 粘滞（W23 review Fix-1）：已 finalize 的 open fence 在新 token 到达后
 * 保持完整渲染，不回占位横跳——「静默 ≥阈值 → finalize 转完整代码块 → 新 token 到达
 * silenceMs≈0 → finalize=false → 占位回归（已渲染代码从屏幕消失）→ 再静默又完整」每次
 * 「停顿后继续」横跳的修复。协议（IncrementalMarkdownResult）不暴露 openFence offset，
 * 用内容前缀等价判据：流式 content 只会 append，finalize 快照的前缀未变则保持 finalize，
 * 改写/清空即解除（stickyAfter 置 null）。代价：粘滞期间同消息后续新开 fence 不再走占位
 * （闭合 fence 渲染与 finalize 无关、输出相同，仅损失占位优化，无正确性影响）。
 *
 * html-preview 分流（chat-html-support §6.3 D3 流式形态）：fenceLang = 上一帧结果的未闭合
 * fence 语言名（useMarkdownStreaming 持有）。首词为 html-preview 时静默/强制提前 finalize
 * 不生效——路径载荷是原子语义，半截路径只会产出假降级卡片；只由 fence 收尾标记到达 /
 * 消息 complete 触发（complete 已在上方判定成立，fence 收尾后 openFence 消失、finalize
 * 不再参与尾段形态）。mermaid / 代码 fence 的静默提前 finalize 行为不变。
 */
function isHtmlPreviewFence(lang: string | null): boolean {
  return (lang ?? '').toLowerCase() === 'html-preview'
}

function resolveStreamingFinalize(
  text: string,
  opts: { forceFinalize?: boolean } | undefined,
  complete: boolean,
  silenceMs: number,
  silenceThresholdMs: number,
  currentSticky: string | null,
  fenceLang: string | null,
): { finalize: boolean; stickyAfter: string | null } {
  let finalize =
    opts?.forceFinalize === true || complete || silenceMs >= silenceThresholdMs
  let stickyAfter = currentSticky
  if (!finalize && currentSticky !== null) {
    if (text.startsWith(currentSticky)) finalize = true
    else stickyAfter = null
  }
  // html-preview 分流（见函数头注释）：未 complete 时不得提前 finalize
  if (finalize && !complete && isHtmlPreviewFence(fenceLang)) finalize = false
  // finalize 发生且消息未完成 → 记录粘滞快照（complete 天然逐帧 finalize，无需粘滞）
  if (finalize && !complete) stickyAfter = text
  return { finalize, stickyAfter }
}

/** 从尾段回读未闭合 fence 语言名（占位段的 lang 即 scan.openFence 首词）；无占位 → null */
function readOpenFenceLang(tailSegments: MarkdownSegment[]): string | null {
  const fenceSeg = tailSegments.find((s) => s.type === 'streaming-fence')
  return fenceSeg?.lang ?? null
}

export function useMarkdownStreaming(
  props: { content: string; sessionId?: string | null; streaming?: boolean },
  deps: ChatViewDeps,
): { segments: Ref<MarkdownSegment[]> } {
  const segments = ref<MarkdownSegment[]>([])
  let renderSeq = 0

  // ── D-5 增量渲染状态（W23）──
  // 前缀缓存是 opaque 句柄（创建/原地更新都在壳的 renderIncremental 内），本 composable 只持有透传。
  let incrementalCache: IncrementalMarkdownCache | null = null
  /** 上次 content 变化时刻（streaming-fence 静默判定基准 = 距上一 token 到达的时长） */
  let lastContentAt = 0
  /** streaming-fence 占位的静默 finalize 定时器（fence 闭合前 token 停止时转完整渲染） */
  let fenceFinalizeTimer: ReturnType<typeof setTimeout> | null = null
  /** silence-finalize 粘滞快照（W23 review Fix-1）：finalize 帧的 content 快照，非 null 表示
   *  该消息流中某个未闭合 fence 已被 finalize 过。后续帧 content 仍是快照的 append-only 延长
   *  （同一消息流）时保持 finalize=true（见文件头「粘滞」段）。 */
  let finalizedStickyPrefix: string | null = null
  /** 最近一帧结果里未闭合 fence 的语言名（finalize 分流依据，§6.3 D3）：首词为 html-preview
   *  时静默提前 finalize 不生效。null = 无未闭合 fence（或尚未渲染）。 */
  let openFenceLang: string | null = null
  /** 卸载标志（W23 review Fix-3）：短路 in-flight 渲染结果应用与 finally 分支的 queued 消费 */
  let disposed = false

  // ── H2 流式 markdown 渲染 rAF trailing 节流 ──
  // 每个 text_delta token 触发 watch → 增量渲染。rAF trailing 把一帧内
  // 多次 content 变化合并为单次渲染，消除流式卡顿。D-5 增量渲染（前缀缓存 + tail 段）叠加在该
  // 节流之上：每帧渲染的只是稳定边界之后的 tail。
  let rafId: number | null = null
  let pendingContent = ''

  /**
   * 实际执行 markdown 渲染（D-5 增量消费，W23）——latest-wins 串行入口（见文件头「串行」段）。
   */
  let renderInFlight = false
  let queuedRender: { text: string; opts?: { forceFinalize?: boolean } } | null = null

  function doRender(text: string, opts?: { forceFinalize?: boolean }): void {
    if (renderInFlight) {
      queuedRender = { text, opts }
      return
    }
    renderInFlight = true
    void runRender(text, opts).finally(() => {
      renderInFlight = false
      // 卸载后不消费 queued（W23 review Fix-3）：in-flight 完成时组件可能已 dispose
      if (!disposed && queuedRender) {
        const next = queuedRender
        queuedRender = null
        doRender(next.text, next.opts)
      }
    })
  }

  /**
   * 渲染执行体（编排）：空文本重置 → 序号取号 → 增量渲染（D-5）→ 失败降级。
   * 序号守卫 + 失败降级转义纯文本语义在 runIncrementalRender / handleRenderFailure。
   */
  async function runRender(text: string, opts?: { forceFinalize?: boolean }): Promise<void> {
    if (disposed) return
    if (!text.trim()) {
      resetForEmptyText()
      return
    }
    const seq = ++renderSeq
    try {
      await runIncrementalRender(deps.renderMarkdownIncremental, text, opts, seq)
    } catch (e) {
      handleRenderFailure(e, text, seq)
    }
  }

  /** 空文本重置：清段 + 作废增量缓存与粘滞快照 + 撤销未触发的 fence finalize 定时器 */
  function resetForEmptyText(): void {
    segments.value = []
    incrementalCache = null
    finalizedStickyPrefix = null
    openFenceLang = null
    clearFenceFinalizeTimer()
  }

  /** 增量路径（D-5/W23）：finalize 判定（含粘滞 + html-preview 分流）→ 壳增量渲染 →
   *  序号守卫应用 + 重排 finalize 定时器 */
  async function runIncrementalRender(
    renderIncremental: ChatViewDeps['renderMarkdownIncremental'],
    text: string,
    opts: { forceFinalize?: boolean } | undefined,
    seq: number,
  ): Promise<void> {
    // complete 语义：streaming !== true（false/undefined = 消息完成或静态内容，占位判定直接 finalize）
    const complete = props.streaming !== true
    const silenceMs = performance.now() - lastContentAt
    const decision = resolveStreamingFinalize(
      text,
      opts,
      complete,
      silenceMs,
      deps.streamingFenceSilenceMs,
      finalizedStickyPrefix,
      openFenceLang,
    )
    let finalize = decision.finalize
    let r = await renderIncremental(text, incrementalCache, props.sessionId ?? undefined, {
      finalizeOpenFence: finalize,
    })
    incrementalCache = r.cache
    // 首现竞态兜底（§6.3 D3「半截路径不产假降级卡片」）：上面的 openFenceLang 是上一帧结果的
    // 回读——本轮才新开的 html-preview fence，在静默条件命中（判定层 fenceLang 尚为 null/旧值）
    // 时会被误 finalize，tail 落成 html-preview 段即半截路径卡片闪现。检出「未 complete 却落了
    // html-preview 段」→ 撤回 finalize 以占位形态重渲染；fence 实际已闭合时无 open fence、
    // finalize 不参与尾段形态，两次输出等价（仅多一次渲染，且只在竞态帧发生）。
    if (finalize && !complete && r.tailSegments.some((s) => s.type === 'html-preview')) {
      finalize = false
      r = await renderIncremental(text, incrementalCache, props.sessionId ?? undefined, {
        finalizeOpenFence: false,
      })
      incrementalCache = r.cache
    } else {
      finalizedStickyPrefix = decision.stickyAfter
    }
    openFenceLang = readOpenFenceLang(r.tailSegments)
    // 卸载后不应用结果、不重挂 finalize 定时器（W23 review Fix-3）
    if (disposed) return
    if (seq === renderSeq) {
      segments.value = [...r.prefixSegments, ...r.tailSegments]
      armFenceFinalizeTimer(r.tailSegments, complete)
    }
  }

  /** 渲染失败降级：出声 + 卸载/序号守卫内转义纯文本回填 + 作废缓存/粘滞 + 撤销 finalize 定时器 */
  function handleRenderFailure(e: unknown, text: string, seq: number): void {
    // [HISTORICAL] 降级必须出声（2026-08 CSP 拦截 shiki WASM 事故：此 catch 曾静默吞错，
    // 全部 markdown 渲染无声退化纯文本，线上多版本无任何日志可查）。降级行为保留
    // （保证消息可读），但每次失败都打 error，错误可见才可诊断。
    console.error('[chat/markdown] render failed, fallback to escaped plain text:', e)
    if (!disposed && seq === renderSeq) {
      segments.value = [{ type: 'text', content: escapeHtmlForFallback(text) }]
      // 增量缓存可能已被半途污染（renderIncremental 抛错前原地改写），作废重建保证下帧正确
      incrementalCache = null
      finalizedStickyPrefix = null
      openFenceLang = null
      clearFenceFinalizeTimer()
    }
  }

  function clearFenceFinalizeTimer(): void {
    if (fenceFinalizeTimer !== null) {
      clearTimeout(fenceFinalizeTimer)
      fenceFinalizeTimer = null
    }
  }

  /**
   * tail 含 streaming-fence 占位且消息未完成时安排静默 finalize 定时器（每帧渲染后重排）。
   * html-preview 占位不挂定时器（§6.3 D3 分流）：静默 finalize 对本段类型不生效，挂上只会
   * 每阈值触发一次被判定层再拦截的空转重渲染——收尾/complete 才是本段的 finalize 触发源。
   */
  function armFenceFinalizeTimer(tailSegments: MarkdownSegment[], complete: boolean): void {
    clearFenceFinalizeTimer()
    if (complete) return
    const fenceSeg = tailSegments.find((s) => s.type === 'streaming-fence')
    if (!fenceSeg) return
    if (isHtmlPreviewFence(fenceSeg.lang ?? null)) return
    const remaining = Math.max(0, deps.streamingFenceSilenceMs - (performance.now() - lastContentAt))
    fenceFinalizeTimer = setTimeout(() => {
      fenceFinalizeTimer = null
      void doRender(pendingContent || props.content, { forceFinalize: true })
    }, remaining)
  }

  /** rAF 回调：执行 pending 渲染（延迟求值守卫，一帧内多次 content 变化只渲染末次值） */
  function flushRender(): void {
    rafId = null
    void doRender(pendingContent)
  }

  /** 调度一次渲染（存 pending → 若无挂起 rAF 则 requestAnimationFrame） */
  function scheduleRender(text: string): void {
    pendingContent = text
    if (rafId === null) rafId = requestAnimationFrame(flushRender)
  }

  // content 变化（流式增量）→ rAF 节流渲染；记录到达时刻（streaming-fence 静默判定基准）
  watch(
    () => props.content,
    (text) => {
      lastContentAt = performance.now()
      // 新 token 到达 → 撤销在途静默 finalize：静默语义只在「此后无新内容」时成立，
      // 不清会让已排定定时器带旧 remaining 在新内容上触发一次迟到 finalize
      clearFenceFinalizeTimer()
      scheduleRender(text)
    },
    { immediate: true },
  )

  // streaming true→false（消息 complete）：未闭合 fence 占位立即转完整渲染，不等静默阈值
  watch(
    () => props.streaming,
    (s, prev) => {
      if (prev === true && s !== true) {
        clearFenceFinalizeTimer()
        scheduleRender(props.content)
      }
    },
  )

  // 卸载时置 disposed（短路 in-flight 结果应用与 queued 消费，W23 review Fix-3）+
  // 丢弃 queued + 取消 pending rAF + 清 fence finalize 定时器
  onScopeDispose(() => {
    disposed = true
    queuedRender = null
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    clearFenceFinalizeTimer()
  })

  return { segments }
}
