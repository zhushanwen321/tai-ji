/**
 * useFileChangeInvalidation —— file_changes ready 帧驱动的失效编排共享 helper（D-9，perf W19）。
 *
 * 历史：W6 抽取的共享 helper（消除 useFileTree/useFileSearch 的 watch 重复），W11（R-16）把
 * watch source 迁到 per-sid 内层 ref 并去 deep；W19（D-9 / R-23）把触发语义从「消息数组替换即
 * 全量重扫 diff paths」改为「扫尾部消息的 changeSetStatus，仅 ready 转变时动作」，并补上
 * overlay 回写断点。两职责共用同一触发（09 文档 §3.3.3 职责分离定案）：
 *
 * - 职责一（目录/搜索缓存失效）：ready 帧是每 turn 一次的权威全集（isFullSet=true），直接用
 *   该消息的 fileChanges 路径清单调 onInvalidate——比旧的「全消息累积 diff」更准（同文件二次
 *   修改也会再失效）；RPC 失败不阻断（本地清单先行，不依赖 RPC 结果）。
 * - 职责二（git 角标刷新）：ready 后 debounce 300ms（trailing，per-sid）→ git.status RPC
 *   （复用现有通道，runtime 侧经 GitStateService TTL 缓存）→ fileTreeStore.setGitOverlay
 *   （W15 预聚合随 setGitOverlay 自动重建）。修复「AI 写文件后树角标 stale 直到重开」断点。
 *
 * 触发源（R-23）：浅 watch `() => chatStore.messages.get(sid)?.value`（数组替换触发，W11 既有
 * source 不变）+ 回调内扫尾部 N 条 assistant 消息的 changeSetStatus。file_changes 无独立可订阅
 * 的 composable 层事件（WS 帧经 useChat → effect registry 写 store，本 helper 只能读 store 派生），
 * 而 applyFileChanges 每帧（accumulating/ready）都经 commitMessages 替换消息数组，status map
 * 写在其后同步完成——回调扫描时两者均已就绪。
 *
 * token 路径零副作用：text_delta commit / accumulating 帧同样触发本回调（数组替换），但扫描
 * 无 ready 转变即 no-op——零 RPC、零 onInvalidate（口径与 09 文档 P-D9-3 一致：非零 watch 回调、
 * 零副作用），扫描成本有界（尾部固定窗口，O(窗口) 非 O(全部消息)）。
 *
 * [代码现实偏差，R-23 措辞修正] changeSetStatus 并非消息内嵌字段，而是 chat store 的
 * changeSetStatuses Map（key `${sid}:${messageId}`，changeset.ts 控制器独占）。扫描经
 * chatStore.getChangeSetStatus(sid, messageId) 读 map——「扫末条消息的 changeSetStatus」的
 * 等价实现。hydrate（重开 session 历史回填）不重建该 map，故重开后历史变更集不再触发
 * 失效/刷新（旧实现按累积 paths 在每次切 sid 时全量重失效）；活跃会话的切走切回仍重扫重失效。
 *
 * 多实例隔离：processedReadyKeys 为每次调用的闭包局部状态，多消费方实例各自独立快照。
 *
 * 依赖方向：本 helper 读 chatStore + 写 fileTreeStore（composable → store 合法方向，非
 * stores 间互 import）。onInvalidate 回调仍由调用方表达自己的失效语义。
 */
import { watch, type Ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useFileTreeStore } from '@/stores/fileTree'
import { git as gitApi } from '@/api'

/**
 * 失效回调：检测到新的 ready 变更集时触发（ready 路径清单语义，非全量重扫 diff）。
 * @param sid        当前 session id（已确保非空）
 * @param newPaths   本次新 ready 变更集（可能多个）并集的 paths（非空）
 */
export type FileChangeInvalidateFn = (sid: string, newPaths: string[]) => void

/**
 * 尾部扫描窗口：ready 帧挂在 turn 的最后一条 assistant 消息（agent_end 时 applyFileChanges
 * 按 messageId 定位、miss 时兜底挂最后一条 assistant），turn 结束后只在尾部。固定窗口保证
 * 每 token 回调的扫描成本 O(1) 级（而非旧实现的 O(全部消息)）。
 *
 * 窗口 8 的充分性事实链：pi 每段 assistant 输出都 emit message_start → event-adapter 译为
 * turn-start → runtime currentMessageId 跟随至 turn 最后一段（event-interpreter turn-start
 * 分支）→ ready 到达时挂载 target 距消息尾部 ≈0-2 条（messageId 命中时最多隔最后一段的
 * tool 结果；miss 兜底挂最后一条 assistant 即尾部 0 位）。已知边界：若同一同步块追加
 * >8 条消息（当前 WS 逐宏任务投递 + commitMessages 逐帧替换数组的模型下不会发生——每帧
 * 独立触发 watch 回调并即时消费尾部），ready 会滑出窗口漏检；取 8 而非 2 是抖动余量。
 */
const READY_SCAN_WINDOW = 8

/** overlay 回写 debounce（09 D-9 定案 300ms trailing：防多 turn/多 session 连续完成的 RPC 抖动） */
const OVERLAY_DEBOUNCE_MS = 300

/**
 * 模块级 per-sid debounce timer。3 个消费方（useFileTree/useFileSearch/useSearchModalDeps）
 * 各自实例化本 helper，同一 sid 的多次 ready 调度在此合并为一次 RPC。
 *
 * 生命周期取舍（不随 unwatch 取消）：timer 到点写「捕获 sid」的 overlay 分桶（E9-c 语义，
 * 与 loadTree/expandNode 的迟到响应写 store 同模式，T2.6 overlay 先到后挂载天然支持），
 * 组件卸载后触发只写一个 store 分桶、无 UI 副作用，one-shot 300ms 自清——取消反而会丢掉
 * 已确认 turn 的最终态刷新。sid 切换互不影响（timer 按 sid 分桶，各写各的）。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：overlay 刷新防抖定时器表（one-shot 300ms 自清，非 GUI 数据）
const overlayTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** ready 后调度 overlay 回写（trailing debounce，窗口内多次 ready 只保留最后一次） */
function scheduleOverlayRefresh(sid: string): void {
  const existing = overlayTimers.get(sid)
  if (existing) clearTimeout(existing)
  overlayTimers.set(
    sid,
    setTimeout(() => {
      overlayTimers.delete(sid)
      void refreshOverlay(sid)
    }, OVERLAY_DEBOUNCE_MS),
  )
}

/** 拉 git.status 现在态全量并回写 fileTree overlay（含 file_changes 未覆盖的既有 dirty 文件） */
async function refreshOverlay(sid: string): Promise<void> {
  try {
    const result = await gitApi.status(sid)
    // W19 review Fix-1：RPC 在途期间 session 可能已被 deleteSession（core use-session
    // cleanupSessionState 的销毁序列删 fileTree 分桶 + chat messages 分区）——回写前查
    // chat store messages 分区（session 存活权威信号），已销毁 sid 跳过，防 300ms timer
    // 为其重建孤儿 gitOverlay/dirChangeCounts 分桶。不查 fileTree 自身分桶：「从未建桶」
    // 与「已销毁」在 fileTree 侧不可区分，而首次回写本来就是合法建桶场景（T2.6 overlay
    // 先到后挂载）。LRU 驱逐的 session 同样被拦（messages 分区已回收，切回时 loadTree 重建）。
    if (!useChatStore().messages.has(sid)) return
    if (result.isRepo) {
      // E9-c：写闭包捕获的 sid 分桶——异步回来时组件可能已切 session，仍落到正确 session 的桶
      useFileTreeStore().setGitOverlay(sid, result.files)
      // P-D9-2 探针：V-P2-3（AI 一轮改 5 文件后角标刷新）dev 实测观测点
      console.debug('[fileTree] overlay refreshed (D-9)', { sid, count: result.files.length })
    }
  } catch (e) {
    // E9-b 降级：git.status 失败（非 repo / 越界 / 超时 / 断连）不写 overlay，角标保持旧值，
    // 不打断 renderer 主循环；用户可打开 git 抽屉（useGitStatus 既有路径）手动刷新恢复。
    console.warn('[fileTree] overlay refresh failed (D-9), keeping stale overlay — reopen git panel to refresh:', e)
  }
}

/**
 * 监听 chat store 该 session 的消息分区，扫尾部消息的 changeSetStatus——检测到新的 ready
 * 变更集时：① 用其 fileChanges 路径清单回调 onInvalidate（职责一）；② 调度 debounced
 * overlay 回写（职责二）。其余更新（token commit / accumulating 帧）回调内 no-op。
 *
 * [R-16] watch source 保持 W11 版（per-sid 内层分区 ref，无 deep）：同 sid 数组替换触发 /
 * 异 sid 替换不触发（失效收敛）。
 *
 * @param sessionIdRef session id 的 ref（变化时 watch 自动重订阅 + 快照重置，切回重失效）
 * @param onInvalidate 失效回调，调用方在此表达自己的 invalidate 语义
 * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
 */
export function watchFileChangesForInvalidation(
  sessionIdRef: Ref<string>,
  onInvalidate: FileChangeInvalidateFn,
): () => void {
  const chatStore = useChatStore()
  // 已消费的 ready 变更集 messageId 快照（sid 切换时重置 → 切回时尾部 ready 重新失效，
  // 对齐旧实现「切走后切回从全量开始 diff」的语义）
  let processedReadyKeys = new Set<string>()
  let lastSid: string | null = null

  const unwatch = watch(
    [
      () => sessionIdRef.value,
      // [R-16 / D-1 伴生] source 读 per-sid 内层分区 ref（非整 Map）：同 sid 消息数组替换
      // （commitMessages 的不可变新数组）触发本 watcher；异 sid 分区替换不触发（失效收敛）。
      // sid 增删（外层 Map 替换）仍触发，回调内 ready 扫描兜底（无新 ready 时 no-op）。
      () => chatStore.messages.get(sessionIdRef.value)?.value,
    ],
    () => {
      const sid = sessionIdRef.value
      if (!sid) {
        // session 清空 → 重置快照（下次切回从尾部全量重扫）
        processedReadyKeys = new Set()
        lastSid = null
        return
      }
      if (sid !== lastSid) {
        // session 切换 → 重置快照：切回的 session 尾部 ready 变更集重新失效 + 刷新
        processedReadyKeys = new Set()
        lastSid = sid
      }

      // 尾部有界扫描（新到旧）：收集本次新转变为 ready 的变更集路径（职责一数据源）
      const msgs = chatStore.getMessages(sid)
      const newPaths = new Set<string>()
      let foundReady = false
      const start = Math.max(0, msgs.length - READY_SCAN_WINDOW)
      for (let i = msgs.length - 1; i >= start; i--) {
        const m = msgs[i]
        if (m.role !== 'assistant') continue
        if (chatStore.getChangeSetStatus(sid, m.id) !== 'ready') continue
        if (processedReadyKeys.has(m.id)) continue
        processedReadyKeys.add(m.id)
        foundReady = true
        for (const fc of m.fileChanges ?? []) newPaths.add(fc.filePath)
      }

      // 职责一：ready 路径清单直接失效（RPC 无关，先行）
      if (newPaths.size > 0) {
        // P-D9-3 探针：ready 驱动失效（目录/搜索缓存）dev 实测观测点，与 P-D9-2 同风格
        console.debug('[fileTree] ready-driven invalidation (D-9)', { sid, paths: newPaths.size })
        onInvalidate(sid, [...newPaths])
      }
      // 职责二：debounce 后 git.status RPC → setGitOverlay。空清单 ready 也刷新：runtime
      // 现状（event-interpreter sendDiffFileChanges 的 changes.length===0 早退）零变更不推
      // file_changes 帧，该分支实际不可达——兜底是防御性的（与 09 文档 D-9 伪代码一致，
      // 防 runtime 未来放开零变更帧时角标漂移）；命中 runtime GitStateService TTL 缓存零额外 spawn
      if (foundReady) scheduleOverlayRefresh(sid)
    },
    { immediate: true },
  )

  return unwatch
}
