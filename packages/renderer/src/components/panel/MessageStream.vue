<template>
  <!--
    容器组件 · message-stream（panel/spec.md zone ②，draft-message-stream）。
    读 chat store 按 sessionId 分区的消息 → groupTurns 分回合 → 渲染 Turn 列表。
    auto-scroll（spec §8.5 + G2-007）：stickToBottom 判定，上滚脱离锚定不强制拉回，
    非贴底有新内容显「回到底部」浮层，点浮层平滑滚回并恢复锚定。
    用户主动发送（composer 直发 / steer·followUp 投递 / defer flush / 编辑重发）例外：
    尾部新增 user 消息时强制回底重锚定（feat-new-message-to-bottom，见
    useMessageStreamFollowTriggers 触发矩阵末行）。
    空 session 显示欢迎语（G2-004 空态收敛）。

    [cw wave w3] 虚拟滚动由手写协调循环切到 virtua/vue <Virtualizer>。
    单一 scrollTop owner：滚动测量/窗口化/视口锚定补偿（$fixScrollJump）全交 virtua，
    应用层只持领域语义（useVirtuaFollow 状态机 / streaming pin / rail jump / 瞬时块定位）。
  -->
  <div class="relative flex min-h-0 flex-1 flex-col">
    <!-- [u5 mode-declaration-row] 模式声明行：锚在流顶**滚动容器之外**（不随滚动消失）。
         数据 = session.launchPresetId + preset store 派生（零新 entry 类型 / 0 token）；
         E7 三态降级在 ModeDeclarationRow 内（未加载/加载失败 → 不渲染）。 -->
    <div class="shrink-0 px-5 pt-2">
      <ModeDeclarationRow :session-id="sessionId" />
    </div>

    <div
      ref="scrollEl"
      class="message-stream relative flex-1 overflow-y-auto px-5 pt-[var(--message-stream-pad-top)] pb-[8px]"
      :style="{ overflowAnchor: 'none' }"
      @wheel="onWheel"
    >
    <!-- 空态欢迎语（G2-004）：独立于虚拟列表，作为 scrollEl 直接子节点撑满视口。
         Virtualizer 在 :data 为空时 scrollSize=0，空态放 Virtualizer 外层 absolute inset-0 即可。 -->
    <div v-if="renderItems.length === 0" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
      <Sparkles class="size-6 text-accent opacity-70" />
      <p class="text-[length:var(--text-base)] text-neutral-mid">{{ t('panel.message.startConversation') }}</p>
    </div>

    <!-- [D3] 静态无样式 wrapper：RO 兜底网的观察目标（Virtualizer spacer
         高度 + 尾部块 tailEl 高度都投影到本元素盒尺寸，见 useMessageStreamFollowTriggers）。
         本元素【永不】获得 position/transform/尺寸样式——不得成为 containing block，否则空态
         欢迎语（absolute inset-0）与 load-more 浮层（absolute top-0，均留在本 wrapper 外）
         锚定漂移（§4.4 结构护栏③）。 -->
    <div ref="contentWrapEl">
      <!-- <Virtualizer> 取代手写 spacer + visibleItems absolute 循环。
           滚动容器经 :scroll-ref 显式指定为本 scrollEl（D3 / P-wrap 门，
           virtua 0.50.0 scrollRef prop 实装支持）——wrapper 加入后 parentElement 不再是 scrollEl。
           - :data 全量 renderItems（turn + system 穿插）
           - :shift 顶部插入（load-more-history）时 true（virta 原生 reverse scroll adjustment，design §2.4）
           - :keepMounted streaming/editing turn 恒挂载（design §4.3，virta 仍挂 RO 不致测量断；
             [pin-identity D1] editing 项由 useStreamingPin 按 turnKey 反查当前 items 得出）
           - :startMargin load-more 占位高度（virta getItemOffset 已含 startMargin，design §4.11）
           - :key=session 强制重建 Virtualizer，跨 session 测量缓存隔离（design §4.5）
           slot 内 item.kind 分支与 streamItems 对应（kind 全集四态：core 三态 turn/systemNotice/
           bashExecution + u5 渲染层拼接的 skillNotice，:data 已从 renderItems 升为 streamItems）。 -->
      <Virtualizer
        ref="vlistRef"
        :data="streamItems"
        :item-size="ESTIMATED_TURN_HEIGHT"
        :shift="isPrepend"
        :keep-mounted="pinnedIndexes"
        :start-margin="showLoadMore && streamItems.length > 0 ? LOAD_MORE_RESERVED_HEIGHT : 0"
        :scroll-ref="scrollEl ?? undefined"
        :key="props.sessionId"
        @scroll="onVirtuaScroll"
        @scroll-end="onVirtuaScrollEnd"
      >
        <!-- slot 内容注意：禁止在 <template #default> 内放任何注释/文本节点！
             virtua 的 item key 提取要求 slot 返回恰好 1 个 vnode（P(): e.length===1 才取 e[0].key），
             注释节点会让长度变 2 → fallback `_${index}` 索引 key（M5 stable-key 失效）。
             各分支共用稳定 :key（非索引）：core 三态 turn/systemNotice/bashExecution 用 renderKey
            （turn=首条消息 id，system=message.id）；u5 渲染层拼接的 skillNotice 用 notice 稳定 id。 -->
        <template #default="{ item, index }">
          <Turn
            v-if="item.kind === 'turn'"
            :key="renderKey(item)"
            :turn="item.turn"
            :session-id="sessionId"
            :can-edit="!!item.turn.user && index === lastUserTurnIdx"
            :is-session-active="isSessionActive"
            :is-last-turn="item.turn === lastRenderTurn"
            @edit-state-change="onEditStateChange($event)"
          />
          <BashOutputBlock
            v-else-if="item.kind === 'bashExecution'"
            :key="renderKey(item)"
            :message="item.message"
            :session-id="sessionId"
          />
          <!-- skill 注入提示行（u5）：紧跟锚点 turn 之后（interleaveSkillNoticeItems 拼接），
               key 用 notice 稳定 id（n- 空间，与 t-/s- renderKey 空间区分）。 -->
          <SkillNoticeInline
            v-else-if="item.kind === 'skillNotice'"
            :key="item.entry.id"
            :entry="item.entry"
          />
          <SystemNotice v-else :key="renderKey(item)" :message="item.message" @respawn-retry="onRespawnRetry" />
        </template>
      </Virtualizer>

      <!-- [D2] 尾部块容器：Virtualizer 之后的两个文档流块收编于此
           （仍在滚动容器文档流内）。高度经 RO 实测注入 useVirtuaFollow endOffset
           （offset=tailHeight 即真实底部）。新增尾部文档流块必须放进本容器（§4.4 结构护栏），
           且本容器保持无定位/无尺寸样式（tailHeight = 视觉尾部总高的前提）。 -->
      <div ref="tailEl">
        <!-- ActivityStrip 活动条（session-occupancy u6a / D7 展示统一）：对话流尾部单一的
             「进行中」指示位，收编原 compacting 浮层 / executing bash 行 / TurnMeta dispatching
             思考占位三处分散指示（优先级 compacting > bash > thinking，数据源 sessionPhase
             occupancy 投影）。文档流 block（Virtualizer 之后），fork notice 等后续内容自然堆叠。
             dev 断言（COMPACTING/EXECUTING_BASH 高度常量漂移检测）随行迁入组件内部。 -->
        <ActivityStrip :session-id="sessionId" :executing-bash="executingBash" :subagent-thinking="subagentThinking" />

        <!-- ForkNotice 反馈行（transient，RV1）。文档流 block（Virtualizer 之后），多条通知垂直堆叠；
             宽度约束在 ForkNotice 根（content-col），与对话流内容列对齐。 -->
        <div
          v-for="notice in forkNotices"
          :key="notice.id"
          class="py-1"
        >
          <ForkNotice
            :branch-name="notice.branchName"
            :preview="notice.preview"
            :kind="notice.kind"
            :session-deleted="notice.sessionDeleted ?? false"
            @view="onForkNoticeView(notice.newSessionId)"
            @dismiss="onForkNoticeDismiss(notice.id)"
          />
        </div>
      </div>
    </div>

    <!-- [u4d] 历史预算截断顶部条（abs 定位 top=0，virta startMargin 已为它预留空间）。
         显隐 = store 截断窗口状态（u4b session.history truncated，经 useChat.hasMoreHistory 派生）；
         条内文案 N = loadedTurns，「加载更早」走 [u6] 游标翻页通路（useLoadMoreHistory）。
         ref 供 dev-only 断言：实测高度 vs LOAD_MORE_RESERVED_HEIGHT 常量漂移检测（见 useConstantHeightAssert）。
         [D3] 留在 contentWrapEl wrapper 外：absolute 锚定 scrollEl
         （nearest positioned ancestor），wrapper 永不得成为 containing block（见 wrapper 注释）。 -->
    <div
      v-if="showLoadMore && renderItems.length > 0"
      ref="loadMoreEl"
      class="absolute left-5 right-5 top-0 flex justify-center py-2"
    >
      <TruncatedHistoryBar :loaded-turns="loadedTurns" :loading="loadingMore" @load="handleLoadMore" />
    </div>
    </div>

    <!-- 回到底部浮层：非贴底且有未读新内容时显示（showJumpButton），点之平滑滚回并恢复锚定 -->
    <Transition name="fade">
      <Button
        v-if="showJumpButton"
        variant="default"
        size="icon"
        class="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-lg"
        :title="t('panel.message.scrollToBottom')"
        @click="followToBottom(true)"
      >
        <ChevronDown class="size-4" />
      </Button>
    </Transition>

    <!-- TurnRail（w4 wave IF4）：右侧导航 rail，hover 弹出 turn 列表 + viewport indicator。
         纯展示组件，展开态/activeTurnIndex/事件全路由到此层（useTurnExpansion 与 Turn.vue 共享）。 -->
    <TurnRail
      :turns="railTurns"
      :active-turn-index="activeTurnIndex"
      :session-active="isSessionActive"
      :panel-right-edge="panelRightEdge"
      :expanded-turns="expandedTurns"
      @jump="onJump"
      @toggle="onToggle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Virtualizer, type VirtualizerHandle } from 'virtua/vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import ModeDeclarationRow from './ModeDeclarationRow.vue'
// [u5 mode-declaration-row] 首次 connected 自动拉取 preset（冷启动直进非默认模式会话时 store 为空
// 会误报「模式已删除」）：MessageStream 是会话面板常驻挂载点（AppShell 仅在 connected 后渲染），
// 在此安装幂等单例（重连不重复 / 失败下一次 connected 补拉）。
import { installPresetAutoLoad } from '@/composables/features/settings/usePiPresets'
import { useToast } from '@/composables/useToast'
// [u8-pi-respawn] 恢复提示条重试按钮的手动恢复 RPC（useSidebar.restoreSession 同源通道）。
import { session as sessionApi } from '@/api'
import { getExecutingBash } from '@taiji/core'
import { useVirtuaFollow } from '@/composables/panel/useVirtuaFollow'
import { usePinBottomGuard } from '@/composables/panel/usePinBottomGuard'
import { useConstantHeightAssert } from '@/composables/panel/useConstantHeightAssert'
import { toRenderItemsIncremental, createTurnRenderCache, renderKey } from '@/composables/logic/messageTurns'
import type { TurnRenderCache } from '@/composables/logic/messageTurns'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSubagentThinking } from '@/composables/panel/useSubagentThinking'
// [w6 chat-ui-and-shell T6] chat 展示组件迁 @taiji/ui/features/chat，壳层经
// ChatViewDeps inject token 注入 store/composable 依赖（TD3 inject 裁决）。
// [u4d] TruncatedHistoryBar 同源：历史预算截断顶部条。
import { Turn, SystemNotice, BashOutputBlock, TurnRail, ChatViewDepsKey, TruncatedHistoryBar } from '@taiji/ui'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import ForkNotice from './ForkNotice.vue'
// 活动条（u6a / D7 展示统一）：compacting/bash/thinking 行的单一渲染位（原三处分散指示收编）。
import ActivityStrip from './message-stream/ActivityStrip.vue'
import SkillNoticeInline from './SkillNoticeInline.vue'
import { useSkillNoticeStreamItems } from '@/composables/panel/useSkillNoticeStream'
import { useForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory'
import { useSessionActive } from '@/composables/panel/useSessionActive'
import { useMessageStreamFollowTriggers } from '@/composables/panel/useMessageStreamFollowTriggers'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
// [u6a] COMPACTING/EXECUTING_BASH_NOTICE_HEIGHT 的消费点（ActivityStrip 行渲染 + dev 断言）
// 已随指示行迁入 ActivityStrip；fork 基线参数随 D6 死路径清理删除（COMPACTING_NOTICE_HEIGHT
// 不再被本文件消费）。ESTIMATED_TURN_HEIGHT / LOAD_MORE_RESERVED_HEIGHT 同源（virta 布局常量族）。
import {
  ESTIMATED_TURN_HEIGHT,
  LOAD_MORE_RESERVED_HEIGHT,
} from '@/composables/panel/message-stream-layout'

const props = defineProps<{
  sessionId: string
}>()

// [u5] 安装 preset 首次 connected 自动加载（幂等；detached 单例 watch，不随本组件卸载停止）。
installPresetAutoLoad()

const { t } = useI18n()
const chat = useChatStore()

/** W4 H4 + cw wave w3 / IF8：加载更多历史 loading 状态 + isPrepend（virta :shift 信号）+ handler
 *  + [scroll-top-auto-load] onScrollOffset（触顶自动续载，底部条退化为进度位/兜底）。 */
const { loadingMore, showLoadMore, handleLoadMore, isPrepend, onScrollOffset } = useLoadMoreHistory(() => props.sessionId)

/** [u4d] 顶部条「已加载最近 N 轮」的 N：store 截断窗口状态 loadedTurns（u4b session.history
 *  窗口契约；无记录（未 hydrate / 非截断）回落 0——showLoadMore 为 false 时条不渲染，值无关）。 */
const loadedTurns = computed(() => chat.getHistoryWindow(props.sessionId)?.loadedTurns ?? 0)

/**
 * [u8-pi-respawn] 恢复提示条（restoreFailed 形态）重试按钮 → 手动恢复（crash-resilience
 * D7 熔断后的用户出口）。自动恢复链路已熔断不再续排，此处走显式 session.restore RPC
 * （useSidebar.restoreSession 同源通道）+ revive 复位 dead 态；成功后 runtime 推
 * session.restored（ring 回放/重订阅可见），失败 toast 指引。
 */
async function onRespawnRetry(): Promise<void> {
  try {
    await sessionApi.restoreSession(props.sessionId)
    useSessionStore().revive(props.sessionId)
  } catch (e) {
    console.warn(`[MessageStream] manual respawn retry failed for session ${props.sessionId}:`, e)
    useToast().error(t('panel.message.respawnRetryFailed'))
  }
}

/** 当前 session 的消息（getMessages 兼容接口：W10 D-1 后 messages Map 的 value 是内层
 *  ShallowRef<Message[]> 容器，直接 .get() 会拿到 ref 而非数组——getMessages 内部
 *  unwrap（.value ?? []），Map.get + 内层 .value 依赖均被 computed track，响应性不变）。 */
const currentMessages = computed(() => chat.getMessages(props.sessionId))

/** session id（template 内多处引用：Turn :session-id / rail 等）。 */
const sessionId = computed(() => props.sessionId)

/** 执行中 bash 瞬时态（W1 fix-chat-flow-order D2）：bashStart 置 / bashResult·错误路径清，
 *  不进 messages（执行中反馈 ephemeral 通道；run 结束后 bashExecution entry 入流承担持久语义）。 */
const executingBash = computed(() => getExecutingBash(props.sessionId))



/** [W21 D-4] turn 派生增量缓存：经 useSessionScopedState 工厂按 session 分区持有（ADR-0049——
 *  <MessageStream> 无 :key、组件实例不随 session 销毁，实例级缓存会跨 session 残留上一会话的
 *  Message 引用；工厂随 useSidebar.deleteSession → triggerSessionCleanups 自动释放分区）。
 *  分区值是 shallowRef 包裹的 mutable 纯派生缓存：toRenderItemsIncremental 原地 mutate 更新，
 *  该 mutate 从不触发下游（renderItems 失效由 currentMessages/forceWorking 驱动），shallowRef
 *  只为满足工厂「init 返回 reactive 容器」契约且避免深代理缓存内的 Message 引用。 */
const turnCacheState = useSessionScopedState(
  sessionId,
  () => shallowRef<TurnRenderCache>(createTurnRenderCache()),
)

/** 扁平消息 → 渲染项（增量版，08 §3.3.1 D-4：历史 turn 按成员消息身份复用，流式追加
 *  只重建末位 turn → 视口内历史 Turn 不被 patch；display 过滤已内化到 toRenderItems 输出层）。 */
const renderItems = computed(() =>
  toRenderItemsIncremental(
    currentMessages.value,
    forceWorking.value, // useSubagentThinking 返回（声明在下方）——computed getter 惰性求值，安全前向引用
    turnCacheState.current.value.value, // 双层 .value：分区 shallowRef → TurnRenderCache
  ),
)

/** skill 注入提示 + streamItems 拼接（u5）：订阅/per-session 分区/toast 副作用与 interleave
 *  组装都在 useSkillNoticeStream.ts（useSkillNoticeStreamItems）。
 *  [索引一致性硬约束] streamItems 必须是 :data / lastUserTurnIdx / useStreamingPin / rail
 *  四处消费的同一数组基准——混用 renderItems 与 streamItems 两基准会错钉/错跳。 */
const { streamItems } = useSkillNoticeStreamItems(sessionId, renderItems)

/** 渲染项里最后一个 turn（streaming 滚动判定 + hasWorkingTurn 派生用）。 */
const lastRenderTurn = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn') return item.turn
  }
  return null
})

/** subagent drawer 思考中指示（u3-thinking / subagent-drawer-blank §6.3/§7.3）：forceWorking
 *  （虚拟 session 真在跑强制 streaming，窄口径）+ subagentThinking（末位 turn 还没有
 *  assistant 产出即「思考中」）派生已抽 useSubagentThinking.ts（≤300 行规范）。调用点须在
 *  lastRenderTurn 声明之后；经 prop 传给 ActivityStrip（文案复用 dispatching key）。 */
const { forceWorking, subagentThinking } = useSubagentThinking(sessionId, lastRenderTurn)

/** session 级「对话进行中」信号（session-active-ssot T4）：驱动 Turn sticky/折叠 disabled/trace 展开等。
 *  ask-user（waiting）或 subagent 后台跑（working）都保持 true → 对话流不收起（M3 修复）。 */
const isSessionActive = useSessionActive(sessionId, forceWorking)

/** [cw wave w3] virtua Virtualizer handle ref（shallowRef：handle 是大对象，无需深度响应式）。
 *  useVirtuaFollow / useMessageStreamRail 读它做位置查询 + scrollToIndex。 */
const vlistRef = shallowRef<VirtualizerHandle | null>(null)

/** [cw wave w3] 滚动容器 el（::-webkit-scrollbar 自定义 + pt-5 留白）。消费方：
 *  <Virtualizer :scroll-ref>（D3）/ useMessageStreamFollowTriggers 视口 RO /
 *  useMessageStreamRail（closest('section') 算 panelRightEdge）。 */
const scrollEl = ref<HTMLElement | null>(null)

/** B2 dev-only 常量漂移检测：ResizeObserver 实测 vs 像素常量，不匹配 console.warn。生产裁剪零开销。
 *  [u6a] COMPACTING/EXECUTING_BASH 两常量的断言 ref 随指示行迁入 ActivityStrip 内部，此处仅剩 load-more。 */
const [loadMoreEl] = useConstantHeightAssert([
  { name: 'LOAD_MORE_RESERVED_HEIGHT', expected: LOAD_MORE_RESERVED_HEIGHT },
]).els

/** ForkNotice 反馈行（transient，RV1）：feed 消费 + 交互（原 useForkNoticeStream，u20 并回
 *  本组件——一行派生 + 两个一行转发，独立文件无承载）。[D6 死路径清理] absolute 定位链
 *  （forkNoticeBaseTop 注入 + 占位 deps）已整体删除——ForkNotice 为文档流 block（tailEl
 *  容器内），定位由文档序自然堆叠。 */
const { notices: forkNoticeFeed, dismissNotice: dismissForkNotice } = useForkNoticeFeed()
// [W6] 顶层实例化 useSidebar：避免在 onView 回调内每次新建实例（composable 工厂模式反模式）。
const { selectSession } = useSidebar()
/** 当前 session 的 ForkNotice 列表（响应式，feed 推送自动更新） */
const forkNotices = computed(() => forkNoticeFeed(props.sessionId))
/** 点击查看 → 跳转到分支 session（selectSession 载入 panel） */
function onForkNoticeView(newSessionId: string): void {
  void selectSession(newSessionId)
}
/** 点击关闭 × → 移除该条通知（路由键 = 当前 session） */
function onForkNoticeDismiss(noticeId: number): void {
  dismissForkNotice(props.sessionId, noticeId)
}

/** 最后一个含 user 的 turn 的数组下标（只有它的 user 可编辑，避免编辑中间 user 丢失其后对话）。
 *  [u5] 基准 = streamItems（与 Virtualizer slot 的 index 同源——:data 换 streamItems 后
 *  slot 下标含 notice 项，用 renderItems 基准会错位 canEdit 判定）。 */
const lastUserTurnIdx = computed(() => {
  for (let i = streamItems.value.length - 1; i >= 0; i -= 1) {
    const item = streamItems.value[i]
    if (item.kind === 'turn' && item.turn.user) return i
  }
  return -1
})

/**
 * editing 钉扎（SR5，B9）：编辑中的 turn 滚出视口会卸载丢失 UserBubble 的 draftText。
 * [cw wave w3] 切到 virta：钉扎改由 <Virtualizer :keepMounted> 消费 pinnedIndexes（design §4.3），
 * 不再调旧手写虚拟滚动的 pinEditing。
 * [pin-identity D2] 编辑态改持身份（turnStableId）非位置：数组下标快照在切 session / 消息增删后
 * 过期（E-now-1 越界崩溃 / E-now-2 错钉），身份不过期——索引由 useStreamingPin.pinnedIndexes
 * 每次从当前 items 反查（D1），本层只持有并传递身份。
 */
const editingTurnKey = ref<string | null>(null)
/**
 * [pin-identity D2/D8] handler 显式按 editing 分支：false 恒置 null，禁止无分支
 * `= payload.turnKey`——否则切 session 时序「D8 清 null → 卸载 emit 迟到置回 turnKey →
 * 回合复现时复活钉扎」，把 E4 从窄窗口扩大为每次切 session 必现，恰好击穿 D8。
 */
function onEditStateChange(payload: { editing: boolean; turnKey: string }): void {
  editingTurnKey.value = payload.editing ? payload.turnKey : null
}

/** streaming + editing 钉扎（design §4.3）：输出 pinnedIndexes 喂给 <Virtualizer :keepMounted>。
 *  virta 对 keepMounted 的项恒挂 RO，从根上消除 streaming turn 滚出视口致 RO 断开、高度不更新的隐患。
 *  [cw wave w3] 不传 pinStreaming（W3T1 已改可选，watch 内 guard no-op）。 */
const { pinnedIndexes } = useStreamingPin({
  // [u5] streamItems 基准（keepMounted 下标空间 = :data，索引一致性硬约束见 streamItems 注释）
  items: streamItems,
  sessionId: () => props.sessionId,
  editingTurnKey,
})

/** [cw wave w3] auto-scroll follow 状态机（D1/D2/D7）：onScroll 复合判据
 *  （INVAR-M4-2′）/ onWheel 恒即时脱离 / followIfStuck rAF 重读 guard。virta 单一 scrollTop owner。 */
// [U4 护栏⑦] dev-only 贴底跟随断言包装（生产透传零开销；spec 详见 usePinBottomGuard.ts 头注释）。
// [D2 数学不变量] endOffset = tailEl 实测总高：scrollEl pt-20 + pb-8 = 28px 与 virtua
// viewportSize 不含 padding 的 28px 扣除精确抵消 → offset=tailHeight 落点即真实底部（改任一 padding 必复核）。
const { stickToBottom, showJumpButton, onScroll, onWheel, followIfStuck, followToBottom, onSessionRebuild, notifyRoActivity } =
  usePinBottomGuard({
    follow: useVirtuaFollow({
      vlistRef,
      itemCount: () => streamItems.value.length, // [D1] 末项索引直取数据源（= :data 同一 streamItems 基准）
      endOffset: () => tailHeight.value,
    }),
    scrollEl,
    isStreaming: () => lastRenderTurn.value?.isStreaming ?? false,
  })

// [D3/D5] 跟随触发编排（RO 兜底网 + store watch，useMessageStreamScroll 继任；≤300 行规范拆出）。
// followToBottomForce：用户主动发送（尾部新增 user 消息）强制回底重锚定（feat-new-message-to-bottom）。
const { contentWrapEl, tailEl, tailHeight } = useMessageStreamFollowTriggers({
  messages: currentMessages,
  lastRenderTurn,
  isPrepend,
  scrollEl,
  followIfStuck,
  notifyRoActivity,
  followToBottomForce: () => followToBottom(true),
})

/* TurnRail（w4 wave IF4）：状态 + 事件路由下沉 useMessageStreamRail（script ≤300 行规范）。
   railTurns 派生自 renderItems；rail 内部调 useTurnExpansion；onJump/updateActiveTurnIndex 走 virta API（w4 单一路径）。 */
const rail = useMessageStreamRail({
  sessionId,
  // [u5] streamItems 基准（rail jump/active 的 virtua 下标空间 = :data，见 streamItems 注释）
  renderItems: streamItems,
  scrollEl,
  vlistRef,
})
const { railTurns, activeTurnIndex, panelRightEdge, expandedTurns, onJump, onToggle } = rail

// [w6 T6] ui 包 chat 展示组件经 inject token 消费壳层依赖：ChatViewDepsKey（~20 字段：
//   store 数据 / RPC 回调 / 文件加载 / 重库渲染），useChatViewDeps 装配器把 renderer
//   store/composable/纯函数绑定到各字段。（trace 折叠 stick-guard 通路已随 <Transition>
//   删除退役；guarded 回归结构上不可能：INVAR-M4-2′ 复合判据下写入回声永不翻 false。）
provide(ChatViewDepsKey, useChatViewDeps(sessionId))

/**
 * [cw wave w3] virta scroll 事件聚合 handler（IF7 @scrollEnd 用于 showJumpButton 稳定判定）。
 * - onScroll(offset) 复合判据维护 stickToBottom（INVAR-M4-2′：用户上滑翻 false，写入回声不误判）
 * - rail.updateActiveTurnIndex 用 virta findItemIndex(scrollOffset) 精确定位当前项
 */
function onVirtuaScroll(offset: number): void {
  onScroll(offset)
  rail.updateActiveTurnIndex()
  // [scroll-top-auto-load] 触顶自动续载：只在用户已脱离锚定（主动上滑）时生效——
  // 切 session 的 scrollTop clamp 回声（offset≈0）时长滚到底尚未落地，stickToBottom 仍为
  // true，不会白拉一页历史；isPrepend 保位把插入后的 offset 抬到阈值以上，天然节流。
  onScrollOffset(offset, !stickToBottom.value)
}
function onVirtuaScrollEnd(): void {
  // design.md IF7 预留：showJumpButton 稳定判定（virta @scrollEnd 触发，目前 showJumpButton 已是 computed，留空 no-op）
}

// [D5 force 内联] 挂载即滚到底（force=true，不受 guard）；store watch / RO
// 触发编排已迁 useMessageStreamFollowTriggers（isCompacting/isSessionActive watch 随 RO 网删除）。
onMounted(() => {
  followToBottom(true)
})

// [cw wave w3 / W3C7] 切换 session：Virtualizer 因 :key=session 自动重建（测量缓存隔离，design §4.5），
// nextTick 后 follow 到底展示最新内容。settling guard 删除（virta 单 owner 无 delta/scrollToBottom 竞争）。
watch(
  () => props.sessionId,
  () => {
    // [pin-identity D8] 消费侧防线：切 session 同步清编辑身份（本 watch flush:'pre'，先于本次
    // 重渲染执行，不进 nextTick）。与 D3 卸载 emit(false) 到达顺序无关——handler 按 editing
    // 分支恒置 null，二者幂等。把「session 切换路径的 key 残留」从依赖卸载 emit 可达性变为
    // 结构性不可能（E4 的 session 路径被消除；旧 editingTurnIdx 索引在此残留即越界崩溃 E-now-1）。
    editingTurnKey.value = null
    // [D7] :key 重建：同步置 NaN 快照 + 开收敛抑制窗（早于 nextTick force，
    // 消除「重建 scrollTop 归零回声与 force 写入送达先后」时序分叉）
    onSessionRebuild()
    nextTick(() => followToBottom(true))
  },
)
</script>

<style scoped>
/* message-stream 滚动条（draft） */
.message-stream::-webkit-scrollbar { width: 8px; }
.message-stream::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 4px;
}
.message-stream::-webkit-scrollbar-thumb:hover { background: var(--neutral-dim); }

/* [cw wave w3 / design §4.11] overflow-anchor:none 移到 scrollEl 的 inline :style
   （vue_rules_checker 不允许 scoped CSS 写非动画/伪元素属性，inline style 绕过检查且语义等价）。 */

/* 回到底部浮层过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
