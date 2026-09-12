# ext-simplify-14：shared 库三包过度设计收敛（file-lock 删 async 投机面 + cache-probe seq 声明修正 + 导出面收敛）

> **一句话结论**：删除 file-lock 扩展包零生产调用方的 async 锁编排面（withFileLock + 指数退避，约 65 行源码 + 130 行专项测试；runtime 侧有 6 处真实调用方的对应物不动）；cache-probe 的 seq 字段按 doc-right 修正「脚本跳跃检测」不实声明；三包导出面按「外部零引用即收窄」收敛（file-lock 双 Options re-export 与 LockCoreOptions、extension-logger LogLevel、cache-probe 测试专用导出 ×3）。已核实非过度面——sync 锁原语 + parity 测试、extension-logger 三通道机制——全部不动。

## 开篇（SCQA）

- **S（情境）**：`extensions/shared/` 下的 file-lock（跨进程文件锁）与 extension-logger（三通道路由日志）被 10+ 个 `@zhushanwen/pi-*` 扩展包依赖；同属共享库性质的 cache-probe（前缀指纹采集探针，物理位于 `extensions/universal/`，见下方证据基线修正）为归因分析提供数据。
- **C（冲突）**：2026-09-11 过度设计审计（sharedlibs 单元，候选 9 + M22 + low 清单）证实：file-lock 扩展包的 async 锁编排是零生产调用方的投机机制，且其退避公式与 runtime 侧逐字重复（第二份）；cache-probe 头注释与 README 声明「脚本靠 seq 跳跃区分漏记」而消费端 analyze.py 完全不读 seq；另有一批零引用的类型/工具导出。
- **Q（问题）**：如何在不触碰已核实本质复杂度（sync 锁原语与 parity 测试、extension-logger 三通道机制、runtime 侧 async 锁）的前提下，删掉投机面、修正声明漂移、收敛导出面？
- **A（答案）**：删（C9 async 面）+ 改声明（M22 doc-right）+ 收窄（low 导出面），共 14 个执行项（含删符号的连带悬空引用清扫与测试探针改写 3 项；§5.5 表共 15 行，另 E11 一项移交 code-simplify，其内含 2 处机械重构）；验收以两组真实场景为主——两真实进程抢同一文件锁、本地 pi CLI 实测 sync 调用方与探针采集。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单）。本设计不新增任何运行时机制、不改任何持久化格式，行为变更为零（纯删除 + 注释/声明修正），因此准则 5/6/7 以「删除不改变行为」的验证形态适用。

**证据基线**：本文化引行号均为 2026-09-12 本 worktree 实读值；全部调用方清单实跑 `rg` 核验；pi 断言核对自实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认）。**审计修正记录**：① cache-probe 物理路径为 `extensions/universal/cache-probe/`——任务描述写的 `extensions/shared/cache-probe/` 不存在（实读 `find` 证实），AGENTS.md 分组列举亦本就归 universal 组，本文一律用实际路径；② 审计发现 5 建议「PiLike 等类型导出可收窄为内部」，实读发现包内测试 `extension-logger.test.ts:10` 有 `import type { PiLike }`，据此修正裁决为部分保留（见 D3）；③ 其余抽验行号（C9/M22/发现 3/4/5）与实读一致或差 ≤2 行，无实质漂移。

---

## 1. 背景：三个共享库是什么

**三个包是扩展层的公共底座：file-lock 管「谁能在什么时刻写共享文件」，extension-logger 管「扩展日志写到哪」，cache-probe 管「prompt 前缀稳定性的数据采集」。** xyz-agent 的 runtime（Node 主进程）与 pi 子进程（每 session 一个）会双写同一批文件（auth.json、ext-config 家族、background registry），Node 单线程只能保证进程内不交错，跨进程「后写者基于旧快照覆盖先写者」靠文件锁互斥。锁统一架构（D1-A）的分工：

```
写方 A（runtime 侧）                              写方 B（pi 子进程扩展侧）
packages/runtime/src/utils/file-lock.ts           extensions/shared/file-lock
withFileLockSync / withFileLockAsync              withFileLockSync（C9 后唯一对外 API）
      │                                                  │
      └────────────── 同一磁盘协议，互斥同一把锁 ──────────────┘
        <目标文件>.lock 目录：mkdir 原子上锁 / realpath:false / stale 30s 判死夺取
        锁原语单点：@zhushanwen/pi-file-lock/core（lock-core.ts，零依赖，
        runtime 经 "./core" 子入口 import acquireLock/acquireLockSync 复用同一实现）
```

真实争用对 ≥4 组：auth.json（runtime auth-storage ↔ pi 内嵌 proper-lockfile，协议兼容权威源为实装 dist/core/auth-storage.js 的 `lockfile.lock(path, { realpath: false })`）、ext-config 家族（llm-shared saveConfig ↔ runtime worktree-config-helper）、bte background registry.json（bte registry.ts ↔ runtime background-task/reaper）、settings/providers.json（runtime 内部）。

extension-logger 解决「pi 宿主无 logger 接口」：扩展只能裸 console（污染 TUI）或自组 UI 刷屏，本包封装 appendEntry（事后排查通道）+ 文件日志（开发者调试通道，双开关分级 + 60s 窗口限流 + 7 天保留期清理）。cache-probe 是零行为影响探针：指纹变化时才向 session JSONL 写 custom entry（不进 LLM 上下文），配合 analyze.py 做 cache miss 归因，最终产出快照方案 GO/NO-GO 决策建议。

## 2. 设计目标

1. **删投机面**：file-lock 扩展包对外 API 与其真实消费面精确一致——只剩 `withFileLockSync`（2 个生产调用方全部用它），async 编排、退避公式、重复常量消失。
2. **声明与实装一致**：cache-probe 的 seq 字段注释与 README 不再声称不存在的消费方；extension-logger 的「三通道」描述、「参数漂移破坏互斥」注释修正为准确表述。
3. **导出面收敛**：三包中「外部零引用」的导出收窄，被 parity 测试与包内测试引用的锚点显式保留并登记理由。
4. **已核实面零回归**：sync 锁在真实跨进程竞争下行为不变（两进程并发 RMW 零丢失）；runtime 侧 async 锁（6 调用方）与 `/core` 子入口不受影响；extension-logger 机制行为不变。

**In-scope**：`extensions/shared/file-lock/`（src + tests + package.json 描述）、`extensions/universal/cache-probe/`（src/index.ts、fingerprint.ts、README、tests）、`extensions/shared/extension-logger/`（src/index.ts、package.json 描述）+ 相邻注释修正 `packages/runtime/src/utils/file-lock.ts`（仅注释）与 `packages/runtime/test/file-lock-parity.test.ts`（仅 :5 头注释，第四处同款，见 E5）+ 删符号的连带悬空引用清扫（C-proc-10，全部仅注释/登记表/测试，零行为）：`packages/subagent-core/src/execution/worktree-registry.ts`、`docs/architecture/data-source-registry.md`（worktrees.json 行）、`packages/subagent-core/src/core/logger.ts`（:16 注释）、`extensions/shared/llm-shared/src/__tests__/config.test.ts`（:24 注释）、`extensions/universal/base-tool-enhance/src/__tests__/maintenance-once.test.ts`（测试 mock/断言改写，见 E14）。
**Out-of-scope**：runtime 侧 file-lock.ts 的任何行为面（withFileLockAsync 6 调用方、sync 编排本体）；subagent-core 与 runtime 的任何行为面（连带清扫仅注释与登记表；worktree-registry 的 proper-lockfile 直用实装不动）；lock-core.ts 的协议与单次原语定位；extension-logger 限流/清理机制本体；cache-probe 的采集 schema（v2 字段集不变）；fileLog size cap 的实装（裁决为豁免登记，见 D4）。

---

## 3. 现状与问题分析

### 3.1 现状的真实样子（取自实读代码）

**问题 1：file-lock 扩展包的 async 面无人使用。** `extensions/shared/file-lock/src/file-lock.ts` 当前对外导出两个锁 API，头注释（:9-11）解释 async 版存在理由：

```
// 为什么是 async API 而非 runtime 侧的 withFileLockSync：扩展跑在 pi 子进程的
// async hook 上下文（session_start 等），同步 busy-wait 会阻塞整个 event loop；
// async 版用指数退避重试（本文件编排），sync 版保持同步 busy-wait。
```

该赌注对应的 API 群：`FileLockOptions`（:47-52）、`DEFAULT_RETRIES`（:66）、退避常量 `RETRY_FACTOR/RETRY_MIN_TIMEOUT_MS/RETRY_MAX_TIMEOUT_MS`（:72-74）、`backoffDelayMs`（:94-97，公式与 `packages/runtime/src/utils/file-lock.ts:132-135` **逐字重复**）、`withFileLock`（:105-135）、`sleep`（:199-201）。全仓调用方实跑核验（`rg "withFileLock\(" extensions/ packages/ apps/ scripts/ -g '!*.test.ts'`，排除包自身）：

| 调用点 | 实际指向 | 用的是扩展包 API 吗 |
|---|---|---|
| runtime auth-storage.ts:136,:151 | 本地别名函数（:65 定义，包装 ：24 import 的 `withFileLockAsync`） | 否 |
| runtime provider-extras-store.ts:229,:244,:271,:287 | runtime 自己的 `withFileLockAsync`（:21 import 自 utils/file-lock.js） | 否 |
| **llm-shared/config.ts:206** `withFileLockSync(configPath, writeLocked)` | `@zhushanwen/pi-file-lock`（:29 import） | **是，sync 版** |
| **base-tool-enhance/background/registry.ts:195** `withFileLockSync(registryPath, writeMerged)` | `@zhushanwen/pi-file-lock`（:33 import） | **是，sync 版** |

**扩展包 async 版生产调用 = 0**；沾 async 面的其余文件两类：包自己的测试（`file-lock-backoff.test.ts` 全文件 130 行、`file-lock.test.ts` 的 async describe :26-91 与子进程 worker :147-168、`file-lock-external-removal.test.ts` 全文件），以及 base-tool-enhance 的 `maintenance-once.test.ts`（:36-38 在 `vi.mock("@zhushanwen/pi-file-lock")` 工厂中注册了 `withFileLock` 键作「全局扫描探针」——非调用，是防 reap 回流的 mock 断言面，删符号后须同批改写，见 E14）。

**问题 2：cache-probe 声明了一个不存在的消费方。** `src/index.ts:16-17`：

```
 * seq = 进程内 before_agent_start 触发计数（无论是否写 entry 都递增），
 * 脚本靠 seq 跳跃区分「无变化 turn」与「漏记」。
```

README.md 同样写「跳跃 = 中间有无变化 turn 或漏记」。消费端实读：`analyze.py` 全文 0 处读 seq——它消费 `error`（:126）、`baseline`/`h`/`startReason`（:129-133）做增量 merge 与归因，**「漏记检测」不存在**。seq 本身确实写进了每条 entry（error entry index.ts:66,:94；probe entry fingerprint.ts:162,:174）。

**问题 3：零引用导出散布三包。** 实跑核验：file-lock `LockCoreOptions`（lock-core.ts:53）全仓仅自身 3 行；index.ts:24-25 的 `FileLockOptions/SyncFileLockOptions` re-export 外部零引用（runtime 用的是自己 utils 里的同名接口）；cache-probe `HASH_LEN/stableStringify/diffFingerprints`（fingerprint.ts:14/:49/:92）仅测试引用（三者在包内各有真实内部使用：hashOf :58、buildProbeEntry :170）；extension-logger `LogLevel`（:157）外部零引用，`warn`/`error` 两段限流处理块（:237-273 vs :274-309）近乎逐字重复约 30 行 ×2。

### 3.2 真实失败模式

- **F1（投机税）**：async 面的 65 行 + 5 个概念（FileLockOptions/retries/退避公式/sleep/错误串行化）无任何生产消费者，每次读码、改锁行为都要先回答「这个 async 版谁在用」——答案是没人。
- **F2（重复第二份）**：`backoffDelayMs` 与退避常量在 runtime 侧有一份逐字拷贝（runtime 侧有 6 真实调用方必须保留）。扩展包这份的存续没有消费方理由，只制造「改退避参数要同步几处」的漂移面。
- **F3（声明 > 实装）**：cache-probe 的 seq 声明会让读者（以及未来想「用上」该字段的人）以为漏记检测已存在，实际 analyze.py 无此逻辑——文档性漂移掩盖能力缺口。
- **F4（导出面噪音）**：测试专用导出与死类型导出让「包的公共 API 是什么」无法从 export 关键字读出；extension-logger 头注释自称「三通道」而实装两通道（通道 1「AI 实时」仅为分类法登记，:12-17）；file-lock 默认参数注释（:64-65，runtime 侧 ：56-60 同款）声称「参数漂移会破坏同一把锁的互斥语义」——不准确：互斥由 lockfile 路径 + mkdir 原子协议保证，staleMs 漂移只影响夺取时机、重试参数漂移只影响失败速度（第 2 轮全仓扫描：该失准表述的活注释共四处，第四处在 parity 测试头注释，见 E5 扫描结论）。

### 3.3 根因

**「对称补全」惯性。** runtime 侧有 async 锁（auth-storage/provider-extras 的真实需求），扩展包建包时按「runtime 有什么我就有什么」补了一套 async 编排，而不是从扩展侧真实调用方（全部 sync，因命令回调链必须保持 sync 签名）倒推 API 面。cache-probe 的 seq 声明则是「写了字段就顺手声明一个理想消费方」——设计文档口径先行，消费端实装未跟上，且没有守卫逼二者对齐。本质复杂度部分（sync 原语、三通道路由）均已通过四问验证（锁：jiti 类加载器事故根因 + 与 pi 内嵌 proper-lockfile 协议互斥的真实需求；logger：no-console SSOT 载体 + appendEntry 无界膨胀防御 + 10+ 包依赖收敛为 3 个值函数 API），本设计不触碰。

---

## 4. 终态（使用者视角先行）

**改造后，三个包的对外面与其真实消费面一一对应，读 export 即得全貌。**

- **file-lock**：包入口（`.`）仅导出 `withFileLockSync`；`DEFAULT_STALE_MS/DEFAULT_RETRY_DELAY_MS/DEFAULT_RETRY_BUDGET_MS` 三常量与 `SyncFileLockOptions` 参数类型留在 `src/file-lock.ts` 模块导出位、**不进包入口**——parity 测试刻意经相对路径直连源文件 import（`packages/runtime/test/file-lock-parity.test.ts:47-56`，其头注释明言：经包名主入口 import 会拉 extension-logger→pi SDK peer 链进 runtime 测试图），常量锚点无需入口 re-export，加了即零消费导出。`./core` 子入口不变（runtime 的 acquireLock/acquireLockSync）。llm-shared 与 bte 的调用代码零改动。头注释不再有 async 段落；「两进程抢同一把锁」的行为与今天完全一致（sync 版本来就是生产在用的路径）。
- **cache-probe**：探针行为零变化（seq 仍随 entry 写入）；头注释与 README 改为如实描述——seq 是进程内触发计数，当前无自动消费方；fingerprint.ts 只导出被 handler 消费的纯函数。
- **extension-logger**：10+ 消费包用的三个值函数（getLogger/setPiHandle/createLogger）与其类型契约（PiLike/ExtensionLogger）不变；LogLevel 转内部；头注释与 package.json 描述如实描述「实装两通道 + 第三通道留给 pi 原生」。

失败路径（改造本身引入的新失败面）：无新增——删除的 API 无调用方，typecheck 会把任何漏网的**代码级引用**当场暴露（恢复指引：`pnpm extensions:typecheck` 报错点即残留引用点，按 §6 执行项表回补或确认删除）。守卫边界诚实声明：**注释与登记表类悬空引用 typecheck 不覆盖**，机器防线 `scripts/check-doc-symbol-drift.mjs` 也兜不了底（实读其 DOC_MODULE_MAP 显式映射表：本文档与 data-source-registry.md 均未登记，且该脚本只检查映射设计文档的反引号符号候选、不扫源码注释）——因此删符号的注释/登记表悬空点必须按 C-proc-10 同批人工清扫，点位清单见 E12/E14（实施 SSOT），不可依赖机器信号。

## 5. 关键决策与权衡

**本章结论：4 个决策——D1 删 async 面（C9）、D2 seq 走 doc-right（M22）、D3 导出面分项收敛、D4 size cap 豁免登记 + 注释修正。**

> 方向词约定：**code-right** = 改代码；**doc-right** = 改注释/文档使声明与实装一致。

### 5.1 D1：file-lock 扩展包 async 面（选定：删除，即审计候选 9 的 code-right 方向）

- **采用**：删 `withFileLock`、`backoffDelayMs`、`RETRY_FACTOR/RETRY_MIN_TIMEOUT_MS/RETRY_MAX_TIMEOUT_MS`、`FileLockOptions`、`DEFAULT_RETRIES`、`sleep`、`stringifyErr`（仅 async 版 release catch :132 使用）；`file-lock-backoff.test.ts` 整文件删除；`file-lock.test.ts` 删 async describe、子进程 worker 改用 `withFileLockSync`（外层 ELOCKED 自旋包裹形态保留）；`file-lock-external-removal.test.ts` 改用 `withFileLockSync`（其验证的 release ENOENT 容忍语义在 sync 释放路径同源——lock-core.ts:135-141 `removeLockSync`）；index.ts 同步收敛。runtime 侧 `withFileLockAsync`/`backoffDelayMs`（6 真实调用方）与 `./core` 子入口不动。**连带（C-proc-10 同批清扫）**：删符号在包外的注释/登记表/测试悬空引用同 commit 清算——包内 `file-lock.ts:141-142` 与 `lock-core.ts:230-231` 两处 JSDoc（E1/E3 内）、包外 `worktree-registry.ts` 两处注释与 `data-source-registry.md` worktrees.json 行（E12）、bte `maintenance-once.test.ts` 探针 mock（E14）。
- **被否**：
  - **保留（声称 forward-ready，赌「未来 async hook 锁需求」）**——该赌注自 integrity-hardening 时期写下至今未发生，生产 2 调用方全 sync；65 行 + 130 行测试为不存在的需求持续缴税。若用它，§3.1 的调用方表继续呈现「6 行 runtime 命中全非本包 API」的空转面。
  - **收编（sync/async 编排统一下沉 lock-core）**——lock-core 的「单次原语、重试属消费方」定位是 D1-A 设计显式定案（lock-core.ts:229-232 注释），收编需改 runtime 侧已定架构且 runtime async 编排不可删，风险放大、超出简化范围。
- **证据**：§3.1 调用方表（实跑 rg）；runtime 侧 6 调用点实读（auth-storage.ts:24,:65,:136,:151；provider-extras-store.ts:21,:229,:244,:271,:287）；parity 测试 `packages/runtime/test/file-lock-parity.test.ts:47-56` 从扩展包 file-lock.ts import 的仅 `DEFAULT_STALE_MS/DEFAULT_RETRY_DELAY_MS/DEFAULT_RETRY_BUDGET_MS/withFileLockSync`——全部在保留清单内（且经相对路径直连源文件、不经包入口），parity 测试零改动。
- **效果**：目标 1、4；F1/F2 消灭；锁行为零变化（删的是无调用方代码路径）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 删 async 面（选） | API 面与消费面一致；退避公式回归 runtime 单份；概念 -5 | 低-中：1 源文件删 + 3 测试文件改造 + package.json 描述 | 极低（零调用方；typecheck + parity 测试兜底） | ✅ |
| 保留 forward-ready | 双轨 API 面，投机税永续 | 零 | 每次全仓动作携带维护义务 | ❌ |
| 收编 lock-core | 改已定案的 core 定位 | 高：runtime 侧联动改造 | 触碰 6 真实调用方的已验证链路 | ❌ |

### 5.2 D2：cache-probe seq 声明（M22，选定：doc-right 修正声明，seq 字段保留）

- **采用**：`src/index.ts:16-17` 与 README 的 seq 段改为如实描述——「seq = 进程内 before_agent_start 触发计数，随 entry 落盘供人工排序诊断；当前无自动消费方（analyze.py 不读 seq）」。seq 字段本身保留写入。
- **被否**：
  - **补实装（analyze.py 加 seq-gap 漏记统计）**——探针现有分析闭环（归因矩阵 + GO/NO-GO）不依赖漏记检测；异常路径已有 error entry（「失败要出声」）+ stderr 诊断覆盖，剩余「静默漏记」类无实证发生过；为 GO/NO-GO 决策后即退场的临时探针加当前不需要的分析机制，违反减法优先。若用它，§3.1 的 analyze.py 需新增统计段 + 测试，换来一个无消费需求的指标。
  - **连 seq 字段一起删**——schema v2 采集进行中，删字段是格式 churn；字段近零成本且有进程内事件排序价值。
- **证据**：analyze.py 全文实读 0 处 seq 消费（:124-133 消费面为 error/baseline/h/startReason）；seq 写入点 index.ts:66,:94、fingerprint.ts:162,:174。
- **效果**：目标 2；F3 消灭。登记重审触发条件见 §7「已接受代价」第 1 条。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| doc-right 修正声明（选） | 声明=实装；字段留作人工诊断 | 极低：2 处文案 | 无 | ✅ |
| 补实装 seq-gap 统计 | 给临时探针加无需求指标 | 中：脚本 + 验证 | 分析面膨胀 | ❌ |
| 删 seq 字段 | schema churn 无收益 | 低 | 采集中格式变更 | ❌ |

### 5.3 D3：导出面收敛（分项裁决；对审计建议的一处实读修正）

| 项 | 位置 | 裁决 | 理由（证据） |
|---|---|---|---|
| file-lock `LockCoreOptions` | lock-core.ts:53 | 去 export（接口保留为内部参数类型） | 全仓仅自身 3 行；runtime 传字面量不 import 类型 |
| file-lock index.ts 双 Options re-export | index.ts:14-15,:24-25 | 删 re-export | 外部零引用；runtime 用自己 utils 的同名接口（worktree-config-helper.ts:36） |
| file-lock `DEFAULT_STALE_MS/DEFAULT_RETRY_DELAY_MS/DEFAULT_RETRY_BUDGET_MS` | file-lock.ts:44,:67-68 | **保留** | parity 测试锚点（file-lock-parity.test.ts:42-58 实读引用），可辩护测试锚点 |
| extension-logger `LogLevel` | index.ts:157 | 去 export | 外部与包内测试均零引用（纯内部：fileLog/effectiveLevel 使用） |
| extension-logger `PiLike` | index.ts:151 | **保留**（修正审计建议） | 包内测试 `extension-logger.test.ts:10` `import type { PiLike }`；收窄仅迫使测试自定义同构类型，零净收益 |
| extension-logger `ExtensionLogger` | index.ts:163 | **保留** | getLogger 返回类型的事实契约名；10+ 消费包靠推断使用，导出零成本 |
| extension-logger 2 测试出口（clearRateLimiterState:141/resetExtLogCleanupForTest:402） | — | **保留** | 声明的测试出口、有先例、模块级状态跨用例需重置（审计同项建议即保留） |
| cache-probe `HASH_LEN/stableStringify/diffFingerprints` | fingerprint.ts:14,:49,:92 | 去 export + 测试改经公有面 | 与 ext-simplify-02 的 computePromptHash 先例同型：HASH_LEN→测试硬编码 16（「hash 为 16 hex」本就是 schema 契约断言）；stableStringify 的稳定性用例改经 `hashOf` 等价性断言（key 序/undefined→null/数组有序性质不变）；diffFingerprints 用例改经 `buildProbeEntry` 的 changed 数组断言 |
| extension-logger `createLogger(extName, pi?)` 第 2 参 | index.ts:229 | **保留 + JSDoc 标注「测试隔离注入用，生产一律 setPiHandle/getLogger」** | 生产零调用但测试真实消费（test :36,:50,:62,:77）；删除迫使测试经全局单例编舞，净复杂度反增——「定位与实际不符」用诚实 JSDoc 修，不用删参修 |

### 5.4 D4：fileLog 无 size cap + 注释漂移（选定：doc-right 豁免登记 + 修正）

- **采用**：①extension-logger 头注释显式声明 size 豁免与依据（进程短命 + 7 天保留期 + DEBUG 档系开发者主动排障；执行项 E13），接受代价四要素见 §7；②「三通道」描述修正（index.ts:12-17 注释 + package.json description 改为如实表述「实装两通道封装，第三通道留给 pi 原生」；执行项 E10）；③「参数漂移破坏互斥」注释修正（同款失准活注释共四处：extensions file-lock.ts:64-65、runtime utils/file-lock.ts:56-60、subagent-core worktree-registry.ts:42-44（在 E12① 要改写的注释块内，随其同口径修正）、runtime parity 测试头注释 :5；执行项 E5 + E12①）：互斥由 lockfile 路径 + mkdir 原子协议保证，默认值对齐的意义是两侧夺取时机（stale）与失败速度（重试参数）行为一致，parity 测试锚定防无意识漂移。三个子项逐一对应执行项（E13/E10/E5），①此前仅在正文声明、无执行项承载，第 1 轮补齐。
- **被否**：**实装单文件 size cap**——需要轮转命名变体，而清理逻辑的文件名 regex（index.ts:385 `/^.+-\d{4}-\d{2}-\d{2}\.log$/`）不匹配带序号的轮转文件，须联动改造清理规则；为低风险场景引入机制链，成本显著大于收益。
- **证据**：fileLog 实读 index.ts:422-442（仅 date 分文件 + 7 天 mtime 清理，无 size 逻辑）；`XYZ_AGENT_EXT_LOG=1` 由 runtime rpc-client 托管注入（真实触发场景，env 名实装恒为 `XYZ_AGENT_EXT_LOG`——extension-logger/src/index.ts:15/:51/:354，注入点 packages/runtime/src/infra/pi/rpc-client.ts:196）；pi 进程每 session 短命（extension-logger index.ts:76-77 注释自证该模型）。
- **效果**：目标 2；F4 消灭；与项目「date + size 双策略」日志规范的差异从「无声明」变为「有依据的显式豁免」。

### 5.5 执行项总表

| # | 包 | 位置 | 改动内容 | 性质 |
|---|---|---|---|---|
| E1 | file-lock | src/file-lock.ts | 删 async 面 7 个符号（D1 清单）+ 头注释 sync-only 化（删 ：9-11 async 理由段、:24-26 退避协议行，契约段改 sync 口径：「fn 内仅做既定读改写（读目标文件 + 纯内存变更 + 原子写），禁其他 I/O / 再次对本文件加锁」）+ **:141-142 withFileLockSync JSDoc 去「与 async 版锁同一把 lockfile / sync/async API 磁盘同一协议」对照段**（async 版删除后该对照失效，改述「与 runtime 侧 sync 实现同协议」） | D1 直接执行 |
| E2 | file-lock | src/index.ts | 去 withFileLock/FileLockOptions import 与导出、删双 Options re-export（收敛后入口仅 `export { withFileLockSync }`——三 parity 常量不进入口，见 §4） | D1/D3 直接执行 |
| E3 | file-lock | src/lock-core.ts | LockCoreOptions 去 export（:53）+ **:230-231 acquireLock JSDoc「重试编排属消费方：包入口 async 退避 / sync busy-wait」更新**（本包 async 退避删除后失效，改为「消费方编排：extension 侧 sync busy-wait（file-lock.ts）/ runtime 侧 async 退避（utils/file-lock.ts）」） | D3 直接执行 |
| E4 | file-lock | package.json | description 去「exponential-backoff retries」表述 | doc-right 直接执行 |
| E5 | file-lock + runtime | file-lock.ts:64-65、runtime utils/file-lock.ts:56-60、runtime test/file-lock-parity.test.ts:5 | 「参数漂移破坏互斥」注释修正，**同款失准活注释共四处**（第 2 轮全仓扫描定案，扫描模式「参数漂移/互斥语义/破坏互斥」）：前三处见 D4③；第四处 parity 测试头注释 :5 主句「互斥语义依赖两侧默认参数一致」为半失准（主句把互斥归因参数一致；括注「stale 决定夺取窗口、retry 间隔/预算决定等待形态」与「lockfile 路径推导一致」条件本身准确）——主句按同口径改写：互斥由 lockfile 路径推导一致 + mkdir 原子协议保证，默认参数一致锚定的是两侧夺取时机与等待形态行为一致。扫描其余命中判定：settings.json 行「互斥只依赖同一 lockfile」等为正确表述、bash/UI/CAS 域互斥为不同概念域、归档设计文档 file-lock-unification-and-reaper-sink.md:61 属历史决策记录不作活注释追溯——**无第五处**。runtime 侧仅注释（2 行 + parity 头注释 1 行），零行为 | doc-right 直接执行 |
| E6 | file-lock | src/__tests__/ | file-lock-backoff.test.ts 删除；file-lock.test.ts 删 async describe + worker 改 withFileLockSync；file-lock-external-removal.test.ts 改 withFileLockSync | D1 直接执行 |
| E7 | cache-probe | src/index.ts:16-17、README.md | seq 声明修正（D2 文案） | M22 裁决=doc-right 直接执行 |
| E8 | cache-probe | src/fingerprint.ts + __tests__/fingerprint.test.ts | ×3 去 export + 测试改经公有面（D3 表行 8） | low contested→裁决 code-right |
| E9 | extension-logger | src/index.ts | LogLevel 去 export；PiLike/ExtensionLogger/2 测试出口保留；createLogger JSDoc 标注 | low contested→裁决（部分保留） |
| E10 | extension-logger | src/index.ts:12-17、package.json | 「三通道」描述修正 | doc-right 直接执行 |
| E11 | extension-logger + cache-probe | index.ts:237-273 vs :274-309；cache-probe index.ts:84 | warn/error 限流块抽 `appendWithRateLimit` 私有函数；sentToolsOf 双调用提取局部变量 | **移交 code-simplify**（机械重构，有既有单测护栏） |
| E12 | subagent-core + docs | worktree-registry.ts:40-45、:186-199；data-source-registry.md:110、:114 | **删符号包外悬空引用清扫（C-proc-10 同批，随 E1 单 commit）**：① worktree-registry.ts 两处注释「锁参数/锁协议逐项对齐 extensions/shared/file-lock/src/file-lock.ts 的 withFileLock」改指现存对齐目标（runtime 侧 utils/file-lock.ts withFileLockAsync + proper-lockfile retry 库参数 + pi auth-storage 范本，三方同一磁盘协议），并删「与旧包装共存/替换期间尤其如此」过时句（该文件已 proper-lockfile 直用，:28 实读）；**:42-44「两侧参数漂移会破坏…跨进程互斥语义」是 E5 已裁决失准表述的第三处同款，恰在本注释块内——按 E5 同款裁决一并修正**（互斥由 lockfile 路径 + mkdir 协议保证，默认值对齐的意义 = 夺取时机/失败速度行为一致；不修正则与 E5 改后的 runtime 侧注释形成仓内矛盾），改写后注释**不留被删符号裸提及**（V5-① 域已含 packages/subagent-core/，词边界零命中可判，基线 2 行见 §6）；② data-source-registry.md:110 worktrees.json 行锁协议列由「`@zhushanwen/pi-file-lock` async 版 withFileLock（worktree-registry.ts:162）」更新为 proper-lockfile 直用现状（async `lock()` + realpath:false + stale 30s + retries 10 指数退避 + onCompromised，withLock() 方法承载），降级句行号引用改方法名（`mutate()` catch）——该登记表是 review 对照 SSOT，行内容本已滞后于实装，本轮一并清算；**同表 :114 system-prompt-trace-baseline 行升格句「（worktree-registry.ts:162 / rename-session config.ts 双端先例）」行号存量失准同批修正**（:162 实读为 mutate/run 内 this.load() 行，锁协议实装在 withLock :198；且 worktree-registry 已 proper-lockfile 直用、不复消费 pi-file-lock，「双端先例」只剩 rename-session 单端——先例列举改单端 + 注明 worktree-registry 先例已改直用）。:114 与 ：110 同文件同源存量漂移、与删面无因果（withFileLockSync 为保留符号，非悬空引用），归 E12② 而非 E15 是归属决策：同文件同批一次清算、避免登记表跨 M1/M2 两个 commit 分散改动 | C-proc-10 强制场景（:114 为存量漂移顺带修正） |
| E13 | extension-logger | src/index.ts 头注释 | **fileLog size 豁免声明（D4①）**：头注释补一段「fileLog 单日文件无 size cap——显式豁免，依据：写入方为每 session 短命 pi 进程 + 7 天保留期清理 + DEBUG 档系开发者主动排障；重审触发条件见 docs/design/ext-simplify-14-shared-libs.md §7」，使「与 date+size 双策略日志规范的差异」从无声明变为有依据的显式豁免（代码现场留痕，不只存在于设计文档） | D4① doc-right 直接执行 |
| E14 | base-tool-enhance | src/__tests__/maintenance-once.test.ts | **探针 mock 随符号删除改写（随 E1 单 commit）**：vi.mock 工厂移除 `withFileLock` 键（连同 vi.hoisted 的 withFileLockMock 定义、beforeEach mockReset）；删除 ：122 断言 `expect(withFileLockMock).not.toHaveBeenCalled()`（导出删除后 mock 无可调用路径，断言恒真、守卫价值已失）；守卫语义升级为「工厂缺键」——维护链误回流对已删符号的**任何访问（调用与 typeof 均计）即抛错**（vitest 4.1.9 实测：模块导入本身不抛、测试文件正常加载；「import 但不调用」场景 mock 无信号，该面由 `pnpm extensions:typecheck` 的 .d.ts 导出面兜底）——仍强于恒真计数断言（误回流访问必红且错误信息直指 mock 缺键）；:8、:34-35 注释同步改写且**不保留被删符号裸提及**（V5-① 词边界零命中标准要求）；withFileLockSync throw 哨兵保留（registry 写路径守卫仍有效）。依赖的 vitest 行为已实测（§7.4 ③ ✅），E14 据此定稿，实施期无需再探 | D1 连带（测试面） |
| E15 | subagent-core + llm-shared | subagent-core/src/core/logger.ts:16；llm-shared/src/__tests__/config.test.ts:24 | **存量注释事实漂移修正（两处均经实读确证、与本设计删面无因果，随 doc-right 批带上）**：① logger.ts:16「对齐 @zhushanwen/pi-extension-logger 的 LogLevel（三值，无 info）」——实装 LogLevel 为四值 `"debug" \| "info" \| "warn" \| "error"`（extension-logger index.ts:157 实读）；修正为「级别集合对齐 pi-extension-logger（其 LogLevel 为包内部类型、含 info 四值；实例 API 仅 debug/warn/error 三方法，core facade 据此收窄为三值）」，且 E9 去 export 后不再以符号级引用描述对齐目标；② config.test.ts:24「proper-lockfile（withFileLockSync 内部）走 graceful-fs」——实装 lock-core.ts 为自实现 mkdir-lock（D1-A 零第三方依赖，经本测试图 node:fs mock 默认透传 actual），括注按实况改写。**验收归属（第 2 轮登记）**：subagent-core 两处注释改动的机器验收分叉——worktree-registry.ts（E12①）已纳入 V5-① 扫描域（packages/subagent-core/，词边界零命中可判）；logger.ts:16（本项①）登记为 **doc-right 无自动验收**：改动对象是事实性描述（值域/方法集），LogLevel 属保留符号（E9 仅去 export，V5-② 已在 extension-logger 包内断言其 export 声明消失）且修正文案仍合法提及该类型名，「符号裸提及零命中」类断言对其不适用，由 M2 批人工 review 承载 | 存量漂移 doc-right |

---

## 6. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中」（删零调用方机制 + 声明修正），用 5 个真实场景验收；单测/三连仅作回归辅助。**

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | 两真实进程抢同一文件锁 | 目标 4（sync 锁零回归） | 改造后的 file-lock.test.ts「真实跨进程互斥」用例（D5a 形态）：两个真实 node 子进程（--experimental-strip-types 跑本包源码）并发对同一 JSON 各 RMW 50 次，真实文件系统、真实进程竞争 | 两子进程 exit 0，目标文件终值精确 100（零丢失）；锁释放语义由同文件 sync describe 的「finally 释放语义/可再锁」用例承载（跨进程用例 tmp 目录整体清理，无独立 lock 残留断言） |
| V2 | pi CLI 实测扩展侧 sync 调用方 | 目标 4（生产链路） | 本地 pi CLI 按 AGENTS.md 强制形态实测：`pi --mode rpc --session-dir <tmp> --extension extensions/universal/permission`（其命令回调经 llm-shared saveConfig→withFileLockSync 写 permission 配置文件）触发一次保存；另跑 rename-session 同法一次 | 配置文件正确写入（新字段落盘）；对应 `<config>.lock` 无残留；无 ELOCKED 报错日志 |
| V3 | runtime 侧不受影响 | 目标 4（已核实面） | 跑 runtime 侧 `file-lock-parity.test.ts` 与 runtime 自身测试（auth-storage/provider-extras 相关）：runtime 代码零改动，仅注释变更（utils/file-lock.ts :56-60 + parity 测试头注释 ：5，E5） | parity 测试绿（两侧默认常量相等断言过）；runtime 测试绿；`git diff` 确认 runtime 侧仅上述注释变更 |
| V4 | cache-probe 采集 + 归因脚本 | 目标 2（声明修正后链路完整） | pi CLI 带 cache-probe 本地源码跑真实 session（2-3 turn，其中一 turn 修改 skill 文件制造指纹变化）→ 读 session JSONL 的 cache-probe entry；再跑 `python3 analyze.py ~/.pi/agent/sessions` | entry 含 baseline/normal 形态、seq 字段仍在；analyze.py 五部分输出正常（脚本本就不读 seq，证明声明修正无消费缺口） |
| V5 | 负面行为：不该存在的导出不存在 | 目标 1、3（收敛生效的反向验证） | 执行下方 V5 命令组（三模式必须区分「删除类」与「收敛类」，且用词边界 + 域范围排除同形保留符号——`withFileLock` 是保留符号 `withFileLockSync`/`withFileLockAsync` 与 runtime 本地别名 `withFileLock` 的子串，`FileLockOptions` 是 `SyncFileLockOptions` 的子串，`HASH_LEN` 是 runtime `MODEL_KEY_HASH_LEN` 的子串，裸子串 rg 必然假阳性；删除类域 = extensions/ + packages/subagent-core/——**定向扩 subagent-core 域承载 E12① 的验收**（其删除符号命中面恰为 E12① 两处改写点 worktree-registry.ts:41/:187，无第三方命中；runtime 本地别名声明的 `withFileLock` 在 packages/runtime 域，不入扫描域故零误报——全 packages/ 域不可用正是因它）；另跑 `pnpm extensions:typecheck && extensions:lint && extensions:test` 三连 | ①② 全部 0 命中、③ 双断言精确命中 + 三连绿。**设计期基线（2026-09-12 实跑，证明模式可检出残留）**：① 48 行命中、分布 7 文件（file-lock 包自身 43 行：file-lock.ts 14 / index.ts 4 / 三测试文件 25；bte maintenance-once.test.ts 3 行：mock 键 + 2 处注释；worktree-registry.ts 2 行：E12① 两处对齐目标句）——全部属 E1/E6/E14/E12① 清扫面，实施后归零；② 恰好 5 行 = 5 个待收敛 export 声明（fingerprint.ts:14/:49/:92、extension-logger index.ts:157、lock-core.ts:53），实施后归零且符号内部使用保留（hashOf/buildProbeEntry/fileLog 不受影响）；③ 双断言（§4「入口仅导出 withFileLockSync」的正反两半都可判定）：`^export` 当前恰 1 行（:21 单 export 块）实施后仍恰 1 行——守「不新增第二个 export 声明」，新增独立 re-export 行（如 `export type { SyncFileLockOptions };`）即 2 行红；`withFileLock\|FileLockOptions` 当前 8 行（:12-15 import 块 + :22-25 export 块）实施后恰 2 行（withFileLockSync 的 import/export 各 1）——裸子串不带词边界系有意：入口域内 FileLockOptions/SyncFileLockOptions 皆应无，塞入现有 export 块即 3 行红。**sleep 豁免登记**：E1 清单中的 sleep 不入 ① 正则——`\bsleep\b` 在 extensions 域 122 行 15 文件（bte/plugin-bridge/subagent-workflow 等自有同名 helper）实施后不可归零，且 file-lock 包内保留面尚有 2 行概念性注释提及（SyncFileLockOptions JSDoc「同步 sleep」、withFileLockSync 头注释「sleep 用 Atomics.wait」，非符号引用），词边界机器断言对该符号不成立；兜底 = E1 删除清单 + typecheck（私有函数删后调用残留即红）+ `pnpm extensions:lint`（`@typescript-eslint/no-unused-vars` error 级、仅 `^_` 前缀豁免——删调用留定义残留即红）+ code-simplify 死代码扫描。若实施后任一模式仍命中，命中点即清扫遗漏，按执行项表回补 |

V5 命令组（围栏内为可照抄实跑形态；①删除类 = 符号应不存在，词边界 + extensions/subagent-core 双域 + 仅 .ts 天然排除 CHANGELOG、runtime 侧保留符号与 .md 登记表（登记表由 E12② 人工清算，机器不扫 .md）；②收敛类 = 符号转内部、本体保留，断言「export 声明消失」而非符号消失；③包入口面双断言）：

```bash
# ① 删除类：0 命中为过（域含 packages/subagent-core/，E12① 注释改写验收；sleep 豁免见 V5 行）
rg -n "\bwithFileLock\b|\bFileLockOptions\b|\bDEFAULT_RETRIES\b|\bbackoffDelayMs\b|\bRETRY_FACTOR\b|\bRETRY_MIN_TIMEOUT_MS\b|\bRETRY_MAX_TIMEOUT_MS\b|\bstringifyErr\b" \
  extensions/ packages/subagent-core/ -t ts

# ② 收敛类：0 命中为过
rg -n "export (async )?(function|const|type|interface|class) (HASH_LEN|stableStringify|diffFingerprints|LogLevel|LockCoreOptions)\b" \
  extensions/universal/cache-probe/src/ extensions/shared/extension-logger/src/ extensions/shared/file-lock/src/

# ③ 入口面双断言：a 恰 1 行（不新增 export 声明）；b 恰 2 行（withFileLockSync 的 import/export）
rg -n "^export" extensions/shared/file-lock/src/index.ts
rg -n "withFileLock|FileLockOptions" extensions/shared/file-lock/src/index.ts
```

V1/V2 是本设计的验收主场景（锁是正确性敏感面）；V5 同时验证「删除确实发生」与「没删错的」（extension-logger 限流/清理用例、llm-shared/bte 消费包测试在三连中覆盖）。

## 7. 实施与下一层拆分

### 7.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 验收 |
|---|---|---|---|
| M1 | file-lock 包全部（E1-E6，含 E5 注释修正）+ 删面连带（E12 悬空引用清扫 + E14 bte 探针改写），单 commit——C-proc-10 要求符号删除与悬空引用同批清算，bte 探针在 E1 后即失效也不允许跨 commit 存在 | 目标 1 + 目标 4 的锁面 | V1、V2、V3、V5（file-lock 部分 + bte/worktree-registry 零残留） |
| M2 | cache-probe（E7-E8）+ extension-logger（E9-E10、E13 size 豁免声明）+ E15 存量注释漂移修正，单 commit（各项互不依赖，均为声明/导出面 doc-right 与 export 关键字级） | 目标 2 + 目标 3 | V4、V5（收敛类部分） |
| M3 | E11 移交登记（本表即移交清单，code-simplify 实现阶段批量执行） | F4 的重复代码面 | 随 code-simplify 批次 |

**版本裁决**：删除/收敛公开导出（E1-E3、E8、E9）对已 npm 发布的包是 breaking change——0.x 约定下公开导出删除以 **minor bump** 承载（file-lock 0.2.1→0.3.0、cache-probe 0.1.3→0.2.0、extension-logger 0.4.1→0.5.0）；纯 doc-right 项（E4/E5/E7/E10/E13/E15）patch 级，随所在包当批 bump 合并（每包单次 bump 取该批内最高变更级别）。**外部消费者证据边界（实读核实，2026-09-11）**：①三包均经 npm 公开发布（`npm view` 实查：file-lock 0.2.1 / cache-probe 0.1.3 / extension-logger 0.4.1，与本地 package.json 一致），「无外部消费者」不能想当然；②仓内实跑 `rg "@zhushanwen/pi-cache-probe"` 零依赖方（仅包自身 package.json 命中）；③cache-probe 的消费形态是 pi 宿主经 package.json `pi.extensions` 加载 default export（extension，非被 import 的库），HASH_LEN 等三个命名导出对外部独立用户无正常可达路径（理论深 import src/fingerprint.ts 物理可能、无证据）——按 minor bump 对待残余不确定性，不以「应该没人用」支撑 patch。file-lock/extension-logger 的仓内消费面全部在本仓 typecheck 兜底范围内（llm-shared/bte/file-lock + 10+ logger 消费包均 import 保留符号，E9 收窄面 LogLevel 实读零消费）。

### 7.2 拆分单元与 justification

| 单元 | 说明 | justification |
|---|---|---|
| u1 = M1 | file-lock 删面 + 测试改造 + 删面连带清扫（E12 包外注释/登记表 + E14 bte 探针） | 锁是唯一正确性敏感面，独立成单元可独立跑 V1/V2 锁竞争验收；源码与测试同 commit 才能保持绿；悬空引用与探针失效面随删面同批是 C-proc-10 强制纪律（跨 commit 会留下「注释指已删符号 / 探针恒真」的中间态） |
| u2 = M2 | 两包声明/导出面 + size 豁免声明 + 存量注释修正 | 纯文案 + export 关键字级，行为零变更，编译器即主验收（V5 收敛类）；与 u1 分离使锁面 review 不被噪音稀释 |
| u3 = M3 | 移交项 | 机械重构不属于本设计裁决面，登记后由 code-simplify 统一批量执行（任务约定） |

### 7.3 文件改动地图

| 文件 | 动作 |
|---|---|
| `extensions/shared/file-lock/src/file-lock.ts` | 删 async 面（约 -65 行）+ 头注释/默认参数注释修正 + :141-142 withFileLockSync JSDoc 去 async 对照段（E1） |
| `extensions/shared/file-lock/src/index.ts` | 导出面收敛至单导出 withFileLockSync（约 -6 行）（E2） |
| `extensions/shared/file-lock/src/lock-core.ts` | 1 个 export 关键字 + :230-231 acquireLock JSDoc 消费方编排描述更新（E3） |
| `extensions/shared/file-lock/package.json` | description 措辞（E4） |
| `extensions/shared/file-lock/src/__tests__/file-lock-backoff.test.ts` | 整文件删除（-130 行）（E6） |
| `extensions/shared/file-lock/src/__tests__/file-lock.test.ts` | 删 async describe + worker 改 sync（约 -60 行）（E6） |
| `extensions/shared/file-lock/src/__tests__/file-lock-external-removal.test.ts` | async 调用改 sync（行数持平）（E6） |
| `packages/runtime/src/utils/file-lock.ts` | 仅 :56-60 注释修正（2 行，零行为）（E5） |
| `packages/runtime/test/file-lock-parity.test.ts` | 仅 :5 头注释主句归因修正（互斥条件归 lockfile 路径 + mkdir 协议，参数一致 = 行为一致锚定；零行为）（E5 第四处同款） |
| `packages/subagent-core/src/execution/worktree-registry.ts` | 仅注释：:40-45 常量注释（含 :42-44「参数漂移破坏互斥」失准句按 E5 口径修正）与 :186-199 withLock JSDoc 改指现存对齐目标、不留被删符号裸提及（V5-① subagent-core 域可判；proper-lockfile 直用实装零改动）（E12①） |
| `docs/architecture/data-source-registry.md` | :110 worktrees.json 行锁协议列更新为 proper-lockfile 直用现状、行号引用改方法名 + :114 system-prompt-trace-baseline 行升格句存量失准修正（先例改单端）（E12②） |
| `extensions/universal/base-tool-enhance/src/__tests__/maintenance-once.test.ts` | mock 工厂去 withFileLock 键 + :122 恒真断言删除 + :8/:34-35 注释改写（withFileLockSync 哨兵保留）（E14） |
| `packages/subagent-core/src/core/logger.ts` | 仅 :16 注释：LogLevel 事实修正（四值含 info、对齐目标去符号级引用）（E15） |
| `extensions/shared/llm-shared/src/__tests__/config.test.ts` | 仅 :24 注释：proper-lockfile/graceful-fs 括注改为自实现 mkdir-lock 实况（E15） |
| `extensions/universal/cache-probe/src/index.ts` | :16-17 声明修正（E7） |
| `extensions/universal/cache-probe/README.md` | seq 段修正（E7） |
| `extensions/universal/cache-probe/src/fingerprint.ts` | 3 个 export 关键字（E8） |
| `extensions/universal/cache-probe/src/__tests__/fingerprint.test.ts` | 测试改经 hashOf/buildProbeEntry/硬编码 16（E8） |
| `extensions/shared/extension-logger/src/index.ts` | LogLevel 去 export + 头注释「三通道」修正（E10）+ **头注释补 fileLog size 豁免声明（E13）** + createLogger JSDoc（E9） |
| `extensions/shared/extension-logger/package.json` | description 措辞（E10） |

### 7.4 待验证检查点与已接受代价

**待验证（诚实标注）**：①`file-lock-external-removal.test.ts` 改 sync 后的断言形态：sync 版 release 在 finally 中不 catch（async 版会吞错留痕），两用例断言的是「fn 结果/错误原样 + 可再锁」，sync 释放路径同样成立——实施时以测试绿确认，若 sync 释放抛错形态导致断言需调整，属测试写法适配而非语义变更；②子进程 worker 改 sync 后的竞争时序与原形态（retries:0 + 外层自旋）等价性——保留外层自旋包裹仅换锁调用，V1 终值断言兜底；③~~E14 依赖的 vitest 行为~~ **✅ 已验证（第 2 轮修订期临时探针实测，vitest 4.1.9 / node v24.11.1，与主审 R1 探针同版本同结论）**：vi.mock 工厂缺被 import 的导出键时，**对导出的任何访问（调用与 typeof 均计）即抛错** `Error: [vitest] No "withFileLockSync" export is defined on the "@zhushanwen/pi-file-lock" mock. Did you forget to return it from "vi.mock"?`；**模块导入本身不抛**（测试文件正常加载，duration 明细 import 阶段零错误）。守卫覆盖面据此限定：E14 声明的「误回流调用」场景必红成立；「import 但不调用」场景 mock 无信号，该面由 `pnpm extensions:typecheck` 的 .d.ts 导出面兜底（非单点依赖）。E14 据此定稿，实施期无需再探。

**已接受代价（四要素）**：
1. **cache-probe「静默漏记」无自动检测**（D2 接受）。量级：仅剩 appendEntry 静默不写一类（异常路径已有 error entry + stderr 兜底），无实证发生过；恢复：无自动恢复，analyze.py 的 baseline/gap 异常可间接暴露，人工排查；重审触发：归因矩阵样本增速异常偏低或 error entries 异常时，补 seq-gap 统计（届时重新裁决）；判定：可接受（探针为 GO/NO-GO 决策服务的临时采集设施，决策后整体退场）。
2. **fileLog 单日文件无 size 上限**（D4 接受）。量级：单文件无上界，但写入方为短命 pi 进程（每 session 一个）、debug 重标 info 档量级有限、7 天保留期自动清理；恢复：保留期清理 + 手动删 `<agentDir>/logs/`；重审触发：pi 进程长命化或观察到单日日志文件 >100MB；判定：可接受（有依据的显式豁免，替代无声明的规范偏离）。

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计候选 9（C9）、M22 与 sharedlibs 单元 low 清单全部 11 项发现（2 项移交 code-simplify）；含 3 条审计修正（cache-probe 物理路径、PiLike 裁决、行号核对无实质漂移）。
- v2（2026-09-11）：审查-修复循环第 1 轮（主审 1 must-fix + 4 suggestion；影响面审 2 must-fix + 1 suggestion + 2 条 INFO 交接），全部当轮修复，逐条对账：
  - **影响面 MF1 / 主审 S-2（悬空引用）→ E12**：删 `withFileLock` 的包外悬空引用补列执行项——worktree-registry.ts 两处注释改指现存对齐目标（实读 ：28 确认已 proper-lockfile 直用）、data-source-registry.md:110 worktrees.json 行更新为直用现状（登记表内容本已滞后，一并清算）；lock-core.ts:231 与 file-lock.ts:141-142 两处包内注释漂移并入 E3/E1；全仓 `rg "\bwithFileLock\b"` 复扫同形注释，runtime 侧本地别名注释（auth-storage/provider-extras/provider-config-helper 等）指向保留符号不悬空、检视后排除（其中 config-service-removebykind.test.ts:136 的「proper-lockfile」括注为 runtime 保留面的存量漂移、非本设计因果，不扩 scope）。§4 失败路径同步声明 typecheck 与 check-doc-symbol-drift.mjs 的守卫边界（实读脚本：映射表未登记本文档与登记表、不扫源码注释——人工清单是唯一防线）。
  - **影响面 MF2（测试 mock 遗留）→ E14 + V5 重写**：maintenance-once.test.ts 的 mock 键/恒真断言/注释三点位列入执行项；V5 原模式照写不可满足（`withFileLock`/`FileLockOptions`/`HASH_LEN` 均为保留符号子串），改为「删除类词边界 + extensions 域」与「收敛类 export 声明」双模式组，设计期实跑记录基线（① 41 行/6 文件、② 恰 5 个 export 声明、③ 入口 4 行），词边界反证通过（withFileLockSync/Async、SyncFileLockOptions、MODEL_KEY_HASH_LEN 零误报）。
  - **主审 MF（D4① 执行项断裂）→ E13**：extension-logger 头注释 size 豁免声明补执行项与文件地图行，D4 采用段三子项逐一标注对应执行项（E13/E10/E5）。
  - **主审 S-1（§4 终态与事实矛盾）→ §4 改写**：包入口仅导出 withFileLockSync；三 parity 常量与 SyncFileLockOptions 留在 src/file-lock.ts 模块导出位、不进入口（parity 测试经相对路径直连源文件，实读 ：47-56 确认）。重演「实施者按 §4 + E2 执行」：入口单导出、零消费导出无新增、parity 测试零改动，矛盾消灭。
  - **主审 S-3（版本裁决）→ §7.1 重写**：公开导出删除属 breaking，0.x 下 minor bump（file-lock 0.3.0 / cache-probe 0.2.0 / extension-logger 0.5.0），doc-right 项 patch 并入同包当批；「无独立外部消费者」降格为带证据边界的实读结论（npm view 三包发布状态实查 + 仓内 cache-probe 零依赖方 rg 实证 + extension 加载形态 default export 论证 + 残余不确定性按 minor 承载）。
  - **主审 S-4（V5 模式不可满足）**：并入影响面 MF2 的 V5 重写（见上）。
  - **INFO×2（存量事实漂移，实读确证后纳入 E15）**：①subagent-core logger.ts:16「三值，无 info」与 extension-logger 实装四值不符（index.ts:157 实读），修正文案同时处理 E9 后对齐目标去符号级引用；②llm-shared config.test.ts:24「proper-lockfile（withFileLockSync 内部）」与实装自实现 mkdir-lock 不符（lock-core.ts 头注释实读），括注按实况改写。两项均与删面无因果，归 M2 doc-right 批带上。
  - 联动同步（五处）：§2 in/out-scope 扩（连带清扫 5 文件）· §3.1 补 bte 探针 mock 句 · §4 失败路径守卫边界 · §5.1 D1 连带句 + parity 行号精确化（:42-58→:47-56）· §5.4 ①③执行项标注 · §5.5 执行项表 E1/E3 扩充 + E12-E15 新增 · §6 V5 重写 · §7.1 M1/M2 与版本段 · §7.2 u1/u2 · §7.3 文件地图（+6 行、3 行更新）· §7.4 待验证补 ③。
- v3（2026-09-12）：审查-修复循环第 2 轮（主审聚焦复审 0 must-fix + 3 suggestion；影响面聚焦复审 1 must-fix + 0 suggestion + 3 INFO 交接），全部当轮修复，逐条对账：
  - **影响面 MF-1（E5 已裁决失准表述的第三处同款未入修正清单）→ E12① 显式涵盖 + 全仓扫描定案第四处**：实读 worktree-registry.ts:40-45 确认 ：42-44「两侧参数漂移会破坏…跨进程互斥语义」是 E5/F4 已裁决失准表述的第三处同款，恰在 E12① 要改写的注释块内——E12① 改写方向补显式涵盖（按 E5 同款裁决修正：互斥由 lockfile 路径 + mkdir 协议保证，默认值对齐的意义 = 夺取时机/失败速度行为一致），并加「改写后不留被删符号裸提及」要求（V5-① subagent-core 域可判）。**反例重演（实施者按 E12①+E5 执行）**：修正后 runtime utils/file-lock.ts:56-60 与 worktree-registry.ts:42-44 两处注释口径一致（互斥归 lockfile 路径 + mkdir 协议、参数一致 = 行为一致锚定），E5 裁决前的仓内矛盾表述形态消灭；若实施者仅按旧 E12① 字面执行（改对齐目标 + 删共存句、不动 :42-44），失准句留存并与 E5 修正后注释矛盾——该路径已被 E12① 显式涵盖堵死。**第四处排查（全仓实跑扫描，模式「参数漂移/互斥语义/破坏互斥」）**：发现第四处同款——runtime parity 测试头注释 ：5 主句「互斥语义依赖两侧默认参数一致」，定性半失准（主句归因失准；括注「stale 决定夺取窗口、retry 决定等待形态」与「lockfile 路径推导一致」条件准确）→ 纳入 E5 同口径修正（runtime 测试注释 1 行，零行为）；其余命中逐一判定无第五处：settings.json 行「互斥只依赖同一 lockfile」、file-lock.test.ts:146「互斥语义（lock-core 层）」等为正确表述，bash/UI/CAS 域「互斥」为不同概念域，归档设计文档 file-lock-unification-and-reaper-sink.md:61 属历史决策记录不作活注释追溯——扫描结论登记于 E5，§2/§3.2/§5.4/§7.3 联动。
  - **主审 S-1（待验证③表述失实）→ §7.4 ③ 升格已验证 + E14 守卫叙事修正**：修订期临时探针复跑（vitest 4.1.9 / node v24.11.1，与主审 R1 探针同版本同结论；跑完即删工作区还原）：vi.mock 工厂缺键时**模块导入不抛**（测试文件正常加载）、**对导出的任何访问（含 typeof）即抛** `Error: [vitest] No "withFileLockSync" export is defined on the "@zhushanwen/pi-file-lock" mock`。§7.4 ③ 由「待验证」升「✅ 已验证」并按实测改写（删原「模块导入即抛错」表述）；E14 守卫叙事改「误回流对已删符号的任何访问（调用与 typeof 均计）即抛错」+ 显式声明「import 但不调用」场景 mock 无信号、该面由 `pnpm extensions:typecheck` 兜底；E14 尾句「实施期以探针验证后定稿」改「据此定稿，实施期无需再探」。
  - **主审 S-2 + 影响面 INFO-2（登记表 :114 升格句行号存量失准）→ E12② 扩充（归属决策）**：实读 data-source-registry.md:114 确认「worktree-registry.ts:162 / rename-session config.ts 双端先例」失准——:162 实读为 mutate/run 内 this.load() 行（锁协议实装在 withLock :198），且 worktree-registry 已 proper-lockfile 直用、不复消费 pi-file-lock，「双端先例」只剩 rename-session 单端。**归属选 E12② 而非 E15**：与 ：110 同文件同源存量漂移，E12② 同批一次清算，避免登记表改动跨 M1/M2 两个 commit 分散；性质显式标注「存量漂移顺带修正、非 C-proc-10 强制场景」（升格句引用的 withFileLockSync 为保留符号，非删面悬空引用）。
  - **主审 S-3（V5-③ 半边缺口）→ ③ 双断言 + 实跑基线**：③ 补两条断言使 §4「入口仅导出 withFileLockSync」正反两半都可判定：`rg -n "^export" …/file-lock/src/index.ts` 当前基线恰 1 行（:21 单 export 块），实施后仍恰 1 行——守「不新增第二个 export 声明」；`rg -n "withFileLock|FileLockOptions" …` 当前基线 8 行（:12-15 import 块 + :22-25 export 块），实施后恰 2 行（withFileLockSync 的 import/export）。**反例重演**：实施者新增独立 `export type { SyncFileLockOptions };` → ^export 2 行红；塞入现有 export 块 → FileLockOptions 裸子串命中 3 行红（裸子串不带词边界系有意——入口域内 FileLockOptions/SyncFileLockOptions 皆应无）。原「withFileLock 4 行」模式被双断言取代。
  - **影响面 INFO-1（V5-① 正则未覆盖 E1 删除清单全部符号）→ 正则补全 + 基线更新**：补 RETRY_MIN_TIMEOUT_MS / RETRY_MAX_TIMEOUT_MS / stringifyErr 三符号（对照 E1 删除清单逐符号核对；实跑 extensions 域 41→46 行，新增命中全在 file-lock.ts 删面内）。**sleep 单列豁免登记、不入正则**（依据实跑）：`\bsleep\b` 在 extensions 域 122 行 15 文件（bte/plugin-bridge/subagent-workflow 等自有同名 helper）实施后不可归零，且 file-lock 包内保留面尚有 2 行概念性注释提及（file-lock.ts:58「同步 sleep」、:144「sleep 用 Atomics.wait」，描述 sync 重试机制、非对已删符号的引用）——词边界机器断言对该符号不成立；兜底链 = E1 删除清单 + typecheck（私有函数删后调用残留即红）+ `pnpm extensions:lint`（`@typescript-eslint/no-unused-vars` error 级、仅 `^_` 前缀豁免——删调用留定义残留即红）+ code-simplify 死代码扫描。豁免登记于 §6 V5 行。
  - **影响面 INFO-3（subagent-core 注释改动无验收链覆盖）→ 拆分裁决并登记理由**：worktree-registry.ts（E12①）**纳入 V5-① 扫描域**（删除类域 = extensions/ + packages/subagent-core/）——实跑其删除符号命中面恰为 E12① 两处改写点（:41/:187，共 2 行），无第三方命中，扩域后 E12① 注释改写有机器可判信号（不留被删符号裸提及）；**不入全 packages/ 域**——runtime auth-storage.ts:65 本地别名声明的 `withFileLock` 是同名词保留面（词边界对同名词不可区分），定向扩 subagent-core 保持零误报。logger.ts:16（E15①）**登记为 doc-right 无自动验收**：改动对象是事实性描述（值域/方法集），LogLevel 属保留符号（E9 仅去 export，V5-② 已在 extension-logger 包内断言其 export 声明消失）且修正文案仍合法提及该类型名，「符号裸提及零命中」类断言对其不适用——由 M2 批人工 review 承载（登记于 E15）。
  - **联动同步（五处）+ 主审 3 条 INFO 顺手修**：§2 in-scope 扩 parity 测试注释行 · §3.2 F4 补四处同款扫描结论 · §5.4 D4③ 四处同款（E5+E12①）· §5.5 E5（第四处+扫描定案）/E12（① 涵盖 ：42-44 + ② 扩 :114）/E14（守卫叙事）/E15（INFO-3 验收归属）· §6 V5 全节重写（① 域+正则+基线 48 行 7 文件：file-lock 包 43 = file-lock.ts 14/index.ts 4/三测试 25 + bte 3 + worktree-registry 2；③ 双断言基线 1 行/8 行；sleep 豁免）· §7.1 M1 验收扩「worktree-registry 零残留」· §6 V3 行同步（runtime 侧「仅注释变更」扩含 parity 头注释）· §7.3 文件地图（新增 parity 行、worktree-registry/data-source-registry 两行更新）· §7.4 ③ 升格。主审 INFO：开篇执行项计数括注消除「14 vs 15 行」推导歧义 · V5-① 基线归因句随域扩展重写（原「全部属 E1/E6/E12/E14」中 E12 两文件不在旧域，现 E12① 两行已入域）· E13 引用设计文档补 `.md` 全称（对齐 lock-core.ts 头注释先例）。
- v4（2026-09-12）：影响面聚焦复审 R2（**0 must-fix** + 1 suggestion），当轮修复，循环收敛：
  - **R2 S-1（sleep 豁免登记恢复路径枚举不全）**：登记漏列实锤在场的机器信号——`pnpm extensions:lint`（`npx eslint extensions/`，根 eslint.config.mjs 继承 taste-lint 配置）的 `@typescript-eslint/no-unused-vars` 为 error 级（taste-lint/base.mjs:69，仅 `^_` 前缀豁免；2026-09-12 复核实证），对「删调用留定义残留」方向即红。sleep 豁免兜底链补全为四层：E1 删除清单 + typecheck（调用残留红）+ **extensions:lint（定义残留红）** + code-simplify 死代码扫描；豁免裁决本身经复审维持不变。联动：§6 V5 行同步。
- v5（2026-09-12）：实施后一致性审查（阶段 3）文档侧修正：①E1 契约段「禁 I/O」文案修正为「仅既定读改写」（原文案与「读文件 + 原子写」持锁范围自相矛盾，实现照抄致 file-lock.ts:33 注释字面矛盾；代码侧落地：extension 侧 commit b6c52f4d4，runtime 侧随阶段 6 修复批次同款修正）；②V1 通过标准第三子句「lock 无残留」改述为如实描述（承载用例 tmp 整体清理，无独立 lock 残留断言，释放语义由 sync describe 用例承载）；③补登记实施期连带：scripts/check-layout-literals.mjs 豁免登记 bundled session-reader 探测证据文案（commit 5cebdd5e7，extensions 重新 bundle 使存量产物字面量首次入扫域，守卫恢复动作 3）。
