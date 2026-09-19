/**
 * ImportService —— 导入编排层（session-import-unified 设计 §3.3 SPI + 公共编排）。
 *
 * 源特有知识全部下沉到 SessionImportSource 实现（import-source-external-file.ts / 后续
 * import-source-zcode.ts）；本层只做源无关公共编排（对外 RPC 形态与互斥链保持不变）：
 * - listCandidates / importSession 签名不变，内部按 request.source（缺省 'pi'，
 *   向后兼容——存量 renderer 调用不传 = 行为不变）路由到注册表内对应 source
 * - 导入执行流（D1/D4 权威）：全局单条互斥（模块级 Promise 链）→ 互斥区内依次：
 *   source.prepareImport（源校验 + 产物）→ 去重双检（id-first：force 集合命中 →
 *   import_already_imported；仅 target 命中 → import_target_conflict）→ projectId
 *   存在性校验 → mkdir(recursive) + artifact.write(tmp) + rename（失败主动清理临时名，
 *   正式名从未落地 → 重试不被去重拦截）→ persistProjectBinding + readback（吞错
 *   best-effort 语义，不符 → warning 降级不回滚，r2-S2）→ 缓存失效 → tombstone 摘碑。
 *   broadcast 由调用方（u3 handler）负责。
 *
 * 互斥不设超时（r4-S2 显式接受）：write 不可真取消，超时释放会重开本互斥要消灭的并发
 * 窗口；挂起时仅导入功能阻塞，candidates/聊天/扫描不经互斥不受影响。
 */

import { existsSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve as pathResolve } from 'node:path'
import type {
  ImportCandidatesReply,
  ImportCandidatesRequest,
  ImportReply,
  ImportRequest,
  ImportSourceKind,
} from '@taiji/shared'
import { toErrorMessage } from '../../utils/errors.js'
import { encodeCwd, getSessionsDir } from '../../infra/pi/pi-paths.js'
// B5（memory-leak-remediation §3.2-B5 摘碑双路径②）：import 同 id 复活后摘除 sessionData
// tombstone——doImport 纯文件级不投 didCreate，主线程无创建收敛点可依赖，落地即显式摘碑。
import { clearSessionDataTombstone } from '../plugin-service/session-data-store.js'
import {
  invalidateScanDirCache,
  persistProjectBinding,
  readProjectBinding,
  scanPiSessions,
} from '../../infra/pi/session-file-utils.js'
// SPI 与领域错误 SSOT 在 import-source.ts；此处 re-export 维持 import-service.js 作为
// 导入领域对外单一 import 点的既有惯例（handler/server 消费方与测试不改路径）。
export { ImportServiceError } from './import-source.js'
export type { ImportArtifact, ImportSourceDeps, SessionImportSource } from './import-source.js'
import { ImportServiceError, type SessionImportSource } from './import-source.js'

/** projectId 存在性校验的最小依赖面（结构化接口：组合根传 ProjectStore，测试可注入 stub）。 */
export interface ImportProjectSource {
  load(): { projects: ReadonlyArray<{ id: string }>; activeProjectId: string }
}

export interface ImportServiceDeps {
  projects: ImportProjectSource
  /**
   * source 注册表（组合根装配，设计 §3.3/G2）：key = ImportSourceKind，第三源接入 =
   * 表加一项 + 新实现模块，编排层与 RPC 契约零改动。本表缺项 = runtime 与 renderer
   * 版本不匹配（类型闭合联合 + 组合根全注册下不可达，仅 WS JSON 注入未知字面量可达）。
   */
  sources: ReadonlyMap<ImportSourceKind, SessionImportSource>
}

/** 编排层写入的临时名标记（与 session-file-utils 的 TMP_RESIDUE_MARKERS 同族，r2-S1）。 */
const TMP_IMPORT_MARKER = '.tmp-import-'

/** source 缺省值（§3.7 向后兼容）：存量 renderer 调用不传 = 走 pi，行为不变。 */
const DEFAULT_SOURCE: ImportSourceKind = 'pi'

/**
 * 全局单条导入互斥（D4/r4 修订）：单条 Promise 链一次只执行一条导入，无键选择无回收问题。
 *
 * 异常安全（r4-S1）：then(work, work) 保证前序 rejection（防御性，链体本身已吞错）不阻断
 * 后续；链体另接 then/catch 空转换，rejection 永不泄入链——最后一跳无人 await 也不触发
 * unhandledRejection。错误在 work 内部转 ImportServiceError 抛给调用方，链外不可见。
 */
let importChain: Promise<unknown> = Promise.resolve()
function enqueueImport<T>(work: () => Promise<T>): Promise<T> {
  const result = importChain.then(work, work)
  importChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export class ImportService {
  constructor(private deps: ImportServiceDeps) {}

  /** 按 request.source 路由（缺省 'pi'）。注册表缺项 = 版本不匹配的不可达防御。 */
  private resolveSource(kind: ImportSourceKind): SessionImportSource {
    const source = this.deps.sources.get(kind)
    if (!source) {
      // 错误码零新增（设计 §3.6）：不可达分支复用语义最接近的 import_source_missing
      //（源不可用宽义），消息指向恢复动作（确认 renderer/runtime 版本一致）。
      throw new ImportServiceError('import_source_missing', `导入源未注册：${kind}（renderer 与 runtime 版本不匹配？请更新后重试）`)
    }
    return source
  }

  /**
   * 候选列表（D5）：按 source 路由（缺省 'pi'）。alreadyImported 用默认 TTL 读打标的
   * 语义在 source 实现内（D5：列表展示允许秒级 stale；真正的幂等校验在 importSession
   * 互斥区内 force 双检）。
   */
  async listCandidates(request: ImportCandidatesRequest): Promise<ImportCandidatesReply> {
    return this.resolveSource(request.source ?? DEFAULT_SOURCE).listCandidates(request)
  }

  /**
   * 执行导入（D5）：进入全局互斥后串行执行。返回结果给调用方（u3 handler reply + broadcast）。
   * 失败抛 ImportServiceError（code 见 ImportErrorCode），互斥链不受污染（enqueueImport 吞错）。
   */
  importSession(request: ImportRequest): Promise<ImportReply> {
    return enqueueImport(() => this.doImport(request))
  }

  private async doImport(request: ImportRequest): Promise<ImportReply> {
    const { projectId } = request
    const source = this.resolveSource(request.source ?? DEFAULT_SOURCE)

    // 1. 源校验 + 产物（D2：不落正式位、不做去重判定——本层职责在后）
    const artifact = await source.prepareImport(request)

    // 2. 去重双检 id-first（D4/r4）：force 读集合防「同 id 任意 target」，existsSync 防「同 target 异 id」
    const targetPath = join(getSessionsDir(), encodeCwd(pathResolve(artifact.header.cwd)), artifact.fileName)
    const importedIds = new Set(scanPiSessions({ force: true }).map((s) => s.id))
    if (importedIds.has(artifact.header.id)) {
      throw new ImportServiceError('import_already_imported', `该会话已在太极中（sessionId=${artifact.header.id}），侧边栏可直接打开`)
    }
    if (existsSync(targetPath)) {
      throw new ImportServiceError('import_target_conflict', `目标路径已被另一个会话占用：${targetPath}`)
    }

    // 3. projectId 存在性校验（r3-INFO：空串是 persistProjectBinding 的「删 sidecar 归默认」语义，readback 会假阳性，不容忍）
    const projects = this.deps.projects.load().projects
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      throw new ImportServiceError('import_project_invalid', projectId ? `目标项目不存在：${projectId}` : '目标项目不存在（空 projectId）')
    }

    // 4. mkdir(recursive) + artifact.write(tmp) + rename 原子落地（D1/r2：失败主动清理临时名，正式名从未落地 → 重试不被去重拦截）
    const tmpPath = `${targetPath}${TMP_IMPORT_MARKER}${Date.now()}.jsonl`
    try {
      await mkdir(dirname(targetPath), { recursive: true })
      await artifact.write(tmpPath)
      await rename(tmpPath, targetPath)
    } catch (e) {
      try {
        await unlink(tmpPath)
      // eslint-disable-next-line taste/no-silent-catch -- tmp cleanup: best-effort，正确性由「正式名未落地」保证而非本删除
      } catch {
        // tmp 未创建/已被清理：忽略
      }
      // 相位分离（§3.6）：write 闭包内的领域错误（zcode 源转换相位抛的
      // import_source_missing / import_invalid_session）原样透传——错误码承载恢复
      // 动作路由（刷新重选/升级太极），重包装 import_copy_failed 会把指引降格成
      // 「写入目标目录出错」；仅环境故障（磁盘满/权限等非领域错误）才映射
      // import_copy_failed。tmp 清理对两条路径同样生效。
      if (e instanceof ImportServiceError) throw e
      throw new ImportServiceError('import_copy_failed', `导入失败（写入目标目录出错）：${toErrorMessage(e)}`)
    }

    // 5. project sidecar + readback（r2-S2）：persistBindingSidecar 吞错 best-effort，
    //    不校验会假成功 + 静默误归组默认项目。不符 → warning 降级，文件已落地不回滚。
    persistProjectBinding(targetPath, projectId)
    const sidecarVerified = readProjectBinding(targetPath) === projectId

    // 6. 缓存失效：太极根列表 TTL 显式失效（D1，broadcast 立即可见）；alreadyImported 的
    //    stale 消除由本行保证（listCandidates 每次调 scanPiSessions() 重算，与外部根缓存
    //    无关）。[设计 §3.3 显式放弃] 单源期此处的
    //    `scanExternalSessions(dirname(sourcePath), { force: true })`（外部根 force 重扫）
    //    不搬入编排层——无消费者依赖其效果（保守动作），且会把外部根的概念（sourcePath
    //    所在目录）泄漏进源无关编排层；pi 源自身列表路径按 TTL 读，不依赖该次重扫。
    invalidateScanDirCache()

    // 7. B5 摘碑（双路径②，R4）：import 同 id 复活 session——覆盖「import 后未打开窗口」
    //    的迟到写丢弃风险（路径①的 notifySessionCreated 只在用户点开时触发，此窗口内
    //    插件对新 session 的合法 set 会被 tombstone 误杀）。导入失败路径不至此，碑保留。
    clearSessionDataTombstone(artifact.header.id)

    // 8. warning 聚合（r4-INFO 单字段）：sidecar_failed 需用户动作（手动归类）优先于
    //    conversion_degraded（知情提示，无需动作）；degradations 明细无论如何日志留痕
    //    （D6：reply 只带单字面量，明细不进契约面）。
    if (artifact.degradations.length > 0) {
      console.warn(`[runtime] session.import conversion degraded (source=${source.kind}):`, artifact.degradations)
    }
    const reply: ImportReply = { sessionId: artifact.header.id, targetPath }
    if (!sidecarVerified) {
      reply.warning = 'sidecar_failed'
    } else if (artifact.degradations.length > 0) {
      reply.warning = 'conversion_degraded'
    }
    return reply
  }
}
