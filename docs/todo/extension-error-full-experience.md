# extension_error 完整失败体验独立立项（现役仅命令来源最小通路）

状态：独立立项待设计（pi1-disposition-chat-flow 设计 D14④ + D10③ / §1.3 Out of scope，2026-10-04 登记）。

- 现状：pi 的 extension_error 是扩展系统的全局错误回调，来源不限命令失败——载荷 `errorEvent` 字段标记来源（命令 handler 抛错恒为 `command`；事件 handler 抛错为触发事件名；生命周期错误为 `register_provider` 等固定标记）。已落地的只有「命令失败可见性」最小通路：仅 `errorEvent === 'command'` 的错误进 toast（同 key 去重 + 60s 限频防刷屏，`EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS`，`packages/core/src/domain/chat/useChat.ts:197`），其余来源保持现状静默；数据面不丢——runtime 日志与 extension.error WS 消息逐条完整留痕。
- 影响面：非命令来源的扩展错误（事件 handler 抛错、生命周期错误）对用户不可见——排障靠日志，界面零提示；完整失败体验（对话流提示行形态、重试引导、非命令来源的放行范围裁决）未设计。
- 恢复通道：完整失败体验独立立项设计（展示形态 + 非命令来源放行范围一并裁决）；立项前维持最小通路。
- 重审触发：非命令来源扩展错误出现实际用户困扰（如静默失败致功能不可用且无从判断）时立项；命令循环重试形态被上游治理时同步复核限频参数。
