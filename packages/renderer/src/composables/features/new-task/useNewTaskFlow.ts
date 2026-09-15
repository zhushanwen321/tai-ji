/**
 * useNewTaskFlow —— 新建任务流程编排（壳适配版，new-task-search 域 w5）。
 *
 * [归位] w2 core flow.ts 迁入 core 域后，本文件改写为壳：构造 NewTaskFlowDeps
 * （12 端口适配 renderer api/stores/composables，与旧实现逐条对齐）+ 模块级单例缓存
 * core useNewTaskFlow 实例。Landing.vue 与 useSidebar 都调本壳拿同一 core 实例
 * （core flow-state 是 core 包模块级单例，renderer 旧 useNewTaskFlowState 是 renderer 包
 * 模块级单例，两套互不相通——双状态机会断裂，故必须统一实例）。
 *
 * 端口适配映射（C-NT-2 / C-SS-2 / D8 裁决）：
 * - createSessionFlow：core domain/session createSessionFlow(ctx, input) 包一层
 *   （ctx 的 store/api/defaultCwd/onCwdFallback 由本壳组装）
 * - chat：useChat().send / sendBash
 * - navigation：useSessionStore().activeId + usePanelStore().loadSession +
 *   useNavigationStore().push + useWorkspaceStore().defaultCwd
 * - toast：useToast().error / warning
 * - fileTree：useFileTree().loadTree + useFileTreeStore().selectFile
 * - t：i18n.global.t
 * - migrateImage：sessionApi.migrateImage
 * - launchConfig（U2d 接线）：preset store 数据基座 + usePiPresets().loadPresets 就绪源
 *   + settings 单例 getters + core KV 双源（lastUsedModel / 记忆表）——submit 侧
 *   resolveLaunchConfig 获得完整输入（preset 档透传恢复，D3 默认预设生效化）
 * - gitApi：@/api git domain（checkout/checkoutByCwd/createBranch）
 * - directoryPicker：lib/ipc pickDirectory
 * - workspaceApi：@/api workspace.detect + worktreeApi.list
 * - workspaceState：useWorkspaceStore().defaultCwd / record
 *
 * 公共 API 兼容：useNewTaskFlow() 返回类型与旧版逐字段对齐（core flow 返回面一致）；
 * resetNewTaskFlow / NewTaskFlowState / GitInfo 重导出改从 @taiji/core（旧消费方
 * 与测试 import 路径不变即获得 core 版）。
 */
import { session as sessionApi, git as gitApi, workspace as workspaceApi } from '@/api'
import { createSessionFlow, getSettingsStore, useNewTaskFlow as useCoreNewTaskFlow } from '@taiji/core'
import type { CreateSessionFlowCtx, LaunchConfigPort } from '@taiji/core'
import { lookup as lookupRememberedLevel, lookupLastUsedModel } from '@taiji/core/domain/composer'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { useProjectStore } from '@/stores/project'
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'
import { usePresetStore } from '@/stores/preset'
import { useChat } from '@/composables/features/chat/useChat'
import { usePiPresets } from '@/composables/features/settings/usePiPresets'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useToast } from '@/composables/useToast'
import { worktreeApi } from '@taiji/core/transport/api/domains/worktree'
import { pickDirectory } from '@/lib/ipc'
import { buildSessionApiPort } from '@/api/session-api-port'
import i18n from '@/i18n'
// supportedLevelsOf：显示侧（composer-shell）与 submit 侧共用的唯一实现（F5，实现单源
// core new-task-search/supported-levels.ts，本目录 shim re-export——独立文件形态防
// composer 系列测试对本模块的整体 mock 波及 composer-shell 的 import 链）
import { supportedLevelsOf } from './supported-levels'

const t = i18n.global.t

// 重导出供既有 import 消费（types + reset 原从本模块导入，改从 core 获得）
export type { NewTaskFlowState, GitInfo } from '@taiji/core'
export { resetNewTaskFlow } from '@taiji/core'

/** 模块级单例（Landing 与 useSidebar 共享同一 core flow 实例）。 */
let cachedFlow: ReturnType<typeof useCoreNewTaskFlow> | null = null

/** 仅测试用：重置单例（pinia 重建后旧实例捕获的 store 引用失效，beforeEach 调；对齐 core reset 先例）。 */
export function __resetNewTaskFlowForTesting(): void {
  cachedFlow = null
}

/**
 * [U2d] LaunchConfigPort 壳适配——submit 侧 resolveLaunchConfig 的完整数据基座：
 * - preset 档：presetStore（presets / defaultPresetId；core 无镜像，接线前该档不可达）
 * - providers / defaultModel / getSupportedLevels：settings 单例（与显示链同源）
 * - lastUsedModel / 记忆表：core 域 KV 单例（经 composer barrel 别名导出读取）——
 *   getInput 返回值整体替换 core fallback 基座（flow.ts spread 语义），KV 字段缺失会
 *   使 lastUsed/memory 档在 submit 侧丢失、与显示链（直接 import）发散，必须覆盖
 * - ensureReady：loadPresets 拉最新 preset 数据（allSettled 收敛，失败回落默认不阻塞）
 */
function buildLaunchConfigPort(
  presetStore: ReturnType<typeof usePresetStore>,
  settings: ReturnType<typeof getSettingsStore>,
  loadPresets: () => Promise<void>,
): LaunchConfigPort {
  return {
    getInput: () => ({
      presets: presetStore.presets,
      defaultPresetId: presetStore.defaultPresetId || null,
      providers: settings.providers?.value,
      defaultModel: settings.defaultModel.value,
      getSupportedLevels: (modelId) => supportedLevelsOf(modelId, settings.providers?.value ?? []),
      lastUsedModel: lookupLastUsedModel(),
      getRememberedThinkingLevel: (modelId) => lookupRememberedLevel(modelId),
    }),
    ensureReady: () => loadPresets(),
  }
}

/**
 * 新建任务流程编排器（壳）。返回 core useNewTaskFlow 实例（单例缓存）。
 */
export function useNewTaskFlow() {
  if (cachedFlow) return cachedFlow
  const session = useSessionStore()
  const workspaceStore = useWorkspaceStore()
  const projectStore = useProjectStore()
  const panel = usePanelStore()
  const navigation = useNavigationStore()
  const chat = useChat()
  const { error: toastError, warning: toastWarning } = useToast()
  // [U2d] launch 配置解析数据源：preset store（presets/defaultPresetId）+ 惰性加载编排
  //（usePiPresets.loadPresets 内部 allSettled 永不 reject——E1/E4 收敛语义）+ settings
  // 单例（与显示链 composer-shell 同一 getSettingsStore，两链同源）
  const presetStore = usePresetStore()
  const { loadPresets } = usePiPresets()
  const settings = getSettingsStore()

  cachedFlow = useCoreNewTaskFlow({
    ports: {
      launchConfig: buildLaunchConfigPort(presetStore, settings, loadPresets),
      createSessionFlow: {
        // 会话创建编排（guard→cwd 兜底→label→create→INV-7 降级→appendSession→migrateImages）
        createSession: async (input) => {
          const ctx: CreateSessionFlowCtx = {
            // pinia useSessionStore cast——createSessionFlow 只调 store.appendSession
            // （方法调用，pinia proxy 方法调用正常），不碰 ref，故 cast 可行。
            store: session as unknown as CreateSessionFlowCtx['store'],
            api: buildSessionApiPort(),
            defaultCwd: workspaceStore.defaultCwd ?? '',
            // INV-7 cwd 降级比对：runtime create 内部可能降级 homedir，比对不一致 toast 通知。
            // E7（D10）两空分支：reqCwd 空串 = landing 未选目录且无 defaultCwd（create('') 落
            // 主目录，非「目录不存在」），用专属文案；非空 = 既有 INV-7 降级文案（行为不变）。
            onCwdFallback: (reqCwd) =>
              toastError(reqCwd ? t('composable.dirNotExist', { dir: reqCwd }) : t('composable.cwdFallbackToHome')),
          }
          // D14 语义修正（2026-08-04）：归属 project 经 input 透传——创建时归属当前
          // activeProject（与 cwd 无关，project 可跨目录）。默认项目不传（undefined = 未归类，
          // 读取侧统一兑底默认项目，不写 sidecar）。fork 路径不走 createSessionFlow
          //（useForkActions 直接 sessionApi.fork），fork 在 runtime 侧继承父归属。
          const result = await createSessionFlow(ctx, {
            ...input,
            projectId: projectStore.isDefaultProject ? undefined : projectStore.activeProjectId,
          })
          return result
        },
      },
      chat: {
        send: (sid, segments) => chat.send(sid, segments),
        sendBash: (sid, command, excludeFromContext) =>
          chat.sendBash(sid, command, excludeFromContext),
      },
      navigation: {
        activePanelId: () => panel.activePanelId,
        loadPanel: (panelId, sid) => {
          if (!panelId) return // 无活跃 panel 时 noop（core 契约）
          panel.loadSession(panelId, sid)
        },
        clearActiveSession: () => {
          session.activeId = null
        },
        setActiveSession: (sid) => {
          session.activeId = sid
        },
        pushChat: (sid) => navigation.push({ view: 'chat', sessionId: sid }),
        defaultCwd: () => workspaceStore.defaultCwd ?? null,
      },
      toast: {
        error: (msg) => toastError(msg),
        warning: (msg) => toastWarning(msg),
      },
      fileTree: {
        loadTree: (sid) => useFileTree().loadTree(sid),
        selectFile: (path) => useFileTreeStore().selectFile(path),
      },
      t,
      migrateImage: {
        migrateImage: (p) => sessionApi.migrateImage(p),
      },
    },
    gitApi: {
      checkout: (sid, name) => gitApi.checkout(sid, name),
      checkoutByCwd: (cwd, name) => gitApi.checkoutByCwd(cwd, name),
      createBranch: (sid, name) => gitApi.createBranch(sid, name),
    },
    directoryPicker: {
      pickDirectory: (p) => pickDirectory(p),
    },
    workspaceApi: {
      detect: (cwd) => workspaceApi.detect(cwd),
      listWorktrees: (cwd) => worktreeApi.list(cwd),
    },
    workspaceState: {
      defaultCwd: () => workspaceStore.defaultCwd ?? null,
      record: (cwd) => workspaceStore.record(cwd),
    },
  })
  return cachedFlow
}
