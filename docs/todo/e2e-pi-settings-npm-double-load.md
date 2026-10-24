# e2e 真机链路：宿主全局 settings 的 npm 版 pi-subagent-workflow 同进程双载

状态：根因修正 + 隔离修复已落地，待 S3b 真机复跑确认后关闭（2026-10-25 复核）。**原登记根因（npm 版与 staged 版同进程双载）经 2026-10-25 逐项核实不成立**：真机两条 pi spawn 链恒带 `--no-extensions`（packages/pi-rpc/src/spawn-args.ts:168 主链 + packages/pi-subagent-cli/src/spawn-args.ts:81 孙链，单测锁定），pi 1.0.0 实装下该 flag 结构性屏蔽 settings packages 清单（dist/core/resource-loader.js:403-404——`noExtensions` 时 settings 解析结果不进加载集；探针实证：宿主 agentDir 无 `-ne` 加载 14 扩展含 npm 版，带 `-ne` 加载 0 扩展），且真机 `PI_CODING_AGENT_DIR` 已隔离播种（settings packages 为空）。核实中定位的真实缺口：真机播种不含 discovery.json → runtime 回落「preset 全默认勾选」→ 宿主 `~/.pi/agent/extensions` 经 discovery 源进真机 `--extension` 白名单（S3b 现场 argv 实证：pi-statusline / xyz-agent-bridge 两个宿主扩展进真机进程）。修复已落地：`seedRealCredentials` 增补 discovery 空态播种（v2 schema 三 kind 全空）+ e2e/spawn-isolation-guard.spec.ts 三契约锁定（播种剥 packages/skills 凭据继承 / discovery 空态在盘 / schema 漂移拦截；playwright electron 3 passed）。S3b 失败的真实机制载体待复跑判归：宿主扩展污染已结构性切断，复跑 PASS 即关闭；仍 FAIL 则按新证据重新归因。s1/WRR-A6 同族归因仍为推断级，随复跑一并复核。

## 现象

- **实证（S3b，`batch-s3-partial-failfast`）**：真 LLM e2e（`TAIJI_PI_LIVE=1` 批次）S3b 断言「`subagent_message` 对 fan-out 成员续聊三类拒绝」失败：真机对 origin=workflow 的成员（registered 条目在盘可证）续聊返回 `delivered:true` 并成功 round 2（轮应答通知为证）；而源码 messageHandler、单测（54 用例绿）、staged bundle 三方均有该拒绝。
- **同族疑似（推断级，未核实）**：同批次 s1（`batch-s1-basic-chain`：wf-done 300s 未达、journal 卡 1/2 agent-settled + uiRequestHandler 60s 周期重试抛错，两轮同形态）与 WRR-A6（`batch-window-reuse-recovery`：三轮三个不同失败点，全为成员执行层间歇卡滞）与本问题的同族归因是推断——成员 ask 执行层卡滞与双载污染的关联未经探针核实，仅见于 A11 工作流产物区 runlog；不得作为已证实范围引用，待双载问题修复后复跑归因。

## 根因（已核实）

用户全局 `~/.pi/agent/settings.json` 的 packages 清单含 `npm:@zhushanwen/pi-subagent-workflow`（旧构建，无 workflow-origin 域边界检查）。e2e 的 pi 进程共享宿主 HOME → npm 版扩展与内置 staged 版**同进程双载**，同名 handler 被旧版抢占。与根 AGENTS.md「`-ne` 必带 [HISTORICAL]」登记的 settings 清单双载事故同族（jiti 模块独立但 `Symbol.for` 单例槽跨实例共享）。

## 恢复动作（二选一，待裁决）

1. 用户侧：全局清单移除该 npm 条目（本地开发期由 dev-link/staged 版承载）。
2. 仓库侧：e2e 真机启动链为 pi 进程隔离 settings packages 清单（如 `PI_SETTINGS_*` 覆写或独立 PI_CODING_AGENT_DIR 播种），使真机批次不依赖宿主全局环境。

## 现场与证据

- spec 现场目录：`/var/folders/.../taiji-batch-s3-Us9Jfu`（临时目录，可能已被系统清理）。
- 第三轮重跑记录：`~/.agents/skill-data/dev-flow/<slug>/a11-e2e-runlog.md` 第三轮批次节。
