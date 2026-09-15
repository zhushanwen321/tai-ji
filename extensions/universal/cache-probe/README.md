# @zhushanwen/pi-cache-probe

前缀稳定性长期数据采集 extension。零行为影响：只在 system prompt / tools 指纹变化时向 session JSONL 写 `cache-probe` custom entry（不进 LLM 上下文），配合 `analyze.py` 把 turn 首笔 cache miss 归因为「前缀变化（可修）」vs「服务端淘汰（不可修）」。

## 组成

- `src/index.ts` — 探针工厂（9 个指纹 hash：7 个输入侧来自 `systemPromptOptions` + `getAllTools()`，`spFull`/`toolsSent` 来自 `before_provider_request` 的最终 payload）
- `src/fingerprint.ts` — 指纹纯函数层（stable stringify / hash / entry 构建）
- `analyze.py` — 归因分析脚本（只读，单数据源扫 session 文件）

## entry schema v2（数据量精简，长期采集友好）

- hash 为 sha256 前 16 hex；**baseline entry** 存全量 9 hash + cwd（约 250B）；**normal entry** 只存变化项增量（约 120B）；无变化 turn 零写入
- `seq` = 进程内 before_agent_start 触发计数，随 entry 落盘供人工排序诊断；当前无自动消费方（analyze.py 不读 seq）

## 挂载方式（长期采集）

dev-link 本地源码（live edit，推荐日常使用）：

```bash
# 见 .agents/skills/dev-link/；或直接用 pi 指定入口
pi --extension <repo>/extensions/universal/cache-probe/index.ts "<prompt>"
pi --continue --extension <repo>/extensions/universal/cache-probe/index.ts "<prompt>"
```

探针经 `--extension` 加载位于 extension 链头（pi 固定顺序），但 spFull/toolsSent 从 `before_provider_request` 的最终请求体提取，是 LLM 实际收到的前缀，不受链位置影响。

## 归因分析

```bash
python3 extensions/universal/cache-probe/analyze.py ~/.pi/agent/sessions ~/.taiji/pi/sessions
```

输出五部分：扫描概览 / 命中率基线 / 归因矩阵 / 进程边界漂移 / GO-NO-GO 决策建议。

## 已知限制（实测查明）

- pi CLI 启动路径（`--session` / `--continue`）的 session_start reason 恒为 `startup`（`resume` 仅运行时 switch session 出现）——跨进程识别靠 baseline 标记 + 时间戳 gap，漂移检测靠 hash 对比，均不受影响。
- 同进程内修改 AGENTS.md 不进 system prompt（pi 启动快照），contextFiles 漂移只出现在跨进程边界——pi 的行为，不是探针缺陷。
- 真实环境实测发现：extension 链（如 subagent-workflow）存在每 turn 级的 system prompt 动态注入，由 spFull 单独捕获——这正是它存在的价值。

## 日常维护

- 校验：`cd extensions/universal/cache-probe && pnpm typecheck && pnpm test`（或仓库级 `pnpm extensions:typecheck && pnpm extensions:test`）
- 每日检查：跑一次 analyze.py，确认 `sessions_with_probe` 增长、`error entries` 为 0 或已知原因
- 归因矩阵内有效 turn（analyze.py 第 3 部分 core 过滤：排除间隔>30min、模型切换、探针未覆盖的 turn）满 200 后，analyze.py 第 5 部分给出快照方案 GO/NO-GO 倾向
