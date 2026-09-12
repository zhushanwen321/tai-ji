/**
 * useCommandSync —— slash 命令投递闭环（拉 + 推两路；修复 composer skill 消失缺陷）。
 *
 * 根因：session.commands 帧是「一次性投递、零补拉」——session 激活时 runtime
 * 播种拉取并广播一帧，渲染端消费组件异步就位，帧到达早于订阅建立即永久丢失。
 * 本 composable 在消费侧接上「挂载 / 切 session / 打开浮层时主动拉取」的补拉闭环，
 * 复用既有 session.getCommands RPC（runtime 侧查询即失效语义顺带刷新快照）。
 *
 * 触发点（D1）：
 * 1. watch(sessionIdRef, immediate) —— sid 变化 / 挂载即拉（null/undefined 不拉）
 * 2. onOpenPull() —— 浮层打开时调用（CommandPopover watch open && type==='slash'）。
 *    注意：浮层 open 边沿拉取实际统一由 command-popover-open-fetch 承接（带 1s 节流），
 *    不经本处——双路并存会重复 RPC（dev-0.9.9 补拉闭环 × dev-0.9.8 符号系统 open-fetch
 *    合并产物）
 * 3. 推路：订阅 session.commands（D8 走 session 通道）→ 写 commandStore（跨组件重建
 *    持久化；u20 自 command-popover-delivery 并回——同「命令投递」域）。FM4 修复
 *    （ADR-0049）：使用 useSessionEvents 注入的第二参数 sid（订阅时捕获，不随调用方
 *    ref 实时值变化），消除切 sid 时序竞态导致的跨分区污染。
 *
 * 数据模式（D5）：打开即拉（权威透传 pi）+ SWR 旧值先行。拉取应答 ms 级回写覆盖。
 *
 * 分区写入（D2）：拉取写 reply.sessionId 分区，禁止读调用方 props 实时值（ADR-0049）。
 *
 * 失败语义（D3）：catch → console.warn，store 不动、不抛、无 UI。
 *
 * @see docs/architecture/slash-commands-delivery-closure.md §3.4 接口契约
 */
import { type Ref, watch } from 'vue'
import { session as sessionApi } from '@/api'
import { createInflightDedup } from '@xyz-agent/core/foundation/create-inflight-dedup'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import type { RawCommand } from '@xyz-agent/core'

/** getCommands RPC 应答形状（D2 分区写入的消费面）。 */
type CommandsReply = {
  sessionId: string
  commands: Array<{ name: string; description?: string; source: string }>
}

/**
 * 模块级 in-flight 去重表（per-sid）。
 *
 * 为什么模块级而非实例级：split panel 双实例同时 watch 同 sid 时，
 * 模块级可共享同一 Promise，避免重复 RPC。「同 key 复用 / settle 即清下次触发重新拉取
 * （无条件恢复腿，不依赖 store 缓存时效）/ 引用比对防误删」生命周期收编于
 * createInflightDedup（D9 共享原语，state-truth-sync §3.3）。
 */
// taste:allow-no-data-owner（非 GUI 数据的技术结构，同 core/coordination/subscription-state.ts
// subscribeDedup 豁免先例）：in-flight RPC 去重表，存 Promise handle，settle 即清条目
const commandsFetchDedup = createInflightDedup<CommandsReply>()

/** 测试隔离钩子：清模块级 in-flight 表（防用例间残留）。生产代码禁止调用。 */
export function __clearInFlightCommandsFetchForTest(): void {
  commandsFetchDedup.clear()
}

/**
 * slash 命令补拉 composable。
 *
 * @param sessionIdRef sessionId 的 ref（string | null | undefined）。
 *   变化时自动拉取（null/undefined 不拉）。ref 可来自 props（组件 setup 内 toRef(props,'sessionId')）。
 * @returns onOpenPull —— 浮层打开时调用，触发一次拉取（fire-and-forget）。
 */
export function useCommandSync(
  sessionIdRef: Ref<string | null | undefined>,
): { onOpenPull: () => void } {
  const commandStore = useCommandStore()

  /**
   * 拉取指定 sid 的命令列表并写入 store。
   *
   * 复用 inflight 去重：同 sid 并发触发时复用同一 Promise，避免重复 RPC。
   * 写入 reply.sessionId 分区（非调用方实时 sid），从结构上消除 ADR-0049 M1 竞态。
   * settle 即清（下次同 sid 触发重新拉取，无条件恢复腿）与引用比对防误删由 factory 内建。
   *
   * 链路盲区（验收 S3 前提）：拉到的是 pi 内存 skill 注册表的当前值，不是磁盘当前值——
   * 磁盘 skill 增删须经 chokidar watcher → ReloadOrchestrator → pi ctx.reload() 重扫才进
   * 注册表（秒级）。reload 未完成时拉到的仍是旧列表，这是降级不是 bug，勿当缺陷修。
   */
  function pull(sid: string): void {
    const { promise } = commandsFetchDedup.run(sid, () =>
      sessionApi
        .getCommands(sid)
        .then((reply) => {
          // 写 reply.sessionId 分区（消息所属 sid），不污染当前视图 sid 分区
          commandStore.applyCommands(reply.sessionId, reply.commands)
          return reply
        })
        .catch((err: unknown) => {
          // D3 静默降级：保留 store 旧值，console.warn 供排查
          console.warn('[useCommandSync] fetch commands failed:', err instanceof Error ? err.message : err)
          // 返回一个空 reply 以便 Promise 正常 resolve（不影响下游 attach）
          return { sessionId: sid, commands: [] as CommandsReply['commands'] }
        }),
    )
    // 多实例 attach：不 await，fire-and-forget（pull 是副作用 composable，不暴露状态）
    void promise
  }

  // D1 触发点 1：sid 变化 / 挂载即拉（null/undefined 不拉）
  watch(
    sessionIdRef,
    (sid) => {
      if (sid) pull(sid)
    },
    { immediate: true },
  )

  // D1 触发点 3：推路订阅——session.commands 广播写 store（第二参数 sid 是订阅时捕获的
  // 消息所属分区，写它而非当前 ref 值，FM4/ADR-0049 跨分区污染防护）
  const onMessage = useSessionEvents(sessionIdRef)
  onMessage('session.commands', (msg, sid) => {
    commandStore.applyCommands(sid, msg.payload.commands as RawCommand[])
  })

  // D1 触发点 2：浮层打开时调用（CommandPopover watch open && type==='slash'）
  function onOpenPull(): void {
    const sid = sessionIdRef.value
    if (sid) pull(sid)
  }

  return { onOpenPull }
}
