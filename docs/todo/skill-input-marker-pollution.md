# 纯单词 skill 输入被投递标记污染（既有缺陷，行为与升级前一致，不修）

状态：已知限制显式接受（pi1-disposition-chat-flow 设计 D2⑤，2026-10-04 登记）。

- 现状：skill 与 prompt 模板输入按设计走普通消息链路（注标出站 + message_end 送达回执——这两类输入在 pi 侧展开为正常回合，不返回 handled，注标是送达凭据的成立前提，剥标记则凭据永不到来）。带参数形态（`/skill:xxx args`）展开正常、标记随 args 尾部落 transcript 回执照常命中；纯单词形态（`/skill:xxx` 无参数）的 skillName 解析被尾部投递标记污染——pi 侧 `_expandSkillCommand` 按首个空格分割取 skillName，无空格时整段（含标记）即 skillName → find miss → 展开失败当普通文本开回合。
- 影响面：纯单词 skill 输入不被执行、开 LLM 回合答非所问；与纯单词扩展命令缺陷（★2，本设计已修）同构的既有缺陷——行为与升级前一致（升级前同样注标同样污染），非本设计引入的退化。
- 恢复通道：暂无（不修是刻意的：修法需 pi 侧解析兼容尾部标记，或 taiji 侧为 skill/模板输入另行设计 started 基终局从而免注标，均超出本设计范围）。
- 重审触发：为 skill/模板输入另行设计 started 基终局的立项启动时一并处置（D2 不采用栏④同族）；pi 升级若调整 `_expandSkillCommand` 的分割行为使标记不再污染，登记随之移除。
