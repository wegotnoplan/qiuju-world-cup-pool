# Design System

## Direction

世界杯转播记分牌与体育场导视的结合。界面以朋友群工具的可信和高效率为先，不使用赌场霓虹、筹码或老虎机视觉，也不复制赛事官方商标。

## Theme

Light-first。用户多在普通室内光线下单手操作手机；大面积暖纸色降低刺眼感，深墨绿仅用于顶部栏、比赛记分牌和固定确认动作。

## Color

- Paper: `oklch(0.972 0.012 92)`
- Surface: `oklch(0.992 0.006 92)`
- Ink: `oklch(0.235 0.027 155)`
- Pitch green: `oklch(0.405 0.105 153)`
- Tournament gold: `oklch(0.81 0.145 84)`
- Urgency red: `oklch(0.59 0.19 30)`

状态始终同时使用文字或符号，不只依赖颜色。

## Typography

使用系统无衬线字体栈：Inter、Noto Sans SC、Microsoft YaHei、system-ui。赔率、金额、时间和比分使用 tabular numerals。标题用紧凑高字重，正文行高保持 1.55–1.75。

## Components

- 比赛轴：横向滚动、中心吸附；活动场次为绿色描边，其他场次仍可查看但锁定
- 记分牌：深墨绿整块表面，球队、时间、锁定状态同屏
- 参与者：原生 checkbox 语义，整行可点，1–3 注使用 44px 以上步进器
- 赔率选择：手机底部 sheet，桌面居中 dialog；顶部和底部重复 90 分钟口径
- 账本：使用资金流公式与时间线，不使用无意义的指标卡片墙
- 导航：手机底部四项，桌面顶部胶囊标签

## Responsive

基准宽度 360px；任务区最大 720px，桌面账本最大 1080px。触控目标至少 44×44px，输入字体至少 16px，固定操作区为安全区留出空间。

## Motion

仅用于 sheet、toast 和状态切换，150–220ms ease-out；遵守 `prefers-reduced-motion`。
