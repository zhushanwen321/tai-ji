/**
 * CommandPopover 打开主动拉（composer-symbol-system U2a / U3 renderer 部分）。
 *
 * 从 CommandPopover.vue 拆出（script 行数约束）：浮层 open false→true 边沿按 type 分路主动拉——
 * - slash：sessionApi.getCommands（查询即失效 + 最新值回填 commandStore）——兜底所有广播
 *   丢失/时序场景（设计 D4 路径 2，与 runtime 失效路幂等）；失败 warn 静默保留旧快照
 *   （ReplicatedState 退避语义同向，不空转）。
 * - subagent：subagentStore.loadSubagents（@ 候选源是 per-session 分区，打开时刷新最新 records）。
 * - file：landing cwd 路（D2/D3）——无 sid 且有 cwd 时 getFileCandidatesByCwd 边沿拉，
 *   结果回写本模块持有的候选 ref（cwdFileCandidates）进 items。
 *   - D7（adversarial-review-fixes §3.4）：失败回写**错误态标志**（非空数组降级——空态
 *     两因「加载失败 vs 无结果」需区分，浮层错误态 + 重试入口）；truncated（DoS 5000
 *     截止）透出供浮层底部条件提示。
 *   - B5/#10 cwd 快照守卫：open 边沿先清候选 ref（上一 cwd 的陈旧候选不得在本次打开
 *     显示——FileNode.path 相对 cwd，跨目录显示是事实错误）；回写前比对发起时快照 cwd
 *     与当前 cwd，不一致丢弃（成功/失败对称裁决）。
 * - session：不 open 拉（sessionStore 启动常驻 + 广播维护，D1/D7）。
 * 节流（防浮层反复开关刷屏）：各路独立 1s 窗口，窗口内重复打开不重拉；重试入口绕过
 * 节流（用户显式动作，adversarial-review-fixes D7「浮层内重试」）。
 *
 * landing cwd 路 $ 候选的组件侧视图态同收本文件（u20 合并原 useCommandPopoverCwdFileView，
 * 删 open-fetch → 视图态的回调缝）：候选 ref（open 边沿清空在 watch 内直写）+ D7 错误/
 * 空结果/截断三态可见性派生。仅 file 分支 landing 路（panel 有 sid 走 store 缓存路，
 * 协议不带 truncated、无此三态）。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSubagentStore } from '@/stores/subagent'
import { session as sessionApi } from '@/api'
import { getFileCandidatesByCwd } from '@taiji/core/transport/api/domains/composer'
import { toFileCandidates } from '@taiji/core'

/** 打开主动拉节流窗口（浮层反复开关不刷屏） */
const FETCH_THROTTLE_MS = 1_000

/** landing cwd 路拉取状态（D7：error/success 两态驱动浮层错误态与空态区分） */
type CwdFileFetchStatus = 'idle' | 'success' | 'error'

export function useCommandPopoverOpenFetch(opts: {
  open: () => boolean
  type: () => 'file' | 'slash' | 'session' | 'subagent' | 'skill'
  sessionId: () => string | undefined
  /** landing 态当前选定目录（Composer 传 flow.currentCwd；file 路 cwd 通道专用，panel 不消费） */
  cwd: () => string | null | undefined
}): {
  /** landing cwd 路候选（panel 路 fileCandidates 由 CommandPopover 内 store 缓存路另持） */
  cwdFileCandidates: Ref<ReturnType<typeof toFileCandidates>>
  /** 错误态：拉取失败 → 浮层「加载失败，点击重试」（行点击重试） */
  fileErrorVisible: ComputedRef<boolean>
  /** 空结果态：拉取成功但目录无文件 →「当前目录无匹配文件」（query 过滤致空不在此列） */
  fileNoResultsVisible: ComputedRef<boolean>
  /** 截断提示：runtime DoS 上限 5000 截止（结果非空时列表底部条件提示） */
  fileTruncatedVisible: ComputedRef<boolean>
  /** D7：浮层内重试（绕过 1s 节流；快照守卫/错误态/截断透出与 open 边沿同路） */
  retryCwdFileFetch: () => void
} {
  const commandStore = useCommandStore()
  const subagentStore = useSubagentStore()
  let lastSlashFetchAt = 0
  let lastSubagentFetchAt = 0
  let lastFileCwdFetchAt = 0

  const cwdFileStatus = ref<CwdFileFetchStatus>('idle')
  const cwdFileTruncated = ref(false)
  const cwdFileCandidates = ref<ReturnType<typeof toFileCandidates>>([])

  const isLandingFile = () => opts.type() === 'file' && !opts.sessionId()

  /** landing cwd 路拉取（open 边沿与重试共用；force=true 绕过节流——用户显式重试） */
  function fetchCwdCandidates(force: boolean): void {
    const cwd = opts.cwd()
    if (!cwd) return
    if (!force && Date.now() - lastFileCwdFetchAt < FETCH_THROTTLE_MS) return
    lastFileCwdFetchAt = Date.now()
    // B5/#10 快照：回写前比对当前 cwd——拉取期间切目录后，迟到回执（成功或失败）一律丢弃
    const cwdAtIssue = cwd
    void getFileCandidatesByCwd(cwd)
      .then(({ files, truncated }) => {
        if (opts.cwd() !== cwdAtIssue) return
        cwdFileStatus.value = 'success'
        cwdFileTruncated.value = truncated
        cwdFileCandidates.value = toFileCandidates(files)
      })
      .catch((e: unknown) => {
        if (opts.cwd() !== cwdAtIssue) return
        // cwd 目录已删/权限失败（runtime not_found）→ D7 错误态（浮层「加载失败，点击重试」）
        console.warn('[CommandPopover] file open-fetch getFileCandidatesByCwd failed:', e)
        cwdFileStatus.value = 'error'
        cwdFileCandidates.value = []
      })
  }

  watch(
    () => [opts.open(), opts.type()] as const,
    ([open], [prevOpen]) => {
      if (!open || prevOpen) return // 仅 false→true 边沿
      const type = opts.type()
      const sid = opts.sessionId()
      // slash 与 skill（多 skill 注入 D1）同源：数据都在 pi get_commands → commandStore，
      // 打开边沿同一节流窗口拉一次，双浮层共享最新快照
      if (type === 'slash' || type === 'skill') {
        // sid 门必须在 slash/skill 分支内，不能上移为 watch 顶部无条件门——
        // file 路 landing cwd 通道（D2/D3）恰是「无 sid 有 cwd」的边沿拉取
        // （f7da355d5 merge 曾误移为顶门，把 file 分支拦成死代码，G1 行为丢失）
        if (!sid) return // landing 态无 session 通道不拉（slash/skill 候选源 per-session）
        if (Date.now() - lastSlashFetchAt < FETCH_THROTTLE_MS) return
        lastSlashFetchAt = Date.now()
        void sessionApi
          .getCommands(sid)
          .then((reply) => {
            commandStore.applyCommands(sid, reply.commands)
          })
          .catch((e: unknown) => {
            // 主动拉是兜底路：失败保留 commandStore 旧快照，不空转
            console.warn('[CommandPopover] slash open-fetch getCommands failed:', e)
          })
      } else if (type === 'subagent') {
        if (!sid) return // @ 范围限当前 session（D3 拍板），landing 无数据源不拉（G3）
        if (Date.now() - lastSubagentFetchAt < FETCH_THROTTLE_MS) return
        lastSubagentFetchAt = Date.now()
        void subagentStore.loadSubagents(sid)
      } else if (type === 'file') {
        // D3 分路守卫：panel（有 sid）走 store 缓存路，open-fetch 不重复拉；
        // landing（无 sid）有 cwd 才拉（cwd 通道），两者皆无不拉（无数据源不弹，S4b）
        if (sid) return
        // B5/#10：open 边沿先清候选与状态——上一 cwd 的陈旧候选（path 相对旧 cwd）不得
        // 在本次打开显示；错误/截断标志同拍复位（状态与数据同源同寿命）
        cwdFileCandidates.value = []
        cwdFileStatus.value = 'idle'
        cwdFileTruncated.value = false
        fetchCwdCandidates(false)
      }
    },
  )

  function retryCwdFileFetch(): void {
    fetchCwdCandidates(true)
  }

  // D7 三态可见性派生（u20 合并原视图态封装 useCommandPopoverCwdFileView，回调缝已删）
  const fileErrorVisible = computed(() => isLandingFile() && cwdFileStatus.value === 'error')
  const fileNoResultsVisible = computed(
    () => isLandingFile() && cwdFileStatus.value === 'success' && cwdFileCandidates.value.length === 0,
  )
  const fileTruncatedVisible = computed(
    () => isLandingFile() && cwdFileTruncated.value && cwdFileCandidates.value.length > 0,
  )

  return { cwdFileCandidates, fileErrorVisible, fileNoResultsVisible, fileTruncatedVisible, retryCwdFileFetch }
}
