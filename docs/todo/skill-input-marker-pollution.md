# 纯单词 skill 输入被投递标记污染（已实施：统一切 started 基终局，污染源消失）

状态：已实施（2026-10-05 用户裁决立项：手打形态切 started 基终局；与 command-pi-restart-response-loss 的终局事件化同批落地）。

- 原缺陷：skill 与 prompt 模板输入按设计走普通消息链路（注标出站 + message_end 送达回执——这两类输入在 pi 侧展开为正常回合，不返回 handled，注标是送达凭据的成立前提，剥标记则凭据永不到来）。带参数形态（`/skill:xxx args`）展开正常、标记随 args 尾部落 transcript 回执照常命中；纯单词形态（`/skill:xxx` 无参数）的 skillName 解析被尾部投递标记污染——pi 侧 `_expandSkillCommand` 按首个空格分割取 skillName，无空格时整段（含标记）即 skillName → find miss → 展开失败当普通文本开回合。
- 实施形态（用户第一原则「技能使用是 agent 内部决定的事，受理即完成意图传递」覆盖全部技能通路）：识别集扩展至 source=skill/prompt 清单条目与 `<taiji-skill>` 芯片标记文本（registry isUnmarkedEntry + infra/pi extractSkillTemplateCommandNames）——手打形态与芯片通路都不注标出站（内核组批隔离标志统一为 unmarked）、pi 受理回执（prompt 响应 disposition，含 started/queued/handled）即终局，复用命令条目的空窗豁免（submit 回执 isCommand 标志）与断连未确认终局；污染源消失（无标记可被吞）。落盘凭据取舍：技能输入的展开文本本就落盘（注入后出站），断线重连后 transcript 有痕可对，不依赖标记。
