# dev 实例 runtime 慢启动被 35s 健康检查误杀

状态：待裁决（2026-10-22 排障发现）

## 现象

`dev-instance.mjs` 启动时 main 的 runtime 健康检查（`waitForHealth`）超时上限约 35s；本机高负载下（多个 worktree 实例并存、其中一 runtime 进程空转占 CPU）runtime 的 tsx 两段式启动（tsx CLI 壳进程 + preflight/loader 子进程，`pgrep -f` 可见两进程，真身在子进程）实测可耗时 60-90s，超时后被 main SIGTERM 清理（exit 143），renderer 落「runtime 不可用，重试多次仍失败」兜底页，整应用不可用。复测三次连续误杀，第四次（负载下降后）约 90s 完成启动。

## 排除项（已核实不是原因）

- 端口冲突 / 端口偏移双叠加（runtime 侧不消费 `TAIJI_AGENT_PORT_OFFSET`）
- `buildSafeEnv` 白名单过滤（最小 env 复现 271ms 就绪）
- 数据目录双重实例检查（手动复现命中的是该检查对裸跑缺省 `~/.taiji-dev` 的正确拒绝，与 dev 实例注入路径无关）
- `NODE_OPTIONS` 等外层 env 注入（为空）

## 待裁决方向

按「超时量级按被保护对象粒度校准」（AGENTS.md 超时默认原则）：runtime 整进程启动属任务级（正常可分钟级，尤其 tsx 冷编译 + 高负载），35s 是控制范围错配（秒级单请求预算挪用到任务级）。候选修法：① health check 改「无进展检测」（进程活着即等，超时上限提至分钟级或改为 idle 检测）；② 装配器把 runtime 就绪等待与 renderer 兜底页解耦（兜底页提供「仍在启动」态而非失败态）；③ dev 链条前置 runtime 预热。

## 复现与定位证据

- 误杀日志：装配器 stdout `[runtime] waitForHealth failed on port N, cleaning up half-alive child` + `[runtime] Process exited with code 143`
- 慢启动证据：`sample <pid>` 显示壳进程事件循环空转（等 tsx loader 子进程），`runtime-instance.json` 与 `lsof -i :<port>` 显示子进程最终监听成功
