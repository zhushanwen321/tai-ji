/**
 * composer 带（band）壳层类链单一来源 —— Panel.vue（主 panel / trace）与 BtwPanel.vue
 * （旁路提问）共用同一外壳，保证两个表面里 composer 与对话流的几何关系一致
 * （demo 权威：specs/drawers.md「real BTW = MessageStream + Composer variant=panel 同构」，
 * .btw-composer 亦是带外距浮框而非贴边满宽）。
 *
 * 左右 px-[30px] 与 MessageStream 滚动容器 px-[30px] 构成同一内容列 —— 履约
 * Composer.vue 宽度契约「composer 与消息流同宽同缘」：内容列未触及 720px 封顶的
 * 面板宽度下，composer 左右缘与消息列对齐，不外扩出消息列。demo .composer 的
 * margin 14px 语义在该契约登记后被「同缘」裁决覆盖，不得改回更小的横向外距。
 * 顶距 0：带壳顶缘与对话流滚动区底缘贴合，composer 上方不留底色带（2026-10-11
 * 用户裁决，偏离 demo .chat-scroll 24px + .composer 6px 的呼吸间距，demo 侧 spec
 * 未回写前以本注释为登记处）。底 pb-3.5 沿 demo 浮框形态；gap-1.5 承接带内多行
 * （提示条 / overlay / composer）行距。
 * `.composer-band` class 是测试钩子（plan-mode-bar 挂载位断言等），勿删。
 */
export const COMPOSER_BAND_CLASS =
  'composer-band flex flex-shrink-0 flex-col gap-1.5 px-[30px] pb-3.5'
