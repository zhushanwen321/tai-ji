# 非 checked 通路命令首败即停：send_to_session 失败频率上升显式接受

状态：已裁决推广至全部条目（2026-10-05 用户裁决：内核 backoff 自动重试退役，首败即停成为统一语义——见 delivery-backoff-retry-retirement.md；实施后本登记记录的「行为差异」消失，状态随实施改写为已合并）。

- 现状：命令条目不注标出站（D2②）后，「发送失败 = 可能已执行」——失败重投会重复执行命令，自动重试买不到安全性。修法已实装：命令条目在全部通路首败即停、不进内核 backoff 自动重试链（`packages/session-delivery/src/delivery.ts:736-746`，onSendFail 见命令条目按 checked 同形态移除、无 ghost 重试）。非 checked 提交点共三族：① 插件 session API 发消息（session-manager 的 send_to_session 工具与 create 初始 prompt 经此，clientUuid 恒缺）；② 续跑投递；③ 无标记外来文本收养（subagent notifyDone / scheduler 提醒等）——②③族提交内容常态为提示文本/通知（非命令），机制统一覆盖无例外豁免。
- 影响面：①族行为差异——此前瞬时失败被 backoff 链消化（数秒后成功或至 failed），修后一次失败即向调用方上抛，send_to_session 的调用方（agent）见到失败的频率上升。显式接受：重发裁决权交给知道命令语义的调用方，agent 收到失败回执后自行决定重发。
- 恢复通道：调用方收到失败回执后自行决定重发；瞬态失败的重试由调用方侧约定承担，内核不回退首败即停的安全语义。
- 重审触发：agent 链式任务因 send_to_session 瞬时失败出现实际中断困扰时，重审调用方侧重试约定（首败即停语义不随重审回退）。
