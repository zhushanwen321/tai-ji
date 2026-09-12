# @zhushanwen/pi-rpc

pi 进程 RPC 公共层——主 agent（runtime rpc-client）与 subagent（pi-subagent-cli）两套 pi RPC 客户端的同型实现收敛（设计 `docs/design/subagent-permanent-session-model.md` §3.3.2，G5）。

消费者：

- `@xyz-agent/runtime`（主 agent rpc-client 薄壳）
- `@zhushanwen/pi-subagent-cli`（stdin-writer / spawn-args 归并）
- **zcode 不经过此层**（app-server 是另一协议，仅语义层对齐）

## 五模块

| 模块 | 内容 | 提取来源 |
|---|---|---|
| `spawn-args` | pi argv 构造器：`buildPiMainAgentArgs`（主 agent 模板）/ `buildPiSubagentSpawnArgs`（subagent 模板）+ 共享分段原语（skill/extension/tools/mirror）。参数化差异点：session 定位 none/dir+file、thinking 传递 flag/模型后缀、mirror 规则 | runtime `buildPiArgs` ∪ pi-subagent-cli `buildSpawnArgs` |
| `frame` | `attachLfOnlyLineReader`（LF-only 行分帧，U+2028/U+2029 不拆帧）+ `createPendingRegistry`（pending 表 + 超时分级 FAST/CMD/SLOW + 迟到响应丢弃）+ `createEarlyFrameBuffer`（早期帧缓冲）+ `tryWriteStdinLine`/`isBrokenPipeError`（裸写原语） | runtime rpc-client :46-74 / sendCommand；pi-subagent-cli stdin-writer |
| `commands` | prompt（含 streamingBehavior 语义）/ steer / followUp / abort / get_state / switch_session / extension_ui_response 帧组装（params 形态 + 完整帧形态两层） | runtime rpc-client 高层 API；pi-subagent-cli stdin-writer |
| `kill-chain` | `killPiProcess`：SIGCONT → SIGTERM → grace → SIGKILL 阶梯（grace 可参，缺省 2s） | runtime RpcClient.kill() |
| `env` | `buildPiOutboundEnv`：extras 过滤 + `XYZ_AGENT_EXT_LOG` 恒注入 + `PI_CODING_AGENT_DIR` 隔离；底层白名单构建器经 DI 注入 | runtime rpc-client buildPiOutboundEnv |

## 刻意不统一的清单（防「顺手统一」）

以下差异是**真差异**（消费方不同 / 迁移契约），不是遗漏，禁止单侧「补齐」到另一侧：

1. **busy 判定位置**（设计 K8）：主 agent 前置预检（GUI 要用户可见反馈 + renderer defer 队列）vs subagent 后置交 pi 裁决（agent 驱动不阻塞）。本包不提供预检，只提供 `classifyPromptRejection` 同精神的共享判读词汇（`StreamingBehavior`）。
2. **投递策略**：排队/重试归 `@xyz-agent/session-delivery`，按消费方注入（GUI 不排队直拒、subagent 排队续投）——本包不含投递内核。
3. **裸写错误策略**：runtime `sendRaw` 吞错（UI 响应 fire-and-forget，无恢复路径）vs pi-subagent-cli `writeStdinLine` 对 EPIPE throw（驱动冷恢复路径）。本包只提供 `tryWriteStdinLine` 原语 + `isBrokenPipeError` 判别单源，策略归消费方。
4. **argv 编排顺序**：主 agent 与 subagent 模板的 flag 顺序不同（`buildPiMainAgentArgs` 的 skill/extension 在 tools 段前、基座 flag 前置；`buildPiSubagentSpawnArgs` 的 skill 在 tools 段后、mirror 段末尾）。pi 的 commander 解析对顺序无语义；保留两模板现状是「行为等价提取」迁移契约（快照测试锚定两侧输出与切换前逐字节一致），不是待清理债。
5. **stdout 行分帧双源现状**：runtime 侧用本包 `attachLfOnlyLineReader`（StringDecoder + 剥 `\r` + 尾行 flush）；pi-subagent-cli 的 stdout pump 用 `@zhushanwen/subagent-engine-sdk` `pumpNdjsonLines`（与 zcode connection 共享的引擎中立单源，S4 簇 5b 已收敛）。两者正常路径行为一致（pi 输出恒 `\n` 定界），不强行合并——合并会让 zcode 间接依赖本包，违反「zcode 不经过此层」。
6. **杀链双源现状**：本包 `killPiProcess`（SIGCONT 前置，pi 主链路）与 SDK `killChain`（SIGTERM 起，pi-subagent-cli spawn-runner 与 zcode 共用的引擎中立面）并存。SIGCONT 阶梯是 runtime 主链路对「SIGSTOP 冻结进程」的防御；引擎中立层语义不同，完整收敛超出本包单元。
7. **`buildOutboundChildEnv` 底层双 SSOT**：`@xyz-agent/shared`（runtime 消费）与 SDK（引擎 CLI 独立 npm 发布需自包含）各一份，本包不复刻第三份——经 `buildChildEnv` 参数注入。

## 单侧消费的命令（防误认为双侧契约）

- **`switch_session`**：仅主 agent（runtime）消费——subagent 侧续聊走 spawn 时 `--session` 直续（`buildPiSubagentSpawnArgs`），不运行时切换目标文件。
- **`abort` / `steer` / `followUp`**：当前仅主 agent 消费（subagent 的 busy 投递统一走 `prompt` + `streamingBehavior`）。
- **`prompt` + `streamingBehavior`**：双侧消费（subagent chat 续聊热路径 = V2 决策 3）。

## 测试

```bash
cd packages/pi-rpc && pnpm vitest run
```

快照等价锚定：`src/__tests__/spawn-args.test.ts` 的「快照等价」用例锚定两侧典型参数集的 argv 与切换前实现逐字节一致。
