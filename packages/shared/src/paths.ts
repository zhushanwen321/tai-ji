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
 *     ext-sessions/                  ← session 存储树（全部 session 维度衍生数据，见 getSessionStoreDir）
 *       <sessionId>/
 *         attachments/  artifacts/  image-cache/  plugin-data.json
 *         canvases/<canvasId>/  background-tasks/  session-view.md
 *         btw/<ts>_<线sid>.jsonl(.meta.json)
 *         logs/{pi-<date>.jsonl(.N.gz), pi-crash-<date>.log, signal-forensics-<date>.jsonl}
 *         subagents/{sessions/, records/, model-switch/}
 *         workflow/runs/<runId>.record.jsonl
 *
 * 注意：extensions/npm/tmp 原在旧布局 agent/ 子树下，已迁出到 dataDir 根层（与 skills/agents 对齐）。
 *
 * 图片缓存路径（getImageCacheDir）为 C-state-05 债务新增面：
 * 纯校验+join 组合逻辑后续拆为无 node 依赖纯函数留 shared，env/homedir 腿（getDataDir 推导）
 * 迁 runtime/main 各自实现——收编时机随 C-state-05 白名单整体治理，不在本批。
 */
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * prod 值准入守卫（C-proc-26 第二支柱）：`TAIJI_AGENT_DATA_DIR` 指向 `~/.taiji` 树内的
 * 合法前提 = 进程声明自己是 prod 形态（`TAIJI_AGENT_PACKAGED === '1'`）。非 prod 进程
 * （dev/测试/裸跑/脚本）持有 prod 值 = env 泄漏或配置错误 → fail-fast。
 *
 * 与缺省反转互补：缺省反转管「env 未设」（裸跑落 ~/.taiji-dev），本守卫管「env 被污染」
 * ——典型受害形态 = 绕过 vitest config 的测试执行器（bun test 等：globalSetup 的自动
 * 脱钩不在场）恰逢宿主 shell 泄漏 `TAIJI_AGENT_DATA_DIR=~/.taiji`，两层防线同时失守
 * 时数据目录被采信为 prod。守卫挂在 getDataDir 唯一入口上，不依赖任何 config 被加载，
 * 任何 runner / 任何代码路径第一个 getDataDir() 调用即拦截。
 *
 * 合法 prod 消费链（全部带 PACKAGED=1，不受影响）：runtime 由 process-control 成对注入
 * （C-proc-26 入口断言保证）；打包 main 进程在 packaged 分支自置位。pi 子树内的 taiji
 * 代码不 import 本模块（extension 包不依赖 @taiji/shared，import 即包边界越界）。
 *
 * 判定纯词法（path.resolve 消解 ../ 后树内包含判定 + sep 边界），不触磁盘。
 * 树内包含判定双侧 casefold：大小写不敏感卷（macOS/Windows 默认）上 `~/.TAIJI`
 * 类手滑变体词法在树外、磁盘实际命中 prod 目录（stat dev+ino 同一物理文件），
 * 漏判即非 prod 进程写真实 prod 数据。Linux 大小写敏感卷上该路径本就是树外另一目录，
 * casefold 属 fail-fast 方向的从严误拦，错误消息自带恢复动作，可接受。
 */
function assertNotLeakedProdDataDir(env: NodeJS.ProcessEnv): void {
  const external = env.TAIJI_AGENT_DATA_DIR
  if (!external) return
  const resolved = resolve(external)
  const prodRoot = join(homedir(), '.taiji')
  // 判定用小写副本（错误消息保留原大小写）：见函数头 casefold 注释
  const foldedResolved = resolved.toLowerCase()
  const foldedProdRoot = prodRoot.toLowerCase()
  const inProdTree =
    foldedResolved === foldedProdRoot || foldedResolved.startsWith(foldedProdRoot + sep)
  if (inProdTree && env.TAIJI_AGENT_PACKAGED !== '1') {
    throw new Error(
      `[getDataDir] blocked: TAIJI_AGENT_DATA_DIR=${resolved} resolves into the prod data dir` +
        ` (${prodRoot}) while this process is not packaged (TAIJI_AGENT_PACKAGED !== '1')` +
        ` — leaked env detected (C-proc-26 prod-admission guard).\n` +
        `  fix: unset TAIJI_AGENT_DATA_DIR, or point it under ~/.taiji-dev / a tmp dir` +
        ` (bare runs fall to the fail-safe default ~/.taiji-dev).\n` +
        `  if this IS the packaged app: the pin point must set TAIJI_AGENT_PACKAGED='1'` +
        ` alongside (apps/electron/main packaged branch / process-control spawn pair).`,
    )
  }
}

/**
 * taiji 数据根目录。
 * 读 TAIJI_AGENT_DATA_DIR 环境变量，缺省 `~/.taiji-dev`（缺省反转，fail-safe default：
 * prod 形态由入口显式钉死——打包 main 用 resolvePackagedDataDir（~/.taiji 树）、
 * dev main 用 resolveDevDataDir（~/.taiji-dev 树）且 main→runtime spawn 成对注入
 * TAIJI_AGENT_PACKAGED + TAIJI_AGENT_DATA_DIR（runtime 入口有交叉断言兜底）；
 * 能走到本缺省的只有裸跑（手动 tsx / 验证脚本 / 探针），一律落 dev 树，
 * 结构性杜绝 dev 工具写 prod 数据目录）。非 PACKAGED 进程持有 prod 树值时
 * fail-fast（见 assertNotLeakedProdDataDir）。
 *
 * [HISTORICAL] 缺省反转（2026-09-23）：原缺省 `~/.taiji`（prod），裸跑 runtime
 * （`scripts/validate-runtime-bundle.sh` 与手动 `tsx packages/runtime/src/index.ts`）
 * 在 env 未设时整个进程跑在 prod 数据目录上——validate-runtime-bundle 每次深度
 * 验证都向 `~/.taiji` 写日志/runtime.port/crash journal。反转后 prod 只能被
 * 「打包 main 显式钉死」触达，缺省即安全。
 * [HISTORICAL] 准入守卫（2026-09-23 第二批）：2026-09-22 bun test 事故（dev-0.10.4
 * 线，TROUBLESHOOTING #22）——bun test 把 vitest import 映射到 bun:test、不加载
 * vitest config，globalSetup 钉 env 与 fs-guard 双防线同时不在场，宿主泄漏的
 * `~/.taiji` 值被采信，测试垃圾写入真实附件区。缺省反转已消掉「env 未设」半边，
 * 本守卫堵「env 被污染 + 防线不在场」的残余半边。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  assertNotLeakedProdDataDir(env)
  // 空串视同未设（|| 非 ??）：与 resolveDev/PackagedDataDir 的「非空才算外部值」
  // 对齐——空串只可能来自宿主手滑 export，归缺省 dev 树是安全方向。
  return env.TAIJI_AGENT_DATA_DIR || join(homedir(), '.taiji-dev')
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
 * 编码 cwd 为 pi session 目录名（pi 布局 SSOT；runtime pi-paths.ts 同名函数已收敛为本实现）。
 *
 * 规则：'--' + cwd 去掉首斜杠 + 所有 / \\ : 替换为 - + '--'
 * 例：/Users/x/proj → --Users-x-proj--
 *     C:\\Users\\x\\proj → --C--Users-x-proj--（盘符冒号与反斜杠各替换为一个 -）
 *
 * 归并是有损的（目录名里的字面 `-` 与分隔符归并产物无法区分），因此**只保证正向单射**：
 * 已知 cwd 可唯一得目录名，反向解码有歧义——需要「目录名 → cwd」的场景必须走正向对拍
 * （候选 cwd 只能取自被验路径的结构性前缀，逐候选 encode 后与目录名比对，如 main 侧
 * local-file 白名单的会话项目 `.tmp/` 子树准入）。
 */
export function encodeCwd(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/**
 * 会话文件树段全集（pi 宿主三棵树段 + taiji session 存储树根段）。
 *
 * 前三位是 pi 宿主树段（`<piAgentDir>/sessions|subagents|btw`，布局权威 = runtime
 * pi-paths.ts 的 getSessionsDir / getSubagentSessionDir / getBtwSessionsRoot，对拍
 * 机检逐位核对，改树名时同批更新）：
 *   sessions = 主会话树 / subagents = 子代理会话树（`<agentDir>/subagents/<encodeCwd>/sessions/`）
 *   / btw = btw 线会话树（`<agentDir>/btw/<encodeCwd>/<mainSid>/`）。
 *
 * 末位 'ext-sessions' 是 taiji session 存储树根段——基址是 `<dataDir>`（不是
 * piAgentDir），与 getSessionStoreDir / SESSION_STORE_DIR_SEGMENT 同源，对拍机检核对
 * 两者字面量一致。**消费注意**：本数组混两种基址，逐段 join(piAgentDir, segment) 的
 * 消费方（如 main 侧 isInsideSessionTrees）对末位段会 join 出不存在的基址——按
 * 「pi 宿主树段」语义消费前三位；需要存储树根时用 getSessionStoreDir 推导。
 *
 * main 进程不能 import runtime（包边界），树内包含判定（如会话 JSONL 导出的路径安全
 * 校验）等跨进程消费经本 SSOT 推导，禁止各进程自带树段字面量——与 getPiSessionsDir
 * 同款收敛（曾因手拼层级致跨进程判据漂移），runtime 改树名时唯一改点在本常量 +
 * 权威源两处，消费方零改。
 */
export const PI_SESSION_TREE_SEGMENTS = ['sessions', 'subagents', 'btw', 'ext-sessions'] as const

// ── session 存储树（`<dataDir>/ext-sessions/`）────────────────────────────────
//
// 全部 session 维度衍生数据的统一落点：以 sessionId 分区、域目录在后
// （`<root>/<sessionId>/<domain>/`）。物理结构 = 生命周期结构——session 删除时
// 整树回收，新域接入零删除链改动。
//
// 树内布局（<root> = getSessionStoreDir()）：
//   <root>/<sessionId>/
//     attachments/  artifacts/  image-cache/  plugin-data.json
//     canvases/<canvasId>/  background-tasks/  session-view.md
//     btw/<ts>_<线sid>.jsonl(.meta.json)
//     logs/{pi-<date>.jsonl(.N.gz), pi-crash-<date>.log, signal-forensics-<date>.jsonl}
//     subagents/{sessions/, records/, model-switch/}
//     workflow/runs/<runId>.record.jsonl
//
// 新域接入规约（两步）：① 树内新增 domain 目录；② 本文件新增一个具名推导函数
// （join(getSessionStoreDir(dataDir), sessionId, '<domain>')）——删除随整树回收
// 自动覆盖，无需登记任何删除链清单。
//
// pi 宿主树（agent/sessions 等，会话 jsonl 本体与紧贴 sidecar）不在本树内——
// 见 PI_SESSION_TREE_SEGMENTS 与设计豁免清单。

/** session 存储树根段名（`<dataDir>/<本段>/`）。 */
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/**
 * pi 会话 id 同域校验正则（镜像 runtime pi-paths.ts 的 `PI_SESSION_ID_PATTERN` /
 * isPiSessionId：首尾字母数字，中间允许 `[A-Za-z0-9._-]`；真 sid 永不含 `:`，
 * btw 虚拟 id `btw:<sid>` 含冒号必拒）。shared 不 import runtime（包边界），
 * 字面量一致性由 scripts/check-artifact-dir-formula-sync.mjs 三方对拍守护。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/**
 * pi 会话 id 同域校验（布尔判定，不 throw）。
 *
 * 与 assertPiSessionId 共用同一正则（本文件是跨进程唯一权威实现）：main 进程树内
 * 遍历点（image-cache 孤儿扫描 / local-file 读通道产物前缀枚举）不能 import runtime
 * 的 isPiSessionId（包边界），经本 SSOT 消费；runtime pi-paths.ts 同名函数为 pi 宿主
 * 侧权威源，字面量一致性由 scripts/check-artifact-dir-formula-sync.mjs 三方对拍守护。
 */
export function isPiSessionId(sessionId: string): boolean {
  return PI_SESSION_ID_PATTERN.test(sessionId)
}

/**
 * sessionId 入参同域校验（session 存储树全部推导函数的路径穿越防线）。
 *
 * 目录名即 sessionId，非法 id（含 `/` `\` `..` 空格冒号等）会在 join 后逃逸出
 * `<root>/<sessionId>/` 分区写到任意位置——统一在此 throw（fail-fast），各推导函数
 * 不再各自内联正则。
 *
 * @throws Error 当 sessionId 为空串、含路径分隔符/冒号或首尾非字母数字
 */
function assertPiSessionId(sessionId: string): void {
  if (!isPiSessionId(sessionId)) {
    throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`)
  }
}

/**
 * session 存储树根目录（`<dataDir>/ext-sessions/`）。
 *
 * 全部 session 维度衍生数据的统一落点（布局、新域接入规约见文件头「session 存储
 * 树」节注释）；与 pi 宿主树（`<dataDir>/agent/`）层级分离、语义可区分。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionStoreDir(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), SESSION_STORE_DIR_SEGMENT)
}

/**
 * 插件 KV 文件（`<root>/<sessionId>/plugin-data.json`，域 4）。
 *
 * 插件 per-session KV 的持久化落点（原旧布局 `<dataDir>/session-data/<sid>.json`）。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionPluginDataPath(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'plugin-data.json')
}

/**
 * 画布目录（`<root>/<sessionId>/canvases/`，域 8，画布 id 1:N 子分区）。
 *
 * 每张画布落 `<root>/<sessionId>/canvases/<canvasId>/`（events.jsonl + canvas.json +
 * exports/）；画布归属创建它的 session，跨会话访问按归属拒绝。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionCanvasesDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'canvases')
}

/**
 * 后台任务登记目录（`<root>/<sessionId>/background-tasks/`，域 5）。
 *
 * base-tool-enhance 后台任务的 registry.json 与任务日志落点（原旧布局
 * `<dataDir>/base-tool-enhance/<sid>/`；extension 侧公式镜像与 shared 的一致性由
 * 对拍机检守护，镜像换根归 u-ext-tasks-views）。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionBackgroundTasksDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'background-tasks')
}

/**
 * 会话导出文件（`<root>/<sessionId>/session-view.md`，域 6）。
 *
 * session-reader 导出 md 的落点（原旧布局 `<dataDir>/agent/tmp/session-view-<sid>.md`）。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionViewPath(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'session-view.md')
}

/**
 * btw 线会话目录（`<root>/<mainSid>/btw/`，域 7）。
 *
 * 主会话 mainSid 分区（分区键即入参 sessionId，无 encodeCwd 层）；线 jsonl 与
 * .meta.json sidecar 由 pi 写入，文件名保持 pi 命名约定（`<ts>_<线sid>.jsonl`）。
 * 线树随主会话删除整树回收。
 *
 * @param sessionId 主会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionBtwDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'btw')
}

/**
 * 会话日志目录（`<root>/<sessionId>/logs/`，域 11）。
 *
 * 带 sessionId 的日志（pi stdout tee `pi-<date>.jsonl(.N.gz)` / crash
 * `pi-crash-<date>.log` / signal-forensics-<date>.jsonl）落点；文件名不再内嵌 sid
 * （sid 已在路径）。全局日志（无 sessionId）仍在 `<dataDir>/logs/`，不入树。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionLogsDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'logs')
}

/**
 * subagent 记录目录（`<root>/<sessionId>/subagents/`，域 9）。
 *
 * 分区键 = rootSessionId（record 字段是既有关联权威）；子结构
 * sessions/（子代理会话 jsonl）· records/（ExecutionRecord）· model-switch/（模型
 * 切换交接信箱）见三个具名子函数。
 *
 * @param sessionId 根会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionSubagentsDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'subagents')
}

/** 子代理会话 jsonl 目录（`<root>/<sessionId>/subagents/sessions/`）。 */
export function getSessionSubagentSessionsDir(sessionId: string, dataDir?: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'sessions')
}

/** ExecutionRecord 目录（`<root>/<sessionId>/subagents/records/`）。 */
export function getSessionSubagentRecordsDir(sessionId: string, dataDir?: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'records')
}

/** 模型切换交接信箱目录（`<root>/<sessionId>/subagents/model-switch/`）。 */
export function getSessionSubagentModelSwitchDir(sessionId: string, dataDir?: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'model-switch')
}

/**
 * workflow 运行状态目录（`<root>/<sessionId>/workflow/`，域 10）。
 *
 * run 状态记录落 `<root>/<sessionId>/workflow/runs/<runId>.record.jsonl`；分区键 =
 * rootSessionId（run 创建记录字段）。
 *
 * @param sessionId 根会话 id（同域校验，非法 throw）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getSessionWorkflowDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'workflow')
}

/** workflow run 状态记录目录（`<root>/<sessionId>/workflow/runs/`）。 */
export function getSessionWorkflowRunsDir(sessionId: string, dataDir?: string): string {
  return join(getSessionWorkflowDir(sessionId, dataDir), 'runs')
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
 * 会话级图片附件目录（session 存储树域 1：`<root>/<sessionId>/attachments`）。
 *
 * write-session-image IPC 把粘贴的图片落到此目录（持久化，区别于 OS tmpdir 的自动清理）。
 * local-file:// 协议白名单放行整个 `<dataDir>` 前缀，让历史消息缩略图能加载。
 *
 * 纯函数无副作用——不创建目录（mkdir recursive 在 IPC handler 内做），仅做路径推导。
 *
 * **路径穿越防护**：sessionId 统一过 assertPiSessionId（与 runtime isPiSessionId 同域），
 * 非法 id throw——`../` 等载荷在 join 后会逃逸出 `<root>/<sessionId>/` 分区。
 *
 * @param sessionId 会话 id（决定子目录分区，须与 `isPiSessionId` 同域）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 * @throws Error 当 sessionId 含路径分隔符、冒号、空串或首尾非字母数字
 */
export function getAttachmentsDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'attachments')
}

/**
 * 朗读（TTS）缓存目录（`<dataDir>/tts-cache/`，设计 .tmp/tech-design/ai-voice-tts.md §7.4）。
 *
 * 合成结果 WAV 落盘处（文件名 = 缓存键内容哈希），经既有 local-file:// 协议回 renderer
 * 播放——main 侧 local-file 白名单已含 `<dataDir>` 整树，本目录落其下即被放行。
 * 可重建缓存语义（删除 = 全部重新合成，无状态损失）；封顶常量 TTS_CACHE_MAX_FILES /
 * TTS_CACHE_MAX_BYTES 在 shared constants（双条件 FIFO）。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function getTtsCacheDir(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), 'tts-cache')
}

/**
 * 单 session 的图片缓存目录（session 存储树域 3：`<root>/<sessionId>/image-cache`）。
 *
 * [D6-⑨] 纯缓存语义（可随时丢弃、可幂等重建）；落盘执行方 = main 进程（IPC
 * IMAGE_CACHE_WRITE），级联/孤儿/软上限清理均为此目录下的文件系统级动作。
 * local-file:// 协议白名单放行整个 `<dataDir>` 前缀（apps/electron/main/utils/
 * local-file-prefixes.ts）。
 *
 * 路径穿越防护与 getAttachmentsDir 同款（assertPiSessionId 同域校验）；目录名即
 * sessionId，孤儿扫描据此反查 pi sessions 目录。
 *
 * @param sessionId 会话 id（子目录分区，须与 `isPiSessionId` 同域）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 * @throws Error 当 sessionId 含路径分隔符、冒号、空串或首尾非字母数字
 */
export function getImageCacheDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'image-cache')
}

/**
 * 会话产物目录（session 存储树域 2：`<root>/<sessionId>/artifacts`，chat-html-support
 * §6.7 D7）。
 *
 * agent 生成的 HTML 产物默认写入此目录（capability 段每 turn 注入其绝对路径），目录在
 * local-file 白名单的既有成员 `<dataDir>` 前缀内——预览无需任何白名单改动。
 *
 * **路径穿越防护**：sessionId 统一过 assertPiSessionId（与 `isPiSessionId` 同域：
 * 首尾字母数字、中间允许 `[A-Za-z0-9._-]`、禁 `:`），非法 id throw——btw 虚拟 id
 * （`btw:<sid>`）含冒号必拒。
 *
 * 跨包边界：extensions 侧不 import shared，以同公式镜像推导（system-prompt 包内
 * `SESSION_STORE_DIR_SEGMENT` + `SESSION_ARTIFACTS_DIR_SEGMENT` 与同域正则），两侧
 * 字面量一致性由 `scripts/check-artifact-dir-formula-sync.mjs` 对拍机检守护。
 *
 * 纯函数无副作用——不创建目录（创建由 write 工具落盘时承担），仅做路径推导。
 *
 * @param sessionId 会话 id（子目录分区，须与 `isPiSessionId` 同域；允许 `.` / `_`、禁 `:`）
 * @param dataDir   可选数据根目录（测试注入）；缺省读 getDataDir()
 * @throws Error 当 sessionId 含路径分隔符、冒号、空串或首尾非字母数字
 */
export function getSessionArtifactsDir(sessionId: string, dataDir?: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'artifacts')
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
