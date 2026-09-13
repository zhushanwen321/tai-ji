# 架构完整性加固：原则与决策索引

> **一句话结论**：2026-08-20 六维架构审查发现的 10 个 major 的病根是两条元模式——「跨进程共享文件无锁双写」与「护栏只存在于注释/文档/本地 pre-commit」。修复把 data-source-governance 的治理结构推广到这两个盲区：跨进程文件写收敛为「同一把锁 + 字段域 merge + 损坏隔离」协议，进程死亡收敛为「检测即销毁 + 孤儿收殓」自愈闭环，安全与打包不变量从纪律升级为「运行时守卫 + CI 机器检查」双层护栏。
>
> **状态（2026-09-13 压缩）**：10 个 major（M1–M10）已全部实施完成（W0–W5 六波 + 真机验收，S1–S6/S10 PASS、S7/S8 单测覆盖、S9 随 CI 验证；执行记录 git 可追溯）。十个 major 的问题诊断、方案对比、验收场景与执行记录已删除。本文件保留**三原则**（长期准绳）与**决策索引**（代码注释引用 §/D/M 编号的溯源锚点）。
>
> **与 data-source-governance 的关系**：续篇。前篇治理「GUI 数据多源」（绝对写规则）；本篇把同一条规则的精神推广到 session JSONL 之外的跨进程共享文件，并补上进程生命周期收敛、Electron 安全不变量两个维度。锁协议的现行权威登记 = [data-source-registry.md §6](data-source-registry.md)（跨进程共享文件登记表）。

---

## 1. 关键术语（全文与代码注释通用）

- **跨进程共享文件**：≥2 个进程都会写的磁盘文件。凡登记为「跨进程共享」的文件，全部写入方必须使用**同一把锁**（同一 lockfile 路径），锁内读-改-写且只写调用方声明的字段域；无锁的第二写入者 = 契约违规。登记表 = registry §6。范本：`auth.json`（xyz 与 pi 共用同一把 proper-lockfile 锁）。
- **字段域 merge**：锁内读最新文件 → 只修改调用方声明负责的字段域（如 model 域只动 defaultModel 族字段）→ 写回。与「全量覆盖」相对——全量覆盖会把锁内读到的其他进程旧值一并写回，丢掉并发方的修改。
- **损坏隔离（quarantine）**：JSON 读取 parse 失败时，把损坏文件 rename 为 `<path>.corrupt-<ts>` 保留取证、以默认值继续，并落 error 级日志带恢复指引。与「静默回退默认值」相对——后者会让下一次写把「半截文件」合法化为「全空文件」。
- **收殓（reap）**：新 runtime 启动时扫描并清理不属于自己 的残留 pi 进程。孤儿判据（终态）= argv 判据（`--mode rpc` + `--session-dir` 值精确等于本实例 sessions 目录）+ `ppid===1`（reparent 证据）。设计期原 env 判据被探针否决（macOS SIP 拿不到他进程 env）。
- **对账（reconcile）**：注册表与物理事实（git 分支、tmpdir 目录）双向 diff，清理注册表缺失但物理存在的孤儿资源。与「只信注册表」相对。
- **机制化护栏**：不变量由机器强制（运行时守卫代码 / CI 检查 / 单元级断言），违规在编码期或 CI 期被拦截。与「纪律护栏」（注释、文档、review checklist）相对——注释与文档只解释「为什么」，不承担「保证」职能。

## 2. 终态三原则（与前篇五原则同级，是本领域的「绝对写规则」）

1. **锁协议唯一**：凡登记为「跨进程共享」的文件，全部写入方必须使用**同一把锁**（同一 lockfile 路径与参数语义）；锁内读-改-写，且只写调用方声明的字段域。无锁的第二写入者 = 契约违规，CI/审查拦截。
2. **检测即收敛**：凡「判定进程死亡/不可用」的路径，必须走完与已知死亡路径（onSessionExit）同构的收敛（销毁进程 + 广播 + 清理 + 可自动恢复）；「只收口不销毁」的半途处置不允许存在。孤儿由独立的收殓机制兜底，不依赖对端自觉退出。
3. **护栏机制化**：安全/打包/写协议不变量必须有运行时守卫或 CI 机器检查兜底；注释与文档只解释「为什么」，不再承担「保证」职能。

## 3. 决策索引（§/D/M 编号溯源锚点）

代码注释以「§3.x D Ny」「M N」形态引用本设计的决策；各决策的问题诊断、方案对比与实施细节已删（git 可追溯），此处保留编号 → 一句话 → 现行落点的映射。

| 章节 | 决策 | 一句话 | 现行落点 |
|---|---|---|---|
| §3.1 | D1a 锁协议 | settings.json 双写收敛为同一把锁：`lockSync(realpath:false, stale:30_000)` + 自实现 busy-wait（25ms/预算 1s，fail-fast）；pi 侧 20ms×10 无 stale——不对称安全性论证：互斥只依赖同一 lockfile + 双方先取锁再写，xyz 的 stale 夺取让双方自愈 | `pi-settings-store.ts` + registry §6 settings.json 行 |
| §3.1 | D1b 字段域 merge | `updateSettingsFields(scope, mutator)`——只覆盖 scope 声明的顶层 key；scope = model/skills/extension/full（full 白名单仅启动迁移） | `pi-settings-store.ts` |
| §3.1 | D1c 损坏隔离 | parse 失败 rename `.corrupt-<ts>` + error 日志带恢复指引 + 默认值继续 | `utils/json-store.ts`（segments.json 等同模式） |
| §3.1 | D1d 触发器消除 | 删除 switchModel 的 setDefaultModel 冗余双写（pi setModel 已持久化） | `model-service.ts` |
| §3.1 | D1e ext-config 家族 | 扩展配置双写文件统一纳入锁协议登记 | registry §6 rename-session-ext-config 行 |
| §3.2 | D2a cwd 守卫 | local-file 白名单提纯函数 `computeLocalFilePrefixes`——打包态剔除 `process.cwd()`（语义失效）；单测断言不含根/homedir | `apps/electron/main/utils/local-file-prefixes.ts` |
| §3.2 | D2b 导航拦截 | will-navigate + setWindowOpenHandler（默认 deny，外链转系统浏览器） | `window-factory.ts` / `browser-view-manager.ts` |
| §3.2 | D2c CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: local-file:; font-src 'self' data:; connect-src 'self' ws://localhost:*`——dev/prod 双态实测零违规定稿 | `packages/renderer/index.html` + `check_csp_compatibility.py` |
| §3.2 | D2d 单实例锁 | requestSingleInstanceLock，失败 quit + second-instance 聚焦既有窗口 | `main.ts` |
| §3.3 | D3a/D3b 半死自愈 | ping 判死后强杀（SIGCONT→SIGTERM→SIGKILL）+ 强杀分支内手动编排收敛（与 onSessionExit 链构成两份副本，须同步维护——kill 路径 exit 事件被 `_killing` 标志与 Map 先删双层拦截）；已知边界：全新 session 首 turn 冻结时文件未 flush，重发 SESSION_NOT_FOUND 需新建 | `message-dispatcher.ts` / `rpc-client.ts`（RpcTimeoutError）/ `process-manager.ts` |
| §3.4 | D4a/D4b 孤儿收殓 | 启动后台收殓步：argv 三重判据（--session-dir 精确等值 + ppid===1 + --mode rpc）缺一不可，SIGTERM→2s→SIGKILL，幂等失败仅日志 | `services/reap-orphan-pi.ts`（头注释含判据与探针结论） |
| §3.5 | D5a/D5b/D5c worktree | 注册表锁（proper-lockfile）+ reaper 对账兜底（`reconcileWithPhysical` 双向 diff 自愈）；注释声称的运行时行为必须有代码对应 | `worktree-registry.ts` / `worktree-manager.ts` |
| §3.6 | D6a/D6b 幽灵弹窗 | 清理挂 onSessionDestroyed 汇聚点（覆盖删除/退出/restore 清场）+ renderer session.exited 清 extensionUIStore 分区 | `session-service.ts` / renderer effects |
| §3.7 | D7 现场治理 | chat-app 孤岛删除；文档导航 supersede 纪律 | 已执行（历史） |
| §3.8 | D8a–D8d 护栏机制化 | 跨进程文件登记表（registry §6）+ CI invariants job + 定点守护测试；新文件入表 = review checklist 项 | `.github/workflows/ci.yml` · registry §6 |

**major 对照**：M1→D1，M2/M3/M4→D2，M5→D3，M6→D4，M7→D5，M8→D6，M9/M10→D7，元模式②横向→D8。

## 4. 变更历史

- v1–v3（2026-08-20）：初稿 + 两轮对抗式审查修复（R1/R2 审查轨迹 `.review.md` / `.review.r2.md`，git 可追溯）。
- v4（2026-08-20）：W0–W5 六波实施落地 + 实施一致性审查 19 项 finding 全修；探针修正三处回写（收殓判据 env→argv+ppid=1、CSP 双态定稿、强杀收敛手动编排）。
- v5（2026-09-13）：压缩为原则 + 决策索引（本版）。
