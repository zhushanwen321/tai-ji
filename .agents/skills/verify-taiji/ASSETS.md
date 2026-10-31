# ASSETS.md —— verify-taiji 共享验收资产索引

本文件登记**跨波次复用**的验收装配资产：路径、用途、消费方剧本。

与另两层的关系：`capabilities/` 是能力原语（一个动作 + 断言 + 证据），`scenarios/` 是
剧本（能力组合成可执行链），本文件登记的是**剧本的输入装配**——数据、fixture、故障注入
原语，本身不产出 verdict。

**边界**：资产实体落 `~/.agents/skill-data/verify-taiji/assets/`（仓库外技能资产，
不进 git、不进 CI、不登记 `docs/testing/e2e-map.json`，不改动 taiji 仓库）。索引目录内
只登记路径与用途。

## 登记表

| 资产 | 实体路径 | 用途 | 消费方剧本（验收项） | 自检入口 |
|------|----------|------|--------------------|----------|
| V1 旧版本数据构造器 | `~/.agents/skill-data/verify-taiji/assets/v1-legacy-data/` | 构造旧格式三类 run（running / done / failed）+ 存量 scheduler 任务双源（v2 快照分片 + plan B 前会话 JSONL `pi-scheduler:task` 历史条目）+ 会话本体；提供 `legacy-spec.json` 期望值 | A8（S8 迁移旧数据）、A13（S13 scheduler 域收敛） | `node build-legacy-data.mjs --self-check --repo <worktree>` |
| V2 事故副本 fixture | `~/.agents/skill-data/verify-taiji/assets/v2-incident-fixture/` | 91 个 record `.events` + 8.6MB 主会话 + 34 个 run 文件的只读隔离副本，装载到 `~/.taiji-dev/` 下的目标数据目录 | A1（S1 长会话派发）、A10（S10 会话隔离与宿主表面）、u-m1 窗口期 P3 探针 | `node package-incident-fixture.mjs --self-check --repo <worktree>` |
| V3 故障注入 harness | `~/.agents/skill-data/verify-taiji/assets/v3-fault-harness/` | 三类原语：kill 进程 / 断连重连 / 拒绝投递（含丢弃消息注入器 `messageDropper`） | A3（S3 通知丢失仍可取结果）、A4（S4 runtime 崩溃恢复）、A5（S5 引擎崩溃归因）、A6（S6 父 pi 退出与恢复）、A11（S11 父 pi 进程死亡判定） | `node fault-harness.mjs --self-check --repo <worktree>` |

三组资产的详细说明（数据形状、源码位置、装载 API、已知边界）在各目录 `README.md`；
总览与共同约定见 `assets/README.md`。

## 消费约定

- **剧本只 import 资产，不复制资产内容**。V1 的期望值读 `legacy-spec.json`，V2 的计数
  与体量读 `manifest.json`，不要在剧本里重抄数字。
- **只读原件**。V1 只写 `--out` 指定目录；V2 只读生产目录取样（源指纹进 manifest 并在
  自检里两次对账）；V3 只操作自己拉起的实例。
- **不依赖新实现**。三组自检只依赖基线 worktree 与既有装配（`scripts/lib/instance.mjs`），
  u-m0 / u-m1 交付前后都可跑。
- **资产失效处置**：自检失败即资产不可用——按输出的 `failures` 与「已搜路径」修复
  （重新打包、更新基线路径、补数据源），不得跳过自检直接用在剧本里。

## 维护

- 基线实现变更触达数据形状（run 事件词表 / scheduler 快照 schema / 会话条目形态）时，
  先跑三组自检：变红即资产与新基线脱节，更新构造器/打包器后再跑。
- V2 依赖本机生产数据目录里的那次事故会话。该会话被清理后，按打包器报出的「已搜路径」
  核对；确无数据源时登记为不可用，不造数据替代。
