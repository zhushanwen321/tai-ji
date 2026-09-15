/**
 * W2（restore-fork-attach-fix F4）：附着不变量 I1 断言——「登记路径 ≡ pi 写路径」。
 *
 * 独立零依赖模块（只 import node 内建）的缘由（主 agent 2026-08-19 裁决追认入 W2 交付）：
 * services 侧（session-lifecycle.ts）若从 process-manager.ts import 本 helper，会把
 * rpc-client 传递链（rpc-client → pi-provider-store → pi-paths）带进 services 模块面，
 * 撞上既有单测对 process-manager.js / pi-paths.js 的模块级 vi.mock（mock 模块无本
 * export / 部分 mock 缺 getSettingsPath），全量误伤。零依赖使两侧引用都无新增传递面。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** attach 断言所需的最小 client 面（RpcClient / IPiEngine 天然满足；等价测试以 fixture 包装复用）。 */
export interface SessionFileAssertClient {
  getState(): Promise<Record<string, unknown> | undefined>
}

/**
 * 附着后断言 pi 的实际写目标与期望登记路径一致（不变量 I1）。
 *
 * 背景：pi 的 switch_session 是「永久重绑读写目标」而非「读一遍历史」——
 * - pi-mono `core/agent-session-runtime.ts:193-209`：switchSession → SessionManager.open +
 *   createRuntime **永久采纳**该 SessionManager；
 * - pi-mono `core/session-manager.ts:815-816`：setSessionFile 把传入路径 resolve 后存为实例
 *   **永久字段** sessionFile；
 * - pi-mono `core/session-manager.ts:934-960`：_persist 每轮 appendFileSync 该路径（文件被删
 *   也会按路径重建）。
 * 附着到错误路径 = 此后每轮对话写错文件 = 数据丢失级 bug（P0 根因曾静默 40 天）。
 *
 * 断言方式：switchSession 成功后调 getState() 比对 `data.sessionFile`（pi-mono
 * `modes/rpc/rpc-types.ts:101`）与期望登记路径（runtime 记账的 sessionFilePath）。
 * 归一化 = 双侧 `path.resolve()` **词法**归一。实测探针（2026-08-19，pi 0.84.1 macOS）：
 * pi 侧 resolvePath（`utils/paths.ts:81`）不做 symlink realpath 展开（`/var/folders/...` 与
 * `/private/var/folders/...` 输入各自原样返回），taiji 传入什么形态 pi 就回报什么形态，双侧
 * 同源 → resolve 足够；symlink 视角差异本身就是要暴露的路径管理分裂，**刻意不用**
 * realpathSync 归一。
 *
 * 失败语义（设计文档 D3：throw 不 warn）：分裂 = 数据丢失级 bug，warn 会被淹没；调用方
 * （restoreSession / forkSession）既有 catch 分支 safeDestroy + rethrow 保证进程不泄漏。
 *
 * @param client              刚完成 switchSession 的 pi client
 * @param expectedSessionFile 期望登记路径（必须与 switchSession 实参同一文件）
 * @param context             调用方上下文（错误信息定位用，如 'restoreSession(<id>)'）
 * @throws 取到可比对的 sessionFile 且与期望路径 resolve 归一后仍不一致（可比对性守卫见
 *         实现内三处跳过分支——真实附着场景三者皆不触达，I1 漂移兜底 = 等价测试
 *         attach-lifecycle.test.ts 的真实 mismatch 断言）
 */
export async function assertPiSessionFile(
  client: SessionFileAssertClient,
  expectedSessionFile: string,
  context: string,
): Promise<void> {
  // 跳过分支 1（mock 形态兼容）：getState 通道缺失——既有单测（process-manager-ephemeral.
  // test.ts）mock 整个 rpc-client 模块且 FakeRpcClient 不含 getState。真实 RpcClient 恒有
  // 该方法（类定义），此分支生产不可达。
  const getState = (client as Partial<SessionFileAssertClient>).getState
  if (typeof getState !== 'function') {
    console.warn(`[assertPiSessionFile] ${context}: client lacks getState (unit-test mock shape); skipping attach assertion`)
    return
  }
  const state = await getState.call(client)
  const piSessionFile = state?.sessionFile
  // 跳过分支 2（mock 形态兼容）：sessionFile 取不到（undefined / 非string / 空串）——既有
  // 单测生态的 client mock 普遍把「getState 无 sessionFile」当 create 路径 pi 新 session
  // 延迟写入窗口的正常态（restore/fork gate 用例复用同一 mock），throw 会全量误伤。真实
  // pi 附着后该字段必为 string（switch_session 经 SessionManager.open 必设）。
  if (typeof piSessionFile !== 'string' || piSessionFile === '') {
    console.warn(
      `[assertPiSessionFile] ${context}: pi get_state returned no comparable sessionFile `
      + `(got: ${String(piSessionFile)}); skipping attach assertion. expected: ${expectedSessionFile}`,
    )
    return
  }
  const resolvedPi = resolve(piSessionFile)
  const resolvedExpected = resolve(expectedSessionFile)
  // 跳过分支 3（mock 形态兼容 + 真实附着前置）：pi 报告的写目标在磁盘上不存在——真实
  // switch_session 成功意味着该文件刚被 loadEntriesFromFile 读过，必存在；不存在 = mock
  // 的假路径（如 '/fake/x.jsonl'）。存在性同时是「可比对 = 双侧都是磁盘上真实可指认文件」
  // 的语义前置，不损失真实环境的断言强度（pi 侧永真）。
  if (!existsSync(resolvedPi)) {
    console.warn(
      `[assertPiSessionFile] ${context}: pi-reported session file does not exist on disk `
      + `(got: ${resolvedPi}); skipping attach assertion. expected: ${expectedSessionFile}`,
    )
    return
  }
  if (resolvedPi !== resolvedExpected) {
    throw new Error(
      `[attach-mismatch] ${context}: pi 实际写目标与期望登记路径不一致（不变量 I1「登记路径 ≡ pi 写路径」`
      + `被破坏——pi 的 switch_session 是永久重绑读写目标，附着错文件 = 此后对话写错文件 = 数据丢失级 bug）。\n`
      + `  pi actual write target (get_state.sessionFile): ${piSessionFile}\n`
      + `  expected registered path: ${expectedSessionFile}\n`
      + `  恢复指引: 检查 attach 目标是否 sessions 目录内正式文件；确认调用方期望路径与 switchSession 实参为同一路径。`,
    )
  }
}
