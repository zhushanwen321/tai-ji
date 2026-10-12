# B2 D3 A7 real 轨三组失败登记（归因完成，非 B2 引入，待人工复核）

- 状态：条目 1 已修（2026-10-12，见下）、条目 4 已修且 real 轨实跑确认绿（2026-10-12，本条关闭）；未解决项余两条（非 B2 引入的既有/环境失败，登记待人工定责复跑）
- 发现时点：2026-10-07 B2 subagent-stream-chunk D3 验收 A7（G3 real 轨）
- B2 无交集佐证（确定性）：`git diff 4bc83d6d6..HEAD` 不含 ask-user 扩展 / event-adapter / btw 链路 / verify-plugin-contract.sh / find-pi-executable / process-manager 任何文件；同窗口 B2 触及的等价性轨（EQUIV-01 76 用例、EQUIV-05）与行为轨（mock 58 用例）全绿。

## 1. ask-user-real A1/A2/A3（3 failed，两次复跑稳定复现）——已修（2026-10-12），待真机复跑确认

- 根因：e2e spec 等待谓词未跟随 pi1-adapt U4（de900a937，2026-10-04）的对话框族 WS 帧类型改名 `extension.ui_request` → `extension.dialog`（EXTENSION_EVENTS.DIALOG，core bridge / renderer 消费端 U4 同批迁移，e2e 目录不在该 commit 触及面）。pi 侧事件形态与 runtime 适配器 marker 路由均无缺陷：diag piLogsTail 实录 pi 已发 `extension_ui_request{method:select, title:UI_FORM_MARKER}`，runtime marker 单测锚定广播 `extension.dialog` + `form:true`（askUser/askUserQuestions 键经 legacy 归一不出帧）；第二断点 = 现行 form 帧 payload 用 `dialogKind:'select'`（无 `method` 键），e2e 的 `payload.method` 断言在谓词修复后会成为下一个失败点
- 修复：`e2e/ask-user-real.spec.ts` 谓词改等 `extension.dialog` + `payload.form === true`（删除归一后不可达的 askUser 双读死分支），`payload.method` 断言改 `payload.dialogKind`，协议事实注释同步现行帧形态；`event-adapter-ui-form-marker.test.ts` 文件头注释帧类型更正。回写帧 `extension.ui_response` 未改名（payload.method 仍为客户端回写协议字段），回写通道零改动
- 验证：runtime marker/dialog-kind 单测 51 绿 + core message-bus-bridge/domains 单测 125 绿 + playwright spec 加载编译通过；真机复跑 A1/A2/A3 待主会话统一安排

## 2. btw S7（两次失败、两次失败模式不同）

- 第一轮：主 turn 90s 未 complete，seen types 含 thinking + 多次 tool_call——LLM 在推进但慢（e2e 准则的「推进中非死锁」形态）
- 第二轮：主 turn 早于第 3 轮 btw 完成，窗口重叠断言失败（MAIN_TURN_SLEEP_S=40 未被模型执行满）
- 归因：真实 LLM 行为方差（时长不达标两个方向），主 turn/btw/steer 机制不在 B2 改动面

## 3. PLUGINCONTRACT-01（CT-D1-T1 session.create 失败）

- 症状：契约脚本环境 spawn 的 pi = `~/.nvm/.../bin/pi`（用户全局 npm 版），不识别 `builtin:codemode`/`builtin:mcp`（taiji staged 内置扩展协议）→ pi exit 1 → session.create 报错
- 归因：harness 的 pi 解析落到 PATH 全局版（环境敏感），解析链与脚本均不在 B2 改动面
- 处置建议：契约脚本起 runtime 时应显式注入仓库 resources/pi 解析优先（或清理 PATH 全局 pi 干扰）；mock 残留已排除（无 marker / 无 .bak / 无回执，三证核过）

## 4. TERMINAL-01 T13 跨会话不误清——已修且 real 轨实跑确认绿（2026-10-12）

- 症状：terminal-instance-item 期望 1 实得 0（登记原表述「切回 A 后 A 条目丢失」；实测失败点在切 B 后的 B 期条目断言，尚未走到切回）
- 定责实验（决定性）：在 B2 基线 commit 4bc83d6d6 的分离 worktree（real bundle）复跑 T13 **同样失败**——失败先于 B2 全部改动存在；HEAD 与 4bc83d6d6 均 2/2 稳定复现（非时序抖动）
- 根因（e2e harness 与会话激活的竞态，产品侧无缺陷、零改动）：底抽屉开合态是 per-session 分区（`packages/core/src/domain/bottom-drawer/control.ts`，新会话默认关；core 单测 control.test.ts「A 开底抽屉、切 B 默认关、切回 A 仍开」显式钉住该语义，右抽屉同款）。`selectSession`（core use-session）经步 2 switchSession RPC 往返后才在 runEntryChain 步 7 syncSessionToPanel 翻转分区键（实测点击后 ~59ms）；原 harness `selectSessionInSidebar` 只等 composer-box 可见（点击前就已可见，即时通过），`openTerminalDrawer` 的 aria-pressed 检查恒落在翻转前、读到旧会话（A）分区的「开」→ 误判无需开；随后 B 的关分区接管 → 抽屉收起、TerminalView 卸载 → 条目断言全落空。诊断实测（50ms 采样时间线）：点击后 59ms 头部会话标签与 aria-pressed 同 tick 翻转、286ms 条目消失（视图卸载）、397ms 抽屉关毕；B 期 30s 窗口内 runtime PTY 与实例注册表全程无损（runtime 日志无 exit/destroySessionPties、无 B spawn；renderer 无 terminal.list 失败告警）——「A 条目丢失」实为终端面板未挂载，非条目被清，登记原表述的归因不成立
- 修复（仅 `e2e/terminal-multi-instance.spec.ts`）：`selectSessionInSidebar` 追加等 panel 卡头会话标签（`panel-session-label`，与底抽屉分区键同 tick 翻转、同派生自 leaf.sessionId）落到目标会话后再返回；T13 断言零改动——B 期重开抽屉走挂载激活轮对账（空清单自动新建 B 默认实例），切回 A 抽屉经 A 的开分区自动恢复、重挂载对账还原 A 的两条条目与历史输出，被保护的「跨会话不误清」不变量照常受验
- 验证（2026-10-12）：real bundle 空载串行实跑——terminal-multi-instance 全 spec（T1/T2/T4/T8/T9/T10/T13）7 passed，T13 单独复跑 2/2 绿；runtime terminal-message-handler + terminal-service 套件 64 绿、renderer use-terminal 套件 107 绿。环境备注：验证跑带 `DISABLE_AUTO_UPDATE=true` 抑制 oh-my-zsh 升级提示吃键入字符的噪音（该提示当日到期触发，曾使诊断跑在 A 期输出断言处假失败）
