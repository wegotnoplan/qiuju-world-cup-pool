# 球局：世界杯朋友群奖池

一个给七人朋友群使用的本地 Web App，用于记录每场 1–3 注、锁定赔率、维护滚存奖池，并按规则自动或人工结算。它只负责记录和计算，不处理真实支付。

## 当前规则

- 固定成员：高哥、叶哥、东哥、丘哥、康哥、波哥、兆
- 每注固定 ¥10，每人每场可选 1–3 注，也可以不参加
- 选择姓名、选完注后点击“锁定并加入奖池”；个人锁定后不可修改
- 只有上一场已经结算后的下一场比赛可操作，开赛前 2 小时全场锁定
- 赔率不设最低或最高限制，保存下注时复制赔率快照
- 中奖彩票理论应返：`¥10 × 锁定十进制赔率`
- 奖池足额时全额返还；不足时按理论应返占比同比例折算
- 未支付余额滚入下一场，后一场注金不会用于赔付前一场
- 只按 90 分钟常规时间加伤停补时结算，不含加时赛和点球大战
- M101、M102 已按 `bet` 目录参考图内置 54 个选项；截图仅作为本群锁盘赔率快照

## 本地启动

环境要求：Node.js 22.13 或更高版本。

```powershell
npm install
npm run db:generate
npm run db:local
npm run dev -- --port 5173
```

打开 `http://localhost:5173`。

首次执行 `npm run db:local` 会在项目内的 `.wrangler/state` 创建本地 D1 数据库。后续数据会保留在本机，不会提交到 Git。

## 下注和导入赔率

首页只有一条横向比赛卡片轨道。滑到任意场时，上方对阵、比分、奖池、参与人数、结果和排行榜同步切换；已结束及未来场次只读。活动场点击“＋添加参与人”，选择姓名后可添加最多三注，再锁定加入奖池。

右上角进入“管理 → 导入赔率”，可上传 JSON 文件或直接粘贴。推荐格式：

```json
{
  "providerMatchId": null,
  "source": "赔率来源名称",
  "offers": [
    {
      "marketType": "MATCH_RESULT",
      "selectionCode": "HOME",
      "label": "法国胜",
      "odds": 2.4,
      "rulesText": "只按90分钟常规时间及伤停补时结算"
    }
  ]
}
```

首版可自动判定的结构化玩法：

- `MATCH_RESULT`：`HOME`、`DRAW`、`AWAY`
- `TOTAL_GOALS`：例如 `OVER_2.5`、`UNDER_2.5`
- `BOTH_TEAMS_TO_SCORE`：`YES`、`NO`
- `EXACT_SCORE`：例如 `2-1`
- 半球整数让球和平局退款也有基础支持；四分之一盘与无法仅凭比分判定的球员玩法会进入人工复核

## API-Football Widget 与赛果同步

页面使用 API-Sports Widget 展示当前单场赛况，同时通过本项目的同源代理读取数据。API key 只保存在服务端，浏览器端 `data-key` 留空，由 `/api/api-football/fixtures` 与 `/api/api-football/standings` 注入凭据；代理只开放 2026 世界杯或已绑定的比赛 ID，并把成功响应缓存到 D1。不要把 key 写入 `NEXT_PUBLIC_*`、组件属性或提交到 Git。

```powershell
Copy-Item .env.example .env.local
```

然后在 `.env.local` 中填写 `API_FOOTBALL_KEY`。M101 已绑定 API-Football fixture `1585131`；其余场次会在开赛前 36 小时进入发现窗口后，按北京时间比赛日、开球时间和对阵自动识别并保存 `providerMatchId`，也可在赔率 JSON 中手工提供。

免费计划每天只有 100 次请求、每分钟 10 次。本项目让所有浏览器共享 D1 缓存：直播单场约 3 分钟更新一次，未开赛至少缓存 30 分钟，结束赛果缓存 24 小时。结算请求也复用相同缓存，因此适合七人本地小群；若免费计划拒绝 `league=1&season=2026`，接口会明确返回套餐限制，不会泄露 key 或反复消耗已进入人工复核的场次。比赛日自动发现走服务器端 `date + timezone` 查询，再校验返回的 league/season。

首次同步窗口为 M101/M102/M104 北京时间 07:00，M103 北京时间 09:00。同步层只接受明确的半场比分和 90 分钟比分，不会退回使用加时或点球比分。字段缺失或含义不清时进入人工复核。

本地版在页面打开时补做已经到期的同步，因此电脑或浏览器关闭时无法保证准点执行。部署后应把同一个 `/api/results/sync` 接到服务端定时任务。

## 验证

```powershell
npm run lint
npm test
```

结算单元测试覆盖整数分、赔率计算、奖池不足的最大余数分配、作废退款，以及严格排除加时与点球的赛果判定。

## 后续上线

项目已使用 D1 持久化，并在 `.openai/hosting.json` 声明 `DB` 绑定。上线前还需要：

1. 配置托管环境的 D1 和 `API_FOOTBALL_KEY`
2. 给 `/api/results/sync` 配置服务端定时任务
3. 上传正式赔率及每场的 `providerMatchId`
4. 根据 API-Football 套餐与调用额度调整 Widget 刷新间隔或升级数据源
