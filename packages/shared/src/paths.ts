/**
 * 跨进程数据目录路径解析（main + runtime 共用，ADR-0009 隔离）。
 *
 * 单一真值源：所有 `~/.taiji` / `agent` 路径推导集中于此，
 * main 与 runtime 均 import 使用，禁止各自硬编码（实例隔离后路径可能是
 * `~/.taiji-dev`，硬编码会导致 dev/prod 实例互相串数据）。
 *
 * ADR-0009 隔离约束：taiji 数据目录（`~/.taiji/`）与 pi 自身的
 * 数据目录（`~/.pi/agent/`）完全隔离。本模块只解析 taiji 自己的目录，
 * getPiAgentDir 返回 `<dataDir>/agent`（taiji 内嵌的 pi agent 目录），
 * 不是系统 pi 的 `~/.pi/agent`。
 *
 * 目录结构（布局完整对齐 pi 0.84.x，唯一差异是根目录——pi 是 `~/.pi/`，
 * taiji 是 `<dataDir>`）：
 *   ~/.taiji/                        ← taiji 配置根目录（TAIJI_AGENT_DATA_DIR 可覆盖）
 *     config.json                    ← taiji 自身配置
 *     runtime.port                   ← runtime 监听端口文件
 *     extensions/                    ← 用户安装的 extension（local/git 副本 + discovery 扫描根）
 *     npm/                           ← npm 安装的 extension（node_modules 平铺布局）
 *     tmp/                           ← extension 安装临时目录（crash 恢复用）
 *     skills/                        ← skill 强制目录（ADR-0021）
 *     agents/                        ← agent 强制目录（ADR-0021）
 *     agent/                         ← pi 的 agent 目录（PI_CODING_AGENT_DIR，≙ ~/.pi/agent）
 *       models.json / settings.json / auth.json / disabled-packages.json
 *       config/providers.json        ← taiji 扩展域（pi 不扫描 agent/config/ 子目录）
 *       sessions/                    ← Session jsonl 文件
 *         <encodeCwd>/               ← pi 按 cwd 自动分子目录（默认布局）
 *
 * 注意：extensions/npm/tmp 原在旧布局 agent/ 子树下，已迁出到 dataDir 根层（与 skills/agents 对齐）。
 *
 * 图片缓存路径（getImageCacheRoot/getImageCacheDir）为 C-state-05 债务新增面：
 * 纯校验+join 组合逻辑后续拆为无 node 依赖纯函数留 shared，env/homedir 腿（getDataDir 推导）
 * 迁 runtime/main 各自实现——收编时机随 C-state-05 白名单整体治理，不在本批。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * taiji 数据根目录。
 * 读 TAIJI_AGENT_DATA_DIR 环境变量，缺省 `~/.taiji`。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TAIJI_AGENT_DATA_DIR ?? join(homedir(), '.taiji')
}

/**
 * taiji 内嵌的 pi agent 目录（PI_CODING_AGENT_DIR）。
 * 即 `<dataDir>/agent`（方案 B 布局对齐 pi；旧布局 pi/ 兄弟层已迁移退役），
 * **不是**系统 pi 的 `~/.pi/agent`（ADR-0009 隔离）。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'agent')
}

/**
 * pi session 文件目录（方案 B 新布局 `<dataDir>/agent/sessions`，dev-0.9.17 合并对齐；
 * 真实推导锚点 = runtime pi-paths.ts getSessionsDir：join(getPiAgentDir(), 'sessions')）。
 * session jsonl 落在其下的 `<encodeCwd>/` 子目录（pi 按 cwd 分目录），文件名形态
 * `<ISO时间戳>_<uuid>.jsonl`——跨进程消费方按目录递归扫描，不假设单层。
 *
 * main 进程不能 import runtime（包边界），孤儿判据反查等跨进程消费经本 SSOT 同构推导，
 * 禁止各进程手拼层级（曾因手拼多套一层 pi/ 前缀致判据恒空）。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getPiSessionsDir(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), 'agent', 'sessions')
}

/**
 * 用户安装的 extension 目录（`<dataDir>/extensions`）。
 *
 * local/git 安装的 extension 副本存放于此；也是 discovery.json 可选目录的强制基址
 * （与 skill/agent 的 `<dataDir>/skills` 强制目录对齐，ADR-0021）。
 *
 * 注意：原在 `<piAgentDir>/extensions/`，已迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'extensions')
}

/**
 * npm 安装的 extension 目录（`<dataDir>/npm`）。
 *
 * extension 经 npm install 到此目录的 node_modules/ 下（平铺布局）。
 * settings.json.packages[] 的包名 → `<getNpmDir()>/node_modules/<pkgName>` 定位。
 *
 * 注意：原在 `<piAgentDir>/npm/`，已迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getNpmDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'npm')
}

/**
 * extension 安装临时目录（`<dataDir>/tmp`）。
 *
 * 多步安装流（installDir/installGit）的暂存区，crash 后由 cleanupOrphanedTempDirs 清理。
 *
 * 注意：原在 `<piAgentDir>/tmp/`，已随 extensions/npm 一起迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getTmpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'tmp')
}

/**
 * 会话级图片附件目录（`<dataDir>/attachments/<sessionId>`）。
 *
 * write-session-image IPC 把粘贴的图片落到此目录（持久化，区别于 OS tmpdir 的自动清理）。
 * local-file:// 协议白名单放行整个 `<dataDir>/attachments/` 前缀，让历史消息缩略图能加载。
 *
 * 纯函数无副作用——不创建目录（mkdir recursive 在 IPC handler 内做），仅做路径推导。
 *
 * **路径穿越防护**：sessionId 必须匹配 `^[A-Za-z0-9_-]+$`，否则 throw（防 `../` 逃逸
 * attachments/ 写到任意位置）。合法 sessionId 来源均满足此格式：
 * - pi 的 uuidv7（如 `019f9bd8-ee50-779d-a912-4a661683cf69`）
 * - taiji store 的 `u-<uuid>`（如 `u-a1b2c3d4-e5f6-7890-abcd-ef1234567890`）
 *
 * 此校验是纵深防御——即便渲染层 XSS 传入恶意 sessionId，也不会写到 attachments 之外。
 *
 * @param sessionId 会话 id（决定子目录分区，必须匹配 `^[A-Za-z0-9_-]+$`）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 * @throws Error 当 sessionId 含路径分隔符或非法字符（含 `/` `\` `..` `;` 等）
 */
export function getAttachmentsDir(sessionId: string, dataDir?: string): string {
  // 校验 sessionId 字符集防路径穿越：只允许字母/数字/连字符/下划线
  //（uuidv7 的 `019f9bd8-...` 和 taiji 的 `u-<uuid>` 格式都满足）。
  // 拒绝 / \ .. 等路径分隔符（攻击载荷 `../../../etc` 在 join 后会逃逸 attachments/）。
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`)
  }
  return join(dataDir ?? getDataDir(), 'attachments', sessionId)
}

/**
 * toolResult 图片缓存根目录（`<dataDir>/cache/images`）[D6-⑨]。
 *
 * 纯缓存语义（可随时丢弃、可幂等重建）；落盘执行方 = main 进程（IPC IMAGE_CACHE_WRITE），
 * 级联/孤儿/软上限清理均为此目录下的文件系统级动作（runtime session 删除链同样直接
 * fs 删该目录——main 与 runtime 共享 getDataDir 数据根）。local-file:// 协议白名单
 * 放行整个本目录前缀（apps/electron/main/utils/local-file-prefixes.ts）。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getImageCacheRoot(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), 'cache', 'images')
}

/**
 * 单 session 的图片缓存目录（`<getImageCacheRoot()>/<sessionId>`）[D6-⑨]。
 *
 * 路径穿越防护与 getAttachmentsDir 同款：sessionId 必须匹配 `^[A-Za-z0-9_-]+$`，
 * 否则 throw（cache/images 内子目录名即 sessionId，孤儿扫描据此反查 pi sessions 目录）。
 *
 * @param sessionId 会话 id（子目录分区，必须匹配 `^[A-Za-z0-9_-]+$`）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 * @throws Error 当 sessionId 含路径分隔符或非法字符
 */
export function getImageCacheDir(sessionId: string, dataDir?: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`)
  }
  return join(dataDir ?? getDataDir(), 'cache', 'images', sessionId)
}

// ── run 目录运行态（crash-forensics D1/D3）────────────────────────────────────
// 【oe-audit C8】文件名族 SSOT：此前 'runtime-checkpoint.json' 等字面量在
// runtime-checkpoint.ts / main.ts / export-diagnostic-bundle.ts 三处独立定义
// （bundle 注释自认「三行常量跨文件显式对齐」）——漏改即 main 侧隔离与诊断导出
// 静默失配。收敛单点后，三消费方（runtime writer / main 残留隔离 / 诊断清单）共享。

/** run 目录名（`<dataDir>/run`）。 */
export const RUN_DIR_NAME = 'run'

/** main 存活 marker 文件名（D1 clean-exit marker：正常退出删除，残留 = unclean）。 */
export const RUN_MARKER_FILENAME = 'main-running.marker'

/** runtime checkpoint 主文件名（D3 权威路径 `<dataDir>/run/runtime-checkpoint.json`）。 */
export const RUN_CHECKPOINT_FILENAME = 'runtime-checkpoint.json'

/** checkpoint 失败现场文件名前缀（同域家族：`runtime-checkpoint-failed-<ts>.json`）。 */
export const RUN_CHECKPOINT_FAILED_PREFIX = 'runtime-checkpoint-failed-'

/** checkpoint 失败现场保留份数（D3 §5 清理声明：保留最近 3 份，新失败覆盖最旧）。 */
export const RUN_CHECKPOINT_FAILED_RETENTION = 3

/** run 目录运行态路径族（main.ts resolveRunStatePaths 的 shared 形态——诊断导出等 main 模块不能 import 入口模块）。 */
export function getRunStatePaths(dataDir: string): {
  runDir: string
  markerPath: string
  checkpointPath: string
} {
  const runDir = join(dataDir, RUN_DIR_NAME)
  return {
    runDir,
    markerPath: join(runDir, RUN_MARKER_FILENAME),
    checkpointPath: join(runDir, RUN_CHECKPOINT_FILENAME),
  }
}
