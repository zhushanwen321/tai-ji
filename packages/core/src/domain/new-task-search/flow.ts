/**
 * flow —— 新建任务流程编排器（core 域迁移版，IF5）。
 *
 * [归位] 迁自 renderer composables/features/useNewTaskFlow.ts（471 行），语义逐条等价。
 * C-NT-2 裁决的跨域接线：session 生命周期经注入的 SessionFlowPort（契约对齐
 * domain/session/createSessionFlow IF5）、chat 经 ChatSendPort、panel/navigation/workspace
 * 经 NavigationPanelPort、toast 经 ToastPort、fileTree 经 FileTreePort、i18n 经 TranslatePort、
 * retry image 迁移经 ImageMigratePort。useNewTaskFlow(deps) 参数注入（IF5），core 零跨包 import。
 *
 * 职责（编排，非状态机实现）：NewTaskFlow 横切编排骨架——compose 状态机 + 分支 + 选目录三子模块，
 * 自身仅保留跨子模块的编排动作：
 * - startFlow：进 landing（销毁重建终态 / in-flight 守卫 / presetCwd / 不变量强制清 activeId）。
 * - submitFirstMessage：landing 态首发提交（ensure 数据源就绪 → resolve 解析终值 → create session
 *   + 载入 panel + 发送；post-create 双重 apply 已随 D5 契约快照化删除）。
 * - presetCwd / setPendingModel / setPendingPreset：landing 态回灌选定值（submit 时经 resolve 生效）。
 * - closeOverlay / cancelFlow / reenterFlow / completeFlow：薄转换封装。
 * - computed 视图（currentSessionId/currentCwd/currentModel/gitInfo/isInflight/isOverlay/isActive）。
 *
 * 状态机实现见 flow-state；git 分支见 branch；选目录见 dir-select。
 */
import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { Segment } from '@taiji/shared'
// AC10 跨域铁律：session 域经 '@taiji/core/domain/session' 公开 index API 消费（禁内部模块相对路径）
// migrateImageSegments：tmpdir image 段迁移单源原语（S4-A2 收口——原本文件私有 migrateTmpdirImages
// 与 create-session-flow 私有实现逐字同构，双份合一）
import { migrateImageSegments } from '@taiji/core/domain/session'
import type { CreateSessionFlowInput } from '@taiji/core/domain/session'
import type { ThinkingLevel } from '@taiji/shared'
import {
  useNewTaskFlowState,
  useNewTaskFlowController,
  transition,
  openOverlay,
  OVERLAY_STATES,
  ACTIVE_STATES,
  type GitInfo,
} from './flow-state'
import { useNewTaskBranch, type NewTaskBranchController } from './branch'
import { useNewTaskDirSelect } from './dir-select'
// D1 单一解析层（launch-config，U1）：submit 侧消费 resolveLaunchConfig 终值——
// 显示侧（chip）与 create 入参同源，「显示 ≡ 生效」由构造成立
import { ensureLaunchDataReady, resolveLaunchConfig } from './launch-config'
import type { LaunchConfigInput } from './launch-config'
// supportedLevelsOf 单源（原本文件内逐字镜像已收编，独立模块防 flow 编排 mock 波及）
import { supportedLevelsOf } from './supported-levels'
// core 域 KV 单例直接 import（设计 D1，同 launch-config.ts 自身 import 先例）
import { lookup as lookupLastUsedModel } from '../composer/last-used-model'
import { lookup as lookupRememberedLevel } from '../composer/model-thinking-memory'
import { getSettingsStore } from '../settings'
import type {
  NewTaskFlowDeps,
} from './ports'

/**
 * launch 配置解析端口（D1「store 数据经 deps 注入」，U2b）。
 *
 * 壳层（renderer useNewTaskFlow）注入 preset store / settings store 的解析数据与就绪源；
 * 编排器（本文件）持有 pending 三兄弟 + Composer authored 档位，resolve 时覆盖到端口返回的
 * 数据基座上。接口声明随 flow.ts（对齐 U1 launch-config 自带 LaunchDataDeps 的文件内声明
 * 先例），壳层接线稳定后可正式化迁入 ports.ts。
 */
export interface LaunchConfigPort {
  /**
   * 壳侧 store 数据基座（presets / defaultPresetId / providers / defaultModel /
   * getSupportedLevels 等 resolve 输入，不含 pending 三兄弟——编排器用自身 landing 态覆盖）。
   * 每次调用现读响应式数据源（壳侧 Ref / computed）。
   */
  getInput(): LaunchConfigInput
  /**
   * 壳侧异步源就绪（preset store 惰性加载等）：submit 在 resolve 前 await（D1 加载窗口
   * 语义——窗口内 resolve 是占位值，直接发送会把占位值固化进新 session）。已加载时壳实现
   * 返回 resolved promise；加载失败按 E1/E4 在壳内收敛（回落默认），本编排器只兜底 reject/同步抛错。
   */
  ensureReady(): Promise<void>
}

/** U2b 扩展依赖：现有 ports 结构 + launchConfig 端口（可选——壳未接线时回落 core 域单例基座）。 */
export type NewTaskFlowDepsWithLaunch = NewTaskFlowDeps & {
  ports: { launchConfig?: LaunchConfigPort }
}

/**
 * 壳未注入 launchConfig 端口时的 resolve 输入基座（过渡语义）：core 域可达单例——
 * settings store（与显示链 composer-shell 同一 getSettingsStore 单例）+ lastUsedModel /
 * 记忆表 KV（launch-config 同款直接 import）。preset 列表 / defaultPresetId 在 core 无
 * 镜像（renderer preset store），缺失时 preset 档不可达——preset 透传依赖壳层接线
 * ports.launchConfig（接线前 explicit preset 选择不透传，属 U2b 已登记偏差）。
 */
function buildFallbackLaunchInput(): LaunchConfigInput {
  const settings = getSettingsStore()
  return {
    lastUsedModel: lookupLastUsedModel(),
    getRememberedThinkingLevel: (modelId) => lookupRememberedLevel(modelId),
    providers: settings.providers.value,
    defaultModel: settings.defaultModel.value,
    getSupportedLevels: (modelId) => supportedLevelsOf(modelId, settings.providers.value),
  }
}

/**
 * 新建任务流程编排器（IF5）。
 *
 * @param deps 全部跨域依赖经注入端口（NewTaskFlowDeps——ports 七端口 + gitApi/directoryPicker/
 *   workspaceApi/workspaceState 四端口；壳层 w5 适配 renderer api/stores/composables 注入）；
 *   U2b 扩展 ports.launchConfig（launch 配置解析数据端口，可选——未注入时 submit 侧回落
 *   core 域单例基座，preset 档不可达）
 */
export function useNewTaskFlow(deps: NewTaskFlowDepsWithLaunch) {
  const { ports, gitApi, directoryPicker, workspaceApi, workspaceState } = deps
  const launchPort = ports.launchConfig

  const {
    state,
    currentSession,
    pendingCwd,
    pendingModel,
    createInFlight,
  } = useNewTaskFlowState()

  /**
   * Landing 态用户选定的预设 id（session.create 透传用）。
   * 对齐 pendingCwd/pendingModel 范式：landing 态记录选定值，submitFirstMessage 时透传。
   * startFlow 时重置为 null。PresetSelectChip 通过 setPendingPreset 写入。
   * 实例局部 ref（源语义，非模块级）。
   */
  const pendingPreset = ref<string | null>(null)

  // 受控写入口 controller（父编排器独占）：setter 不再模块级 export，杜绝子模块 /
  // 组件越权 import 调用。本编排器独占后，按需把具体 setter 作为参数下发给子模块。
  const controller = useNewTaskFlowController()

  /** 当前 flow 绑定 session 的 id（统一延迟 create 后，landing 态恒为 null） */
  const currentSessionId: ComputedRef<string | null> = computed(
    () => currentSession.value?.id ?? null,
  )
  /** 当前 flow 工作的 cwd（chip 回灌）：session 已建用 session.cwd，否则用 landing 选定的 pendingCwd */
  const currentCwd: ComputedRef<string | null> = computed(
    () => currentSession.value?.cwd ?? pendingCwd.value,
  )
  /**
   * 当前 flow 选定模型（Composer 显示用）：session 已建用 session.modelId，
   * 否则用 landing 选定的 pendingModel。两者均空时 Composer 侧经 resolveLaunchConfig
   * 全序解析兜底（preset.modelOverride → lastUsedModel（D4 校验）→ 全局默认），
   * 不直接落全局默认。
   */
  const currentModel: ComputedRef<string | null> = computed(
    () => currentSession.value?.modelId ?? pendingModel.value,
  )

  // 选目录子模块（需在 gitInfo 前创建：gitInfo landing 态 fallback 读 dirSelect.mode/worktreeItems）
  const dirSelect = useNewTaskDirSelect(
    { directoryPicker, workspaceApi, workspaceState },
    () => currentCwd.value,
  )

  /**
   * gitInfo（UC-7 chip 可见性 + openBranchPopover 守卫派生）。
   * 数据源优先级：
   * 1. session 态（已建 session）：currentSession.gitBranch / isBareWorkspace
   * 2. landing 态（无 session，延迟 create）：dirSelect 的 mode + worktreeItems HEAD 项
   *    —— landing 态无 session，旧实现只从 session 派生导致恒 null，branch chip 永不显示、
   *       openBranchPopover 守卫必抛错。改为合并 landing 态数据源。
   */
  const gitInfo: ComputedRef<GitInfo | null> = computed(() => {
    const s = currentSession.value
    if (s?.gitBranch) {
      return { branch: s.gitBranch, isRepo: true, isBare: s.isBareWorkspace ?? false }
    }
    // landing 态 fallback：从 dirSelect 的 pendingCwd 驱动数据派生
    if (dirSelect.mode.value !== 'not-repo') {
      const head = dirSelect.worktreeItems.value?.find((w) => w.HEAD)
      return { branch: head?.branch ?? '', isRepo: true, isBare: dirSelect.isBare.value }
    }
    return null
  })

  /**
   * startFlow —— 触发新建（§4.1 主流程，统一延迟 create）。
   *
   * 需求修正：点「新建任务」后**不立即 create session**，只进 landing 空 chip 态。
   * 首次/非首次一致（推翻原「触发即创建」+ G1.1「非首次沿用上次 cwd」）。
   * session 由首发提交 submitFirstMessage 创建；选目录只记 pendingCwd 不建 session。
   * - completed 终态再触发→先销毁重建 idle（AC-3.12）再进 landing
   * - createInFlight 守卫：submitFirstMessage 飞行中再触发→忽略（防并发重复建 session）
   * - presetCwd：可选，进 landing 时预设 chip 的 cwd（initApp 用最近 session 目录预填）。
   *   未传→空 chip 态（默认）；传值→chip 所见即所得（G1.1「沿用目录做新任务」）。
   *
   * 不变量强制（根治 new-task 渲染撕裂）：flow 进 landing 时，编排层主动清空
   * activeId + active panel 的 leaf.sessionId。此前该不变量只写在注释（ACTIVE_STATES
   * 注释「flow 活跃期间 activeId 恒 null」），从未被代码执行——会话中点新建时旧
   * sessionId 残留，Panel.vue 第一条 v-if 用旧 sessionId 命中 MessageStream，导致
   * 「页面不跳转、只 composer 消失」。此处清空后 sessionId=null → Landing 正确渲染。
   */
  async function startFlow(presetCwd?: string): Promise<void> {
    // 终态重建（AC-3.12）：completed 后 ⌘N 销毁重建。completed→idle 不在 ALLOWED 表（completed 无出口），
    // 必须用 transitionUnchecked（@internal 终态重建语义），随后 idle→landing 走正常 transition。
    if (state.value === 'completed') {
      controller.transitionUnchecked('idle')
      controller.bindCurrentSession(null)
    }
    if (createInFlight.value) return // submitFirstMessage 飞行中，忽略重复触发
    // 幂等：已 landing 态再 startFlow（initApp 重试 / 多次 ⌘N）→ 不翻 state（landing→landing
    // 非法），只刷新 cwd + 不变量。避免 loadSessions 失败后 initApp 重试时 transition 抛错。
    if (state.value !== 'landing') {
      transition('landing') // idle→landing
    }
    // 进 landing：预设 cwd（有则 chip 所见即所得，无则空 chip 态）
    pendingCwd.value = presetCwd ?? null
    pendingModel.value = null
    pendingPreset.value = null
    controller.bindCurrentSession(null)
    // 强制不变量：landing 态无 session 绑定。清 activeId + active panel leaf.sessionId，
    // 让 Panel 的 sessionId prop 变 null → 渲染落到 Landing（而非旧会话 MessageStream）。
    ports.navigation.clearActiveSession()
    ports.navigation.loadPanel(ports.navigation.activePanelId(), null)
  }

  /**
   * submitFirstMessage —— landing 态首发提交：载入 panel + 发消息。
   *
   * 预创建后 session 已在选目录时建立，这里只负责载入 panel + 发送。
   * - 无绑定 session（未选目录直接输入发送，用 workspaceStore.defaultCwd 兑底 create）→ create 后发送
   * - 已绑定 session（选过目录预建 / 重试场景）→ 直接载入 + 发送，不重复 create
   *
   * 终态时序（D3 交接原子化）：交接三步（setActiveSession + loadPanel + pushChat）完成
   * 即 transition('completed')，早于 send——send 成败属于 session 的错误通道（useChat
   * W2 吞错 toast），与 flow 状态机无关（原设计 §3.3 D3，文档已删除、git 可追溯）。
   *
   * bash 首发（composer-bash-execute）：landing 态输入 !/!! 前缀时，Composer 提取 bashCommand
   * 传入，session 创建 + panel 载入流程不变，仅发送阶段改调 chat.sendBash（不走 LLM turn，
   * 不经 segments 提取）。segments 仍作为 session label 来源 + 非空校验。
   *
   * segments 来自 Composer DOM 快照（getSegments），含 text / skill / file / mention / image 段。
   * landing 态可能纯图（含 image 但无 text），用户只贴图不写字也允许发送——入参校验只要求 segments
   * 非空，不强制 text 段存在。session label 从首段 text 段取（无 text 段时 deriveSessionLabel('')
   * 兜底为「无提示词」）。
   *
   * tmpdir 迁移：landing 态图片可能落 tmpdir（writeSessionImage 在 sessionId 为空时降级 tmpdir）。
   * session.create 成功后，扫描 segments 把 needsMigrate=true 的 image move 到 attachments/<sessionId>/。
   * 迁移判断用 segment.needsMigrate 字段（M1 修复），不猜路径——+菜单选的用户磁盘文件 needsMigrate
   * 不设（false），不会被误迁移（避免 renameSync 把用户原文件移走——数据丢失）。
   * 迁移后再 chat.send——appendUser 用迁移后的 path，segmentsToText 也产出迁移后的 path，不需要额外的 store update。
   * 降级：单文件迁移失败（OS 已清理 tmpdir）不阻断发送，console.warn + toast 提示，path 保留 tmpdir
   * （路径进 prompt 文本，LLM 调 read 工具时文件不存在会自然报错——但路径本身仍发，非硬错误）。
   *
   * thinkingLevel / model / presetId（D1 单一解析层，U2b 改线）：create 前
   * await ensureLaunchDataReady()（core KV 双源 + 壳侧 ports.launchConfig.ensureReady），
   * 再 resolveLaunchConfig 解析终值——pending 三兄弟 + Composer authored 档位作 explicit
   * 输入覆盖壳侧数据基座。create 入参恒传解析终值（D5 契约快照化：landing 新建
   * modelOverride/thinkingOverride 恒非空；presetId 按 D3——出厂 builtin:full 解析为
   * undefined 不透传，非出厂正常透传）。post-create 双重 apply（壳层 C-W4-3
   * setThinkingLevel）已随快照化删除——landing 恒传终值后它是同值二次 RPC。
   *
   * @param segments 结构化 segments（含 text/image/skill/file/mention 段）
   * @param thinkingLevel 可选思考等级（landing 态 Composer 选定值）
   * @param bashCommand [S10] bash 命令参数。仅当 extractBashCommand.type === 'command' 时传入，
   *   undefined = 非 bash 走普通 send。调用方控制流保证此契约（Composer.vue 按 type 分支）。
   *
   * presetId（preset 透传）：landing 态用户在 PresetSelectChip 选定的预设（pendingPreset，
   * 经 setPendingPreset 写入）与全局默认预设（defaultPresetId）都作为 resolveLaunchConfig
   * 的输入——透传的是 resolve 终值（D3：默认预设首次真正生效；出厂 builtin:full →
   * undefined 不透传，行为与写入面全等现状）。pendingPreset 仍是用户显式选择的单一真源
   * （PresetSelectChip emit select → Landing.vue onPresetSelect → flow.setPendingPreset）。
   */
  /**
   * create 分支：未绑定 session 时经 createSessionFlow 建 session 并绑定，返回迁移后
   * segments（null = 空 content guard 命中，调用方 abort send）。
   */
  async function createSessionForSubmit(
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ): Promise<Segment[] | null> {
    // D1 加载窗口语义：create 前等全部解析数据源就绪——core KV 双源（lastUsedModel +
    // 记忆表，launch-config 直接 import）+ 壳侧异步源（ports.launchConfig.ensureReady，
    // 如 preset store 惰性加载）。ensureReady 失败按 E1/E4 收敛不阻塞发送（catch 放行，
    // resolve 回落默认档），同步抛错一并兜底；allSettled = 两独立源各自收敛/降级，
    // 一方失败不阻塞另一方完成（KV 源自身永不 reject）。
    const shellReady = launchPort
      ? Promise.resolve()
        .then(() => launchPort.ensureReady())
        .catch(() => undefined)
      : Promise.resolve()
    await Promise.allSettled([ensureLaunchDataReady(), shellReady])
    // D1 单一解析层：submit 侧消费 resolve 终值（pending 三兄弟 + Composer authored 档位
    // 作 explicit 输入，覆盖壳侧数据基座）——与显示侧（chip）同一 resolve 输出，
    // 「显示 ≡ 生效」由构造成立
    const resolved = resolveLaunchConfig({
      ...(launchPort?.getInput() ?? buildFallbackLaunchInput()),
      pendingModel: pendingModel.value,
      pendingPreset: pendingPreset.value,
      pendingCwd: pendingCwd.value,
      pendingThinkingLevel: thinkingLevel ?? null,
    })
    // C-NT-2：session 创建部分改调注入的 createSessionFlow 端口（SessionFlowPort，
    // 契约对齐 domain/session/createSessionFlow IF5）。壳把 createSessionFlow(ctx, input)
    // 包成端口实现（ctx 的 store/api/defaultCwd/onCwdFallback 由壳组装）。
    // createSessionFlow 内部做：guard→cwd 兑底→label 派生→create→INV-7 降级（含 E7
    // 两空提示）→appendSession→migrateImages，返回 {session, migratedSegments} | null
    // （null=空 content guard）。post-create apply（applyModel / setThinkingLevel）已随
    // D5 契约快照化删除——override 经 create 一次到位。
    const input: CreateSessionFlowInput = {
      // cwd 链现行为不变（D2）：pendingCwd → createSessionFlow ctx.defaultCwd 兜底 →
      // runtime INV-7 降级，不消费 resolve.cwd
      cwd: pendingCwd.value,
      // D3：透传 resolve 终值 presetId（出厂 builtin:full → undefined 不透传，
      // 行为与写入面全等现状）
      presetId: resolved.presetId ?? null,
      // D5 契约快照化：恒传解析终值（'' 全链空防御形态不上线——回落 runtime 全局默认）
      pendingModel: resolved.model || null,
      segments,
      bashCommand: bashCommand ?? null,
      // resolve 输出已是 value 域（launch-config LaunchConfig.thinkingLevel 契约：
      // authored/preset 档原样，memory/最高档经 thinkingLevelMap 转 value），cast 消除
      // string→ThinkingLevel 类型差（同改线前 Composer emit 值域先例）
      pendingThinkingLevel: resolved.thinkingLevel as ThinkingLevel,
    }
    const result = await ports.createSessionFlow.createSession(input)
    // 空 content guard 命中（createSessionFlow 返回 null）→ abort send（不 send，session 未创建）
    if (!result) return null
    controller.bindCurrentSession(result.session)
    // [D5] C-W4-3 setThinkingLevel 补 apply 已删：landing 恒传终值后它是对每个新
    // session 的同值二次 RPC，thinkingOverride 经 create 快照化一次到位。
    // createSessionFlow 已迁移 needsMigrate image 段（path 更新 + needsMigrate 重置），
    // 壳直接用 result.migratedSegments 做 send（不重复迁移）。
    return result.migratedSegments
  }

  /**
   * retry/预建分支：session 已存在，不调 createSessionFlow。landing 态 tmpdir image 段
   * （用户重试时新贴的图）经 migrateImageSegments 单源迁移（createSessionFlow 未跑，
   * migration 未发生）；partial-fail toast 判定留本编排层（session 域原语不管 UI 提示）。
   */
  async function migrateRetryImages(segments: Segment[]): Promise<Segment[]> {
    const { segments: finalSegments, migratedCount, total } = await migrateImageSegments(
      segments,
      currentSession.value!.id,
      (p) => ports.migrateImage.migrateImage(p),
      { logTag: 'useNewTaskFlow' },
    )
    if (migratedCount < total) {
      // 部分迁移失败：toast 提示（不阻断发送）
      ports.toast.warning(
        ports.t('composable.imageMigratePartialFailed', {
          count: total - migratedCount,
        }),
      )
    }
    return finalSegments
  }

  /**
   * 交接三步（setActiveSession + loadPanel + pushChat）+ 终态定格 + 发送。
   *
   * [D3 交接原子化] landing→completed 在交接点定格：交接完成即 flow 职责终结——这是
   * 「流程状态机只守自己不变量」的正确语义。send 成败属于 session 的错误通道（useChat
   * W2 内部吞错只 toast），与 flow 状态机无关，flow 终态不应依赖它——send 链路未来任何
   * 演化（恢复 throw、新增前置抛错点）都不再影响 flow 终态（时序正确性 + 防御加固，
   * 原设计 §3.3 D3，文档已删除、git 可追溯）。
   */
  async function handoverAndSend(
    newSid: string,
    finalSegments: Segment[],
    bashCommand?: { command: string; excludeFromContext: boolean },
  ): Promise<void> {
    ports.navigation.setActiveSession(newSid)
    ports.navigation.loadPanel(ports.navigation.activePanelId(), newSid)
    ports.navigation.pushChat(newSid)
    transition('completed')
    // 文件树预加载：新建 session 后侧栏「文件」tab 计数（fileCount 读 store.getTree）立即更新。
    // fire-and-forget：失败不阻断首发发送（文件树缺失仅致 tab 计数为 0）。
    void ports.fileTree.loadTree(newSid)
    // per-session sid：显式传 newSid，不依赖全局 activeId（双 panel 隔离）
    // tmpdir 迁移已在上方分支完成（create 分支=createSessionFlow.migratedSegments，
    // retry 分支=migrateRetryImages），finalSegments 即迁移后的段。bashCommand 无图片段，无副作用。
    // 发送阶段：bash 首发（landing 态 !/!! 前缀）走 sendBash，否则普通 send
    // bash 不经 segments（原始 shell 文本透传 pi bash RPC），finalSegments 仅用于 tmpdir 迁移流程（bash 无图片段，无副作用）
    if (bashCommand) {
      await ports.chat.sendBash(newSid, bashCommand.command, bashCommand.excludeFromContext)
    } else {
      await ports.chat.send(newSid, finalSegments)
    }
  }

  async function submitFirstMessage(
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ): Promise<void> {
    // segments 不能为空；含 text 段时提取首段文本作 session label
    const firstTextSeg = segments.find((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
    const trimmed = firstTextSeg?.text?.trim() ?? ''
    // 含图片/文件/skill 等非 text 段但无文本也允许发送（用户可能只贴图不写字）
    const hasOnlyNonText = segments.some((s) => s.type !== 'text')
    if (!trimmed && !hasOnlyNonText) return
    if (state.value !== 'landing') {
      throw new Error('NewTaskFlow: 非 landing 态不可首发提交')
    }
    if (createInFlight.value) return
    controller.setCreateInFlight(true)
    try {
      let finalSegments = segments
      // 未选目录直接发送（用默认 cwd 兑底 create），或重试场景已绑定
      if (!currentSession.value) {
        const migrated = await createSessionForSubmit(segments, thinkingLevel, bashCommand)
        if (migrated === null) return
        finalSegments = migrated
      } else {
        finalSegments = await migrateRetryImages(segments)
      }
      // 载入 panel + 设 activeId（预建或刚建统一处理）
      await handoverAndSend(currentSession.value!.id, finalSegments, bashCommand)
    } finally {
      controller.setCreateInFlight(false)
    }
  }

  /**
   * presetCwd —— landing 态回灌预设 cwd（启动编排用，G1.1「沿用最近 session 目录」）。
   *
   * 与 startFlow(presetCwd) 同语义（写 pendingCwd → chip 所见即所得），但用于 startFlow
   * 已先进 landing、cwd 还需异步加载后才确定的场景：
   * initApp 必须在 await loadSessions() **之前**同步 startFlow() 进 landing，否则
   * 「连接成功→AppShell 渲染 Landing」与 startFlow 之间会有 flow.state=idle 的启动窗口，
   * 此时点 directory chip 触发 idle→dir-popover 非法转换抛错。故顺序定为先 startFlow（空 chip）
   * → loadSessions → presetCwd 回灌。
   *
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   */
  function presetCwd(cwd: string): void {
    if (state.value !== 'landing') return
    pendingCwd.value = cwd
  }

  /**
   * setPendingModel —— landing 态记录用户选定但尚未透传的模型。
   *
   * landing 态 session 尚未 create，无法调 model.switch RPC。记 pendingModel 供 Composer
   * 显示所选模型（currentModel computed），首发提交时经 resolveLaunchConfig 终值随
   * create payload 快照透传（D5，无 post-create apply）。
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   * payload 为 "provider/modelId" 复合串（ModelSelectPopover emit 的格式约定）。
   */
  function setPendingModel(model: string): void {
    if (state.value !== 'landing') return
    pendingModel.value = model
  }

  /**
   * setPendingPreset —— landing 态记录用户选定但尚未透传的预设 id。
   *
   * 对齐 pendingCwd/pendingModel 范式。PresetSelectChip emit select 时调用，
   * submitFirstMessage create session 时透传给 sessionApi.create。
   *
   * 守卫（[HISTORICAL]「选模式后不生效」缺陷根修）：模式选择发生在 PresetSelectChip 的
   * preset-popover overlay 内——用户先点 chip 展开列表（`openPresetPopover` 把 state 置为
   * `preset-popover`），再点选项，此时写入点的 state 恒为 `preset-popover` 而非 `landing`。
   * 原守卫 `state !== 'landing'` 把这次真实选择静默丢弃：pendingPreset 恒 null → chip 文案
   * 不回显（Landing 的 modeName 源自 pendingPreset）+ 建出的 session launchPresetId=undefined。
   * preset-popover 是 landing 上下文的 overlay（打开态由 Landing 的 isPresetOpen 绑定、
   * 选择在列表内原地完成），与 landing 同属「选择进行中」态，一并放行；
   * 其余 overlay（dir/branch/modal）与终态仍 noop，防污染别的流程。
   */
  function setPendingPreset(presetId: string): void {
    if (state.value !== 'landing' && state.value !== 'preset-popover') return
    pendingPreset.value = presetId
  }

  /**
   * adoptWorktreeCwd —— CreateWorktreeModal 创建成功即回灌新 worktree cwd（不待 modal 关闭）。
   *
   * 与 selectWorkspace 的差异：只写 pendingCwd + 热更新最近工作区，**不 transition**——
   * modal 成功屏展示期间 state 保持 worktree-modal，关闭（2s 定时器 / 用户提前关）统一走
   * closeOverlay → landing，状态机出口唯一。
   * [HISTORICAL] 旧链路 success emit 挂在 modal 的 2s 展示定时器上：用户在窗口内关 modal
   * （Esc/点外/X/切 session）→ modal 卸载清 timer → 切换静默丢失（chip 留旧目录，且首发提交
   * create 落旧目录）。根修：切换与「创建成功」同刻发生，与 modal 生命周期解耦。
   * 守卫：仅 worktree-modal 态生效（modal 仅在该态挂载，防御性）；同值 noop（对齐 selectWorkspace）。
   */
  function adoptWorktreeCwd(cwd: string): void {
    if (state.value !== 'worktree-modal') return
    if (cwd === currentCwd.value) return
    pendingCwd.value = cwd
    // 热更新最近工作区列表（对齐 selectWorkspace：record 写 runtime，刷新回补 store）
    void workspaceState.record(cwd)
  }

  // ── compose 子模块（分支 + 选目录）── 传 computed 值的 getter，解耦于父内部 ──
  // branch 子模块需要飞行标记 setter + 守卫失败回 idle 的 transitionUnchecked，
  // 由父编排器从独占 controller 中按需注入（setter 不再模块级 export，无法被子模块直接 import）。
  const branch = useNewTaskBranch(
    gitApi,
    () => currentSessionId.value,
    () => gitInfo.value,
    () => currentCwd.value,
    {
      setBranchCreateInFlight: controller.setBranchCreateInFlight,
      transitionUnchecked: controller.transitionUnchecked,
    } satisfies NewTaskBranchController,
  )
  /**
   * 任意 overlay→landing（Esc/点外）。同一时刻只一层（AC-3.9）。幂等：仅当前处于 overlay 态
   * 才转换，否则 noop——避免重复调用导致 landing→landing 非法转换（state 被打回 idle）。
   *
   * [HISTORICAL] 重复调用来源：worktree/branch 成功回调先 selectWorkspace（已 transition('landing')）
   * 再 closeOverlay，加上 modal @close 又触发一次 closeOverlay，叠加成 landing→landing 非法转换
   * → transition 非法分支置 state='idle' → 用户在 landing 页提交时撞 submitFirstMessage 的
   * `state !== 'landing'` guard 报「非 landing 态不可首发提交」。渲染判定（Panel isLandingView
   * 看 sessionId prop）与提交 guard（看 flow.state）真源不一致，导致「明明在 landing 页却报非 landing」
   * 的诡异现象。幂等化根因修复，所有正常调用点（来源态均 overlay）行为不变。
   */
  function closeOverlay(): void {
    if (!OVERLAY_STATES.has(state.value)) return // 幂等：非 overlay 态 noop（已 landing/idle 等）
    transition('landing') // dir-popover/branch-popover/dir-dialog/branch-modal/worktree-modal → landing
  }

  /** landing/overlay→cancelled（overlay 打开时切 session，AC-3.10）。 */
  function cancelFlow(): void {
    transition('cancelled')
  }

  /** cancelled→landing（重选空 session 复活，AC-3.3）。 */
  function reenterFlow(): void {
    transition('landing')
  }

  /**
   * [HISTORICAL] landing→completed 薄封装，保留为 API 完整性。D3 交接原子化后主线
   * 终态在 submitFirstMessage 交接点定格（setActiveSession + loadPanel + pushChat 完成
   * 即 transition('completed')，见其内注释），本函数不再处于首发主线。
   * completed 后实例销毁，⌘N 再触发重建（AC-3.6/3.12）。
   */
  function completeFlow(): void {
    transition('completed')
  }

  /**
   * openPresetPopover —— 点 PresetSelectChip 打开 preset popover（landing→preset-popover）。
   *
   * overlay 互斥由 openOverlay 统一处理（已开任意 overlay 时先归 landing 再开 preset-popover）。
   * preset 不涉及 git 守卫（任何 landing 态均可开），故内联在主 controller 而非拆独立模块。
   */
  function openPresetPopover(): void {
    openOverlay('preset-popover')
  }

  return {
    state,
    currentSession,
    currentSessionId,
    currentCwd,
    currentModel,
    gitInfo,
    isInflight: createInFlight,
    isBranchCreating: branch.isBranchCreating,
    isOverlay: computed(() => OVERLAY_STATES.has(state.value)),
    isActive: computed(() => ACTIVE_STATES.has(state.value)),
    startFlow,
    submitFirstMessage,
    presetCwd,
    setPendingModel,
    setPendingPreset,
    /**
     * [U4r2] landing 态显式选定 preset id 只读视图（写经 setPendingPreset，读写分离——
     * 对齐 pendingModel 经 currentModel 的只读暴露先例）。消费方：composer-shell 把它
     * 接入 model-thinking 的 pendingPreset 通道，使 chip 侧 resolve 输入含显式 preset
     * 选择（与 submit 侧同源同输入，「显示 ≡ 生效」全矩阵成立）。
     */
    pendingPreset: computed(() => pendingPreset.value),
    openDirPopover: dirSelect.openDirPopover,
    openBranchPopover: branch.openBranchPopover,
    openPresetPopover,
    selectWorkspace: dirSelect.selectWorkspace,
    adoptWorktreeCwd,
    openDirDialog: dirSelect.openDirDialog,
    selectBranch: branch.selectBranch,
    confirmDirtySwitch: branch.confirmDirtySwitch,
    openBranchModal: branch.openBranchModal,
    submitCreateBranch: branch.submitCreateBranch,
    openCreateWorktree: dirSelect.openWorktreeModal,
    isBare: dirSelect.isBare,
    mode: dirSelect.mode,
    worktreeItems: dirSelect.worktreeItems,

    closeOverlay,
    cancelFlow,
    reenterFlow,
    completeFlow,
  }
}
