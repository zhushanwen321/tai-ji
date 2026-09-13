# 伴生写入面治理（zcode 引擎宿主 HOME 伴生面，磁盘残留）

> **状态**：待排期（有期限的已接受债务——设计判定「本设计不治理，但登记为已接受代价」，
> 两者并存的前提是本文档的 owner/期限/上界三者齐全）
> **创建日期**：2026-09-09（会话库隔离 W4 交付，跟踪落点见
> [zcode-session-db-isolation.md](../architecture/zcode-session-db-isolation.md) §2.4.1 与
> impl-plan §2.4①（zcode-session-db-isolation.impl-plan.md，已删除，git 可追溯））
> **owner**：zhushanwen
> **期限**：2026-10-01（设计口径 = G1 止血合入后 30 天内）
> **逾期处置**：逾期未排期即**升为阻塞项**；检查主体 = 下一次触碰该面的设计/PR 评审
> **范围边界**：只治理 `~/.zcode/cli/` 下伴生写入面的**磁盘残留**（与 GUI 侧边栏无关——
> 侧边栏污染已由会话库隔离根治）；不修改 zcode CLI / GUI 源码

## 1. 债务内容（面清单）

隔离只解决「会话行进 GUI 侧边栏」，`~/.zcode/cli/` 下伴生写入面照旧单调累积。快照时点
2026-09-08（量级与判据的权威登记在设计 §2.4.1 表，此处列治理视角摘要）：

| 写入面 | 路径 | 累计存量（2026-09-08 快照） | 现成清理通道 |
|--------|------|---------------------------|-------------|
| **agents** | `~/.zcode/cli/agents` | **68G**（单目录 ≥1.2G 有 8 个、>2G 有 3 个，最大 4.0G）——**最高风险** | 未见（需 zsw `doctor clean` 部分覆盖或人工） |
| artifacts | `~/.zcode/cli/artifacts` | 925M | 未见 |
| log | `~/.zcode/cli/log` | 538M | 引擎自带 `scheduleLogRetentionCleanup`，但为**每进程一次性** `setTimeout`（默认 60s、`unref`）、只匹配 `^zcode-YYYY-MM-DD\.jsonl$`、retention 默认 7 天——**非周期性策略**，通道边界见设计 §2.4.1 |
| debug | `~/.zcode/cli/debug` | 293M | 未见 |
| exec | `~/.zcode/cli/exec` | 117M | zsw doctor clean「空壳 7 天」（仅 zsw 口径） |
| 图片/PDF/视频缓存 | `~/.zcode/cli/{image,pdf,video}-cache` | 未单列 | 未见 |
| rollout | `~/.zcode/cli/rollout` | 快照窗口 +1（15M） | 未见 |
| 会话库（宿主） | `~/.zcode/cli/db/db.sqlite` | 2.8G | **另有通道**：存量行清理走隔离设计的 W5 工具（D7，需停机窗口与授权），不在本文档范围 |

恢复路径现状：`agents` / `artifacts` 无现成通道，需 zsw `doctor clean`（其识别集只覆盖部分）或人工。

## 2. 上界（重审触发条件，任一命中即启动治理排期）

- `agents` 累计 > **100G**；或
- 系统盘可用 < **100G**；或
- `agents` 周增速 > **10G**。

原阈值（任一目录 > 2GB）在成文时已触发（agents 68G / 会话库 2.8G），故该面无剩余触发点，
改为上述新上界。**余量基准**：2026-09-08 实测系统盘可用 436G，距 100G 上界余量 336G；
按周增速 10G 估约 33 周。

## 3. 复测命令

```bash
# 累计存量（随时可复测，对照 §1 表与上界）
du -sh ~/.zcode/cli/*

# 系统盘可用空间（对照上界 < 100G）
df -h /

# 周增速采样（隔周对比 agents 目录总量）
du -sh ~/.zcode/cli/agents
```

## 4. 明确不做的事

- **不设 `ZCODE_STORAGE_DIR` 一把隔离**：该 env 会连带移动 `cli/config.json`（引擎配置路径
  派生自 `storage.dir`），使 `appserver-launcher` 的 fs 拦截路径失效、凭据注入整体不可用
  （设计 §2.4.1「为什么不顺手隔离」条）。
- 不在本仓修改 zcode CLI / GUI 行为（用户约束）；治理动作只能是我们侧的清理编排或向
  zcode 上游反馈通道需求。
