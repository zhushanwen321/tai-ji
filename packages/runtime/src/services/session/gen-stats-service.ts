/**
 * gen-stats-service.ts — Composer 生成指标（token 速度 + 缓存命中率 + TTFT 首字延迟）
 * 采样/帧合成/广播服务（composer-gen-stats u3-wiring / P3；TTFT 归属
 * composer-genstats-ttft §3.3——逐字段独立判定，与 speed/cache 解耦）。
 *
 * 职责边界：存储算法 SSOT 在 gen-stats-store.ts（本文件只调用，不重实现聚合/文件名/GC）；
 * bogus 丢弃判定在本服务采样入口执行（store 只提供阈值常量 + 纯谓词，D7）；sid→modelKey
 * 反向映射生命周期 = 三写一清 + 前端帧校验兜底（D4，被否谱系⑥：单点登记被脏映射/漏登记击穿）：
 *   - 写 1  recordSample            采样登记（该 session 当时模型的样本）+ per-session current 槽
 *   - 写 2  onModelSwitched         模型切换重登记 + 顺带推新模型帧（MF7/MF9）
 *   - 写 3  onSnapshotResolved       恢复腿降级链解析成功回填（覆盖「新 session 未采样」缺口）
 *   - 清    registerSessionCleanup   session 销毁（removeSessionEntry 汇聚点）删该 sid 全部条目
 *                                    （映射 + per-session current 槽）
 *
 * 固定帧序（MF9，构造性闭合）：同一触发点内「先广播 state_changed → 再重登记映射 →
 * 最后推帧」。本服务的 onModelSwitched 由 session-service 的 state_changed 发布挂钩
 * （组合根 tap 接线）在 bus.publish(state_changed) 同步返回后调用——单 WS 连接有序送达，
 * 发布先于挂钩即帧序成立，无需时间戳/序号仲裁。
 *
 * 显示语义 = 混合视角（current 会话隔离）：
 *   - speed.current / cacheRatio.current = **本会话**最近一次合法请求样本（sessionCurrent
 *     内存槽，按 modelKey 匹配；本会话切回旧模型可复现该模型旧样本）。无回落纪律：本会话
 *     无样本恒 null（UI「—」），绝不回落到模型全局末条——回落即跨会话串台；
 *   - speed.day/d7/d30 / cacheRatio.day = 该模型滚动窗口跨会话加权聚合（磁盘 per-model
 *     文件；同模型多 session 聚合值相同是预期行为）。
 *   per-session current 纯内存、runtime 重启清零（重启后「—」到本会话下个 turn；聚合仍从
 *   磁盘恢复）。无值编码纪律 [HISTORICAL]：全帧无值一律 null（null=无数据），禁止 ?? 0——
 *   0 只允许作为真实测量值出现。
 */

import type { GenStatsCacheRatio, GenStatsFrame, GenStatsSpeed, GenStatsTtft, ServerMessage } from '@taiji/shared'
import { logger } from '../../infra/logger.js'
import type { ISessionService } from '../../interfaces.js'
import { getOrCreate } from '../../utils/collections.js'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { GenStatsSample } from './types.js'
import {
  aggregateCacheRatio,
  aggregateSpeed,
  aggregateTtft,
  cacheRatioFilePath,
  isBogusSpeedSample,
  localDayKey,
  PAIR_RECORD_TUPLE_LENGTH,
  readDayRecords,
  speedFilePath,
  TTFT_RECORD_TUPLE_LENGTH,
  ttftFilePath,
  writeDayRecords,
  type CacheRatioRecord,
  type GenStatsDayRecords,
  type GenStatsRecord,
  type SpeedRecord,
  type TtftRecord,
} from './gen-stats-store.js'

/**
 * 模型全局聚合层（不含 sessionId / current——current 是会话私有值，由 composeFrame 合并）。
 * modelKey 非 null 恒回填 model（R5/MF8，含该模型无记录的全 null 帧）；null（降级链④走尽）缺省。
 */
interface ModelAggregates {
  speed: Omit<GenStatsSpeed, 'current'>
  cacheRatio: Omit<GenStatsCacheRatio, 'current'>
  ttft: Omit<GenStatsTtft, 'current'>
  model?: string
}

/**
 * per-session current 槽（会话视角 current 的权威源）：速度/命中率/TTFT 三槽独立、各自携带来源
 * modelKey——单边无效样本只跳过该边（另一边保留上一条合法值），展示与否由 modelKey 匹配决定。
 */
interface SessionCurrentEntry {
  speed?: { modelKey: string; record: SpeedRecord }
  cache?: { modelKey: string; record: CacheRatioRecord }
  ttft?: { modelKey: string; record: TtftRecord }
}

/**
 * 本次采样刚落盘的日记录（persistSample → modelAggregates 传值，消「写后即读」冗余 IO）。
 * 字段缺省 = 该文件本次未写（guard 丢弃或写失败），聚合对应侧照旧读盘——
 * 写失败后帧内该侧值 = 盘上旧值，与重读行为一致（§3.5 容错语义不变）。
 * 字段按文件族参数化（ttft 单元素组与 speed/cache 二元组不同形，composer-genstats-ttft §3.3）。
 */
interface FreshDayRecords {
  speed?: GenStatsDayRecords<SpeedRecord>
  cache?: GenStatsDayRecords<CacheRatioRecord>
  ttft?: GenStatsDayRecords<TtftRecord>
}

/** 模型聚合层全 null 形态（降级链④走尽 / 模型无记录；current 由 composeFrame 单独合并） */
const NULL_SPEED_AGGREGATE: Omit<GenStatsSpeed, 'current'> = { day: null, d7: null, d30: null }
const NULL_CACHE_AGGREGATE: Omit<GenStatsCacheRatio, 'current'> = { day: null }
const NULL_TTFT_AGGREGATE: Omit<GenStatsTtft, 'current'> = { day: null, d7: null, d30: null }

/** 滚动窗口天数（day/d7/d30，含当日；30 与 store SPEED_RETENTION_DAYS 的 GC 窗口对齐） */
const WINDOW_DAYS = { day: 1, d7: 7, d30: 30 } as const

/** 本地日 key 的滚动窗口下界（含当日共 days 天；用日期分量回退避免 DST 毫秒偏移误差） */
function rollingWindowCutoff(now: Date, days: number): string {
  return localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)))
}

/**
 * modelKey → (provider, model)。modelKey 统一为复合 id `${provider}/${model}`：
 * 与 state_changed payload.modelId、switchModel 生效值读回（'provider/id'）同构；
 * 取首个 '/' 切分（provider id 不含 '/'；model id 含 '/' 时剩余段整体归 model，
 * 两侧生产方拼接规则一致 → 复合 key 可逆）。无 '/'（理论不可达，防御）→ 整体作 model。
 */
function splitModelKey(modelKey: string): { provider: string; model: string } {
  const idx = modelKey.indexOf('/')
  if (idx < 0) return { provider: '', model: modelKey }
  return { provider: modelKey.slice(0, idx), model: modelKey.slice(idx + 1) }
}

/**
 * 速度样本有效性判定 + 组装（SSOT）：磁盘落盘与 per-session current 槽共用同一谓词，
 * 防两处判定漂移。无效（真缺闭/缺起 / 0ms 退化 / bogus 阈值命中）→ null。
 */
function buildSpeedRecord(s: GenStatsSample): SpeedRecord | null {
  if (s.outputTokens === null || s.durationMs === null || s.durationMs <= 0) return null
  if (isBogusSpeedSample(s.outputTokens, s.durationMs)) return null
  return [s.outputTokens, s.durationMs]
}

/** 命中率样本有效性判定 + 组装（SSOT，同 buildSpeedRecord；promptTotal≤0 不采，D7③） */
function buildCacheRecord(s: GenStatsSample): CacheRatioRecord | null {
  const promptTotal = (s.input ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0)
  if (promptTotal <= 0) return null
  return [s.cacheRead ?? 0, promptTotal]
}

/**
 * TTFT 样本有效性判定 + 组装（SSOT，同 buildSpeedRecord；逐字段独立判定，与 speed/cache
 * 完全解耦——durationMs 缺失不影响 ttft 落盘，反之亦然）。ttftMs=null（无锚 / 窗口内无
 * 输出信号即结束 / image 等无内容流形态）→ null 跳过；ttftMs=0 是合法真实测量，禁判丢弃
 * （无值纪律：null=无数据，0 只允许为真实测量值）。
 */
function buildTtftRecord(s: GenStatsSample): TtftRecord | null {
  if (s.ttftMs === null) return null
  return [s.ttftMs]
}

/**
 * 窗口内（key >= cutoffDay）全部条目（YYYY-MM-DD 规范形字典序 = 时间序）。
 * T 进 T 出：调用点按文件族显式传 <SpeedRecord>/<CacheRatioRecord>/<TtftRecord>，
 * 入参即 GenStatsDayRecords<T>——禁 as 联合窄化（composer-genstats-ttft §3.3 R2 修订段：
 * as 会掩盖 ttft 单元素组类型冲突，原实现硬编码 Array<[number,number]> 即被改造）。
 */
function entriesSince<T extends GenStatsRecord>(records: GenStatsDayRecords<T>, cutoffDay: string): T[] {
  const out: T[] = []
  for (const [key, entries] of Object.entries(records)) {
    if (key >= cutoffDay) out.push(...entries)
  }
  return out
}

/** GenStatsService 装配依赖（窄注入，组合根 index.ts 构造）。 */
export interface GenStatsServiceDeps {
  /** session 级帧发送通道（组合根绑 MessageBus.publish——stats_update 定向推给订阅该 sid 的连接）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
  /** pi 进程管理（降级链① get_state 实时解析 modelId；pi 离线时 getClient undefined）。 */
  pm: IProcessManager
  /** session 服务（销毁清理挂 onSessionDestroyedHandlers + 降级链③ replicated states 双写缓存值）。 */
  sessionService: ISessionService
}

export class GenStatsService {
  /** sid → modelKey（复合 id 'provider/model'）。三写一清，见文件头注释。 */
  private readonly modelBySid = new Map<string, string>()

  /**
   * sid → per-session current 槽（会话视角 current 的权威源，纯内存、重启清零）。
   * 生命周期随 session：recordSample 写、registerSessionCleanup 删；迟到旧模型样本只更新
   * 槽内对应 modelKey 侧，展示与否由 composeFrame 的 modelKey 匹配决定。
   */
  private readonly sessionCurrent = new Map<string, SessionCurrentEntry>()

  constructor(private readonly deps: GenStatsServiceDeps) {}

  // ── 写 1 + 扩展广播：interpreter turn-usage 分支调用（同步，fire-and-forget）────────

  /**
   * 采样入口（D1/D7/D8）：写 1 登记映射 + 更新 per-session current 槽 → bogus guard 丢弃
   * 判定 → speed/cache-ratio 两文件各自 read→append→write 同步临界段（D8：单线程事件循环
   * + 同步 fs 天然串行化）→ ≥1 条样本落盘时对该模型全部已知 session 扩展广播（D4）。
   * sessionCurrent 槽更新与磁盘写解耦：写失败也更新（§3.5 当前帧照常推）。
   *
   * 丢弃规则（§3.5 / D7，丢弃不入聚合）：
   *   - model/provider 缺失 → 样本无法归属模型，整体跳过（防御，pi AssistantMessage 正常态必带）；
   *   - durationMs=null（真缺闭/缺起——pi 崩溃断连致闭合帧不到达，或 runtime 中途启动/
   *     丢 message_start 致无起算点，genstats-speed-llm-window.md D2/D3）→ 速度样本跳过，
   *     命中率样本照常；（D2 口径注，GS-5 精神延续：速度分母 durationMs = assistant message_start
   *     与 assistant message_end 两帧 RPC 传输延迟之差——单次 LLM 请求窗口，不含工具执行时间；
   *     毫秒级、方向不定，不做时钟校正）
   *   - outputTokens>50 && durationMs<100（store 谓词 SSOT）→ 速度样本丢弃；
   *   - promptTotal=input+cacheRead+cacheWrite ≤0 → 命中率样本不采集（cache 字段缺省按 0
   *     计入 promptTotal，D7③，有效性由本条兜底）。
   *
   * 写失败容错（§3.5）：单文件写失败 warn 后继续（另一文件照常、当前帧照常推），不抛出。
   */
  recordSample(sid: string, sample: GenStatsSample): void {
    const { model, provider } = sample
    if (!model || !provider) {
      // 防御分支（正常态 pi AssistantMessage 必带 model/provider）：debug 级，不刷 warn
      console.debug('[gen-stats] sample missing model/provider, skipped', { sessionId: sid })
      return
    }
    const modelKey = `${provider}/${model}`
    // 写 1：登记「该 session 当前模型」语义的映射（先于落盘——与写 2/写 3 一致，
    // 映射表达当前归属而非「有样本」，未采样的合法帧可达性由写 2/写 3 补全）。
    // D4 条件回写（adversarial-review-fixes §3.4 D4）：已登记为**其他**模型 key 时只落盘
    // 不回写——turn 中切模型后迟到的 usage 事件自带旧模型名，无条件 set 会把映射回写为
    // 旧模型，该 sid 从新模型的扩展广播集合漏收帧；样本仍落盘到自带 model 名下（归属
    // 正确），漏帧窗口交既有恢复腿（写 2 / getGenStats 降级链）自愈。未登记或同 key 才回写。
    const registered = this.modelBySid.get(sid)
    if (registered === undefined || registered === modelKey) {
      this.modelBySid.set(sid, modelKey)
    }

    // per-session current 槽（会话视角）：与磁盘写解耦——写失败也更新（§3.5 当前帧照常推）。
    // 槽按样本自带 modelKey 归属（迟到旧模型样本只进对应槽，不影响新模型 current）。
    this.updateSessionCurrent(sid, modelKey, sample)

    const fresh = this.persistSample(provider, model, sample)
    // 扩展广播（D4）：仅 ≥1 条样本落盘时推——无落盘则聚合值不变，推帧无信息量。
    if (fresh) this.broadcastModel(modelKey, fresh)
  }

  /**
   * per-session current 槽写入：只记「本会话该模型最近一次合法样本」。速度/命中率两槽
   * 独立更新——单边无效（bogus / promptTotal≤0）各自保留上一条合法值，与磁盘 append-only
   * 的「丢弃不入聚合」语义同构（§3.5）。
   */
  private updateSessionCurrent(sid: string, modelKey: string, s: GenStatsSample): void {
    const speedRecord = buildSpeedRecord(s)
    const cacheRecord = buildCacheRecord(s)
    const ttftRecord = buildTtftRecord(s)
    if (!speedRecord && !cacheRecord && !ttftRecord) return
    const entry = getOrCreate(this.sessionCurrent, sid, (): SessionCurrentEntry => ({}))
    if (speedRecord) entry.speed = { modelKey, record: speedRecord }
    if (cacheRecord) entry.cache = { modelKey, record: cacheRecord }
    if (ttftRecord) entry.ttft = { modelKey, record: ttftRecord }
  }

  /**
   * 样本落盘（D8 同步临界段；两个文件各自独立容错）。返回本次刚写盘的日记录（≥1 条
   * 写入成功时），供同一同步临界段内的 broadcastModel 聚合复用——单线程、无 await、
   * 无其他写者，刚写入的内存值与磁盘值恒等，免 modelAggregates 重读全文件（冗余 IO 消除，
   * 每样本 6 次全文件操作 → 4 次）；全部未写返回 null。字段缺省 = 该文件本次未写
   * （guard 丢弃或写失败），聚合对应侧照旧读盘（写失败后帧内值 = 盘上旧值，§3.5
   * 容错语义不变）。
   * 条目形状由 buildSpeedRecord / buildCacheRecord 组装（有效性判定 SSOT，与 per-session
   * current 槽共用）：durationMs>0 附加防 0ms 退化样本（蓝本同款仅 guard output×duration
   * 组合，此处补 0ms 一并排除——0ms 分母样本无信息量）。
   */
  private persistSample(provider: string, model: string, s: GenStatsSample): FreshDayRecords | null {
    const day = localDayKey()
    const fresh: FreshDayRecords = {}

    const speedRecord = buildSpeedRecord(s)
    if (speedRecord) {
      try {
        fresh.speed = this.appendRecord(speedFilePath(provider, model), day, speedRecord)
      } catch (err) {
        // §3.5：写失败 warn；内存聚合/当前帧照常推，下个 turn 重写自愈
        logger.warn('[gen-stats] speed record write failed', { provider, model, error: toMessage(err) })
      }
    }

    const cacheRecord = buildCacheRecord(s)
    if (cacheRecord) {
      try {
        fresh.cache = this.appendRecord(cacheRatioFilePath(provider, model), day, cacheRecord)
      } catch (err) {
        logger.warn('[gen-stats] cache-ratio record write failed', { provider, model, error: toMessage(err) })
      }
    }

    // ttft 逐字段独立判定（§3.3）：ttftMs != null 才写，与 speed/cache 判定互不干扰
    const ttftRecord = buildTtftRecord(s)
    if (ttftRecord) {
      try {
        fresh.ttft = this.appendRecord(ttftFilePath(provider, model), day, ttftRecord)
      } catch (err) {
        logger.warn('[gen-stats] ttft record write failed', { provider, model, error: toMessage(err) })
      }
    }
    return fresh.speed || fresh.cache || fresh.ttft ? fresh : null
  }

  /**
   * read→append→write 单同步临界段（D8；writeDayRecords 内含 30 天 GC + tmp+rename 原子写）。
   * T 进 T 出（entry 参数放宽至 GenStatsRecord 家族，§3.3 泛型化）：期望元组长度取自 entry
   * 自身长度（元组类型的运行时自描）——ttft 单元素组按长度 1 校验，不会被默认二元组校验
   * 当畸形丢弃（S8）；返回按 T 参数化的日记录，供 FreshDayRecords 家族化复用。禁 as 绕过。
   */
  private appendRecord<T extends GenStatsRecord>(filePath: string, day: string, entry: T): GenStatsDayRecords<T> {
    const records = readDayRecords<T>(filePath, entry.length)
    const entries = records[day] ?? []
    entries.push(entry)
    records[day] = entries
    // 返回实际写盘的 prune 后对象（writeDayRecords 返回值，与磁盘内容同源）
    return writeDayRecords(filePath, records)
  }

  // ── 写 2：模型切换重登记 + 推新模型帧（session-service state_changed 发布挂钩调用）──

  /**
   * 模型切换（D4 写 2 + MF7/MF9）：重登记映射 + 向该 sid 推 frameFor(sid, modelKey) 帧。
   * 帧序由调用方构造性保证：必须在该 sid 的 session.state_changed 广播（bus.publish）
   * 同步返回之后调用——插件路径 renderer 的 modelId 只能由 state_changed 帧更新，
   * 帧若先发会被前端校验（帧内 model ≠ 尚未更新的 modelId）丢弃（MF9）。
   * 无记录模型/本会话无该模型样本 → 聚合全 null + current null + model 恒回填（MF8，
   * 否则被自家前端校验拦截）。
   */
  onModelSwitched(sid: string, modelKey: string): void {
    this.modelBySid.set(sid, modelKey)
    // 帧体 = 全局聚合 + 本会话 current（切到本会话无样本模型 → current null，「—」语义）
    this.deps.publish(sid, { type: 'session.stats_update', payload: this.frameFor(sid, modelKey) })
  }

  // ── 写 3：恢复腿解析回填（getGenStats RPC case 经 getSnapshotForSession 间接触发）──────

  /**
   * 恢复腿 modelKey 解析成功回填（D4 写 3）：覆盖「新 session 未采样」缺口——未采样
   * session 本不在映射，用户切入触发恢复腿即登记，之后 live 帧可达。竞态声明（R4/S14）：
   * 帧计算后、登记执行前存在毫秒级交错窗口，该 sid 可能漏收一帧——恢复腿 reply
   * 本身已含最新帧、下一采样自愈，有界无害。
   */
  onSnapshotResolved(sid: string, modelKey: string): void {
    this.modelBySid.set(sid, modelKey)
  }

  // ── 清：session 销毁删映射（session-service onSessionDestroyedHandlers 汇聚点）────────

  /**
   * 挂进 session-service 的销毁回调列表（setOnSessionDestroyed 追加式注册）。触发点
   * removeSessionEntry 汇聚主动删 / 进程退出 / forceQuit / restore 清场全部销毁路径。
   * 清理两表：sid→modelKey 映射 + per-session current 槽（无界增长封口）。
   */
  registerSessionCleanup(): void {
    this.deps.sessionService.setOnSessionDestroyed((summary) => {
      this.modelBySid.delete(summary.id)
      this.sessionCurrent.delete(summary.id)
    })
  }

  // ── 帧合成与降级链 ────────────────────────────────────────────────────────────────────

  /**
   * 完整帧构造（唯一出口）：模型全局聚合 + 本会话 current 合并（D6 聚合在 runtime 算好，
   * 前端只拿结论）。三条发送路径（recordSample 广播 / onModelSwitched / 恢复腿）全经此。
   */
  frameFor(sid: string, modelKey: string | null): GenStatsFrame {
    return this.composeFrame(sid, modelKey, this.modelAggregates(modelKey))
  }

  /**
   * 帧合成：聚合层（模型全局）+ 本会话 current（sessionCurrent 槽，按 modelKey 匹配）。
   * 无回落纪律：本会话无样本 / 槽 modelKey ≠ 当前模型 → current null（UI「—」），绝不回落
   * 到模型全局末条。已预计算聚合层的调用方（broadcastModel 逐 sid 发帧）直接调本函数。
   */
  private composeFrame(sid: string, modelKey: string | null, aggregate: ModelAggregates): GenStatsFrame {
    const entry = this.sessionCurrent.get(sid)
    const speedCurrent =
      modelKey !== null && entry?.speed?.modelKey === modelKey ? aggregateSpeed([entry.speed.record]) : null
    const cacheCurrent =
      modelKey !== null && entry?.cache?.modelKey === modelKey ? aggregateCacheRatio([entry.cache.record]) : null
    // ttft current = 本会话最近一次样本原值（单条 p50 = 原值取整，ttftMs 本为整数 ms 恒等）；
    // modelKey 校验同 speed 槽（异模型残留 → null，无回落）
    const ttftCurrent =
      modelKey !== null && entry?.ttft?.modelKey === modelKey ? aggregateTtft([entry.ttft.record]) : null
    return {
      sessionId: sid,
      speed: { current: speedCurrent, ...aggregate.speed },
      cacheRatio: { current: cacheCurrent, ...aggregate.cacheRatio },
      ttft: { current: ttftCurrent, ...aggregate.ttft },
      ...(aggregate.model !== undefined ? { model: aggregate.model } : {}),
    }
  }

  /**
   * 模型全局聚合层（day/d7/d30；current 不在此层）。model 回填规则（R5/MF8）：modelKey 非
   * null 恒回填（含该模型无记录的全 null 帧——否则写 2 推的无记录帧被自家前端校验拦截，
   * 场景 4⑥「无记录则—」分支不可达）；仅 modelKey 为 null（降级链④走尽）时缺省 + 全 null。
   *
   * day/d7/d30 = 本地日 key 滚动窗口加权聚合（含当日）；聚合无有效样本 → null（store null
   * 纪律，禁止 0 充数）。
   *
   * 口径切换过渡态（genstats-speed-llm-window D4，排查勿误判）：落盘 append-only，旧口径
   * 样本（durationMs = turn 全程墙钟，含工具执行时间）不迁移，≤30 天 GC 出清前与新口径
   * （LLM 请求窗口）共存——此窗口内 day/d7/d30 聚合值系统性偏低、与 current 倒挂是已知
   * 过渡现象非 bug。刻意不做迁移脚本：数据量小、无跨期对比消费方，迁移的写风险大于读
   * 偏差收益；重审触发 = 出现依赖聚合值做跨期对比的消费方或用户长期反馈倒挂误读。
   */
  private modelAggregates(modelKey: string | null, fresh?: FreshDayRecords): ModelAggregates {
    if (modelKey === null) {
      return { speed: NULL_SPEED_AGGREGATE, cacheRatio: NULL_CACHE_AGGREGATE, ttft: NULL_TTFT_AGGREGATE }
    }
    const { provider, model } = splitModelKey(modelKey)
    const now = new Date()
    // 读取按文件族显式传记录类型 + 期望元组长度（§3.3 参数化校验：二元组 2 / 单元素组 1）
    const speedRecords =
      fresh?.speed ?? readDayRecords<SpeedRecord>(speedFilePath(provider, model), PAIR_RECORD_TUPLE_LENGTH)
    const cacheRecords =
      fresh?.cache ?? readDayRecords<CacheRatioRecord>(cacheRatioFilePath(provider, model), PAIR_RECORD_TUPLE_LENGTH)
    const ttftRecords =
      fresh?.ttft ?? readDayRecords<TtftRecord>(ttftFilePath(provider, model), TTFT_RECORD_TUPLE_LENGTH)
    return {
      speed: {
        day: aggregateSpeed(entriesSince<SpeedRecord>(speedRecords, rollingWindowCutoff(now, WINDOW_DAYS.day))),
        d7: aggregateSpeed(entriesSince<SpeedRecord>(speedRecords, rollingWindowCutoff(now, WINDOW_DAYS.d7))),
        d30: aggregateSpeed(entriesSince<SpeedRecord>(speedRecords, rollingWindowCutoff(now, WINDOW_DAYS.d30))),
      },
      cacheRatio: {
        day: aggregateCacheRatio(entriesSince<CacheRatioRecord>(cacheRecords, rollingWindowCutoff(now, WINDOW_DAYS.day))),
      },
      ttft: {
        day: aggregateTtft(entriesSince<TtftRecord>(ttftRecords, rollingWindowCutoff(now, WINDOW_DAYS.day))),
        d7: aggregateTtft(entriesSince<TtftRecord>(ttftRecords, rollingWindowCutoff(now, WINDOW_DAYS.d7))),
        d30: aggregateTtft(entriesSince<TtftRecord>(ttftRecords, rollingWindowCutoff(now, WINDOW_DAYS.d30))),
      },
      model: modelKey,
    }
  }

  /**
   * 恢复腿（D4 降级链，async——session-message-handler 'session.getGenStats' case 调用）：
   * ① 实时 get_state（pi 在线一次性解析，绕开 replicated states 异步播种竞速窗口；
   *   成功即写 3 回填）；② 失败/超时 → 内存映射 sid→modelKey；③ 仍无 → replicated
   *   states 缓存值（session.modelId 登记的永久双写缓存，与投影 fallback 同源）；
   *   ④ 全部未命中 → 全 null 帧 + model 缺省。残余窗口声明（R3/S10）：重启后映射空 +
   *   get_state 失败（pi 真实离线）时全 null 持续到首 turn 自愈——pi 离线期间无法产生
   *   对话，窗口不可观测，接受。
   */
  async getSnapshotForSession(sid: string): Promise<GenStatsFrame> {
    const modelKey = await this.resolveModelKey(sid)
    return this.frameFor(sid, modelKey)
  }

  private async resolveModelKey(sid: string): Promise<string | null> {
    // ① 实时 get_state（ getState 内部 FAST_TIMEOUT 10s；失败/超时/离线 → 降级链下一级）
    try {
      const state = await this.deps.pm.getClient(sid)?.getState()
      const model = (state as { model?: unknown } | undefined)?.model
      const m = typeof model === 'object' && model !== null ? (model as Record<string, unknown>) : undefined
      const id = m && typeof m.id === 'string' ? m.id : ''
      const provider = m && typeof m.provider === 'string' ? m.provider : ''
      if (id !== '' && provider !== '') {
        const modelKey = `${provider}/${id}`
        this.onSnapshotResolved(sid, modelKey) // 写 3
        return modelKey
      }
    } catch (err) {
      // §3.5：get_state 失败/超时不卡加载，降级链下一级（pi 侧退避重试语义不受影响）；
      // warn 带上下文落盘（非静默吞——排障时需知道降级发生与原因）
      logger.warn('[gen-stats] get_state resolve failed, degrade to fallback chain', {
        sessionId: sid,
        error: toMessage(err),
      })
    }
    // ② 内存映射（该 session 至少采样过一次 / 写 2 / 写 3 登记过）
    const mapped = this.modelBySid.get(sid)
    if (mapped) return mapped
    // ③ replicated states 缓存值（getSummary 读 session.modelId 双写缓存——与
    // publishStateChangedFromSnapshot 的 fallback 字段同源同值）
    const cached = this.deps.sessionService.getSummary(sid)?.modelId
    if (cached) return cached
    // ④ 全 null（model 缺省）
    return null
  }

  // ── 广播辅助（D4）────────────────────────────────────────────────────────────────────

  /** 该模型全部已知 session（stats_update 扩展广播逐 sid 发帧用；映射由三写一清维护）。 */
  sessionsOfModel(modelKey: string): string[] {
    const sids: string[] = []
    for (const [sid, mk] of this.modelBySid) {
      if (mk === modelKey) sids.push(sid)
    }
    return sids
  }

  /**
   * 对该模型全部已知 session 逐 sid 发帧：聚合层共享（只算一次），current 各取本会话槽
   * ——同模型多 session 聚合值相同、current 各自独立（会话隔离语义）。
   */
  private broadcastModel(modelKey: string, fresh?: FreshDayRecords): void {
    const aggregate = this.modelAggregates(modelKey, fresh)
    for (const targetSid of this.sessionsOfModel(modelKey)) {
      this.deps.publish(targetSid, {
        type: 'session.stats_update',
        payload: this.composeFrame(targetSid, modelKey, aggregate),
      })
    }
  }
}

/** 错误消息提取（本文件私有，避免为两处 warn 引整个 utils/errors） */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
