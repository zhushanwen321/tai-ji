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
 * 顶距 0：band 顶缘与流滚动区底缘贴合，band 上方不占布局空白。贴底呼吸距离（32px）
 * 由 MessageStream 滚动内容末尾的 spacer 承载（tailEl 容器内 h-8，与尾块同一 RO 实测
 * 链自动计入 useVirtuaFollow endOffset）——它是对话流的一部分，随滚动移动：贴底落点
 * （回到最新 / 流式跟随 / 切会话回底 / 发消息回底共用的 scrollToRealBottom）最后内容
 * 距 composer 32px；用户上滑可把 spacer 滚出视口，内容贴到 composer 上缘（距离归零）。
 * 距离不得挪回 band 顶距或滚动容器 padding：前者是滚不掉的固定隔层（内容与 composer
 * 恒有间距），后者侵入 virtua viewportSize 扣除与 scrollToIndex 落点公式（useVirtuaFollow
 * D2 数学）。改呼吸距离值须两处同步：本注释与 MessageStream tailEl 尾部 spacer 类名。
 * 底 pb-3.5 沿 demo 浮框形态；gap-1.5 承接带内多行（提示条 / overlay / composer）行距。
 * `.composer-band` class 是测试钩子（plan-mode-bar 挂载位断言等），勿删。
 */
export const COMPOSER_BAND_CLASS =
  'composer-band flex flex-shrink-0 flex-col gap-1.5 px-[30px] pb-3.5'
