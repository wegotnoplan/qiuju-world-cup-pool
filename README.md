# 球局：世界杯朋友群奖池

一个给七人朋友群使用的本地 Web App，用于记录每场 1–3 注、锁定赔率、维护滚存奖池，并按规则自动或人工结算。它只负责记录和计算，不处理真实支付。

## 当前规则

- 固定成员：高哥、叶哥、东哥、丘哥、康哥、波哥、兆
- 每注固定 ¥10，每人每场可选 1–3 注，也可以不参加
- 只有时间顺序中的下一场比赛可操作，开赛前 2 小时锁定
- 赔率不设最低或最高限制，保存下注时复制赔率快照
- 中奖彩票理论应返：`¥10 × 锁定十进制赔率`
- 奖池足额时全额返还；不足时按理论应返占比同比例折算
- 未支付余额滚入下一场，后一场注金不会用于赔付前一场
- 只按 90 分钟常规时间加伤停补时结算，不含加时赛和点球大战

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

## 导入赔率

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

## 赛果同步

FIFA 没有面向普通开发者公开、稳定且自助申请的比赛结果 API。当前适配层使用 [football-data.org v4](https://www.football-data.org/documentation/quickstart)，服务器端变量为：

```powershell
Copy-Item .env.example .env.local
```

然后在 `.env.local` 中填写 `FOOTBALL_DATA_API_TOKEN`，并在赔率 JSON 中提供对应的 `providerMatchId`。

同步层只接受数据源明确返回的 `FINISHED` 和 `score.regularTime`，不会退回使用 `fullTime`、加时或点球比分。若字段缺失、比赛异常或玩法无法仅靠常规时间比分判定，系统会标记为“待人工复核”。

本地版在页面打开时补做已经到期的同步，因此电脑或浏览器关闭时无法保证准点执行。部署后应把同一个 `/api/results/sync` 接到服务端定时任务。

## 验证

```powershell
npm run lint
npm test
```

结算单元测试覆盖整数分、赔率计算、奖池不足的最大余数分配、作废退款，以及严格排除加时与点球的赛果判定。

## 后续上线

项目已使用 D1 持久化，并在 `.openai/hosting.json` 声明 `DB` 绑定。上线前还需要：

1. 配置托管环境的 D1 和 `FOOTBALL_DATA_API_TOKEN`
2. 给 `/api/results/sync` 配置服务端定时任务
3. 上传正式赔率及每场的 `providerMatchId`
4. 如对数据延迟要求更高，可通过现有 provider adapter 接入 API-Football 或商业数据源
