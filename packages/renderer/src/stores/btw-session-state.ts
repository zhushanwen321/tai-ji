/**
 * btw-session-state —— 旁路线（btw vid）的模型/思考档显示态 store。
 *
 * 为什么存在：btw 线是 hidden 会话（SessionScanner.listAll 过滤，不入 sessionStore.list），
 * `session.state_changed` 回执经 sessionStore.applySnapshot 对未知 id 静默丢弃——线的模型态
 * 在渲染层结构性不可达，composer 模型/档位显示恒为空占位「…」。
 *
 * 本 store 只持「线自身切换回执」这一种真值（useModel switchModel / setThinkingLevel 的
 * RPC 回执生效值，U6 口径）：
 * - 初次打开线（无回执）时显示回退 = 主会话当前态。事实依据 = fork 继承：线 spawn 用
 *   `model: undefined + inheritSessionModel: true`（btw-line-spawn-options.ts），模型终态
 *   从 fork 快照（= 主会话创建线当时的模型）经 entry 恢复；
 * - 回退与线真值的分歧（用户在该线切过模型后）由回执覆盖；pi 侧静默换模（无 renderer
 *   回执）不回显——权威推送/拉取通路缺口登记 docs/todo/btw-line-model-state.md。
 *
 * mainSid 绑定：btw.list / btw.create reply 的 mainSid（BtwPanel 拉取/建线时写入），
 * 供回退解析「该线归属哪个主会话」——vid 本身只编码线的 pi 会话 id，不含主会话。
 */
import { defineStore } from 'pinia'
import { isBtwVirtualId } from '@taiji/shared'

/** 线自身切换回执态（字段缺省 = 该维从未回执，解析时整维回退主会话）。被动数据形状，非多态契约。 */
export type BtwLineModelState = {
  modelId?: string
  thinkingLevel?: string
}

export const useBtwSessionStateStore = defineStore('btw-session-state', {
  state: (): { modelByVid: Record<string, BtwLineModelState>; mainSidByVid: Record<string, string> } => ({
    modelByVid: {},
    mainSidByVid: {},
  }),
  actions: {
    applyModelState(vid: string, patch: BtwLineModelState): void {
      if (!isBtwVirtualId(vid)) return
      const prev = this.modelByVid[vid] ?? {}
      this.modelByVid[vid] = {
        modelId: patch.modelId ?? prev.modelId,
        thinkingLevel: patch.thinkingLevel ?? prev.thinkingLevel,
      }
    },
    bindMainSid(vid: string, mainSid: string): void {
      if (!isBtwVirtualId(vid) || !mainSid) return
      this.mainSidByVid[vid] = mainSid
    },
    forget(vid: string): void {
      delete this.modelByVid[vid]
      delete this.mainSidByVid[vid]
    },
  },
})

/**
 * composer 壳层 getSessionState 的 btw 解析（纯函数，便于穷举单测）：
 * btw vid → 线回执态（缺维回退主会话同维）→ 无绑定/主会话不在列表 → null。
 * 非 btw id 原样走主列表查找（调用方不必预分支）。
 *
 * @param sid 会话 id（主会话 id 或 btw vid）
 * @param list 主会话摘要列表（sessionStore.list，含 modelId/thinkingLevel 字段）
 * @param lineStateOf vid → 线回执态（store 读取函数，注入便于测试）
 * @param mainSidOf vid → 归属主会话（store 读取函数，注入便于测试）
 */
export function resolveComposerSessionState(
  sid: string,
  list: ReadonlyArray<{ id: string; modelId: string; thinkingLevel?: string }>,
  lineStateOf: (vid: string) => BtwLineModelState | undefined,
  mainSidOf: (vid: string) => string | undefined,
): { modelId: string; thinkingLevel?: string } | null {
  const findInList = (id: string) => {
    const s = list.find((x) => x.id === id)
    return s ? { modelId: s.modelId, thinkingLevel: s.thinkingLevel } : null
  }
  if (!isBtwVirtualId(sid)) return findInList(sid)

  const line = lineStateOf(sid)
  const mainSid = mainSidOf(sid)
  const main = mainSid ? findInList(mainSid) : null
  // 维度级回退：线回执过的维度用回执值，未回执维度回退主会话同维（fork 继承事实）
  if (line?.modelId || line?.thinkingLevel) {
    return {
      modelId: line.modelId ?? main?.modelId ?? '',
      thinkingLevel: line.thinkingLevel ?? main?.thinkingLevel,
    }
  }
  return main
}
