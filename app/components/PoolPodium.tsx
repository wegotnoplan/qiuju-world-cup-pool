import type { ParticipantId } from "@/lib/app-data";
import { participantAvatarSrc } from "@/lib/participant-avatars";

export interface PoolRankingRow {
  id: ParticipantId;
  name: string;
  invested: number;
  payout: number;
  roi: number;
  hasWin: boolean;
  wonCount: number;
  displayOrder: number;
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

const PODIUM_SLOT = [
  { rank: 2, center: 75, avatarY: 38, top: 105, height: 50, rankY: 133, fill: "#d6d9d5" },
  { rank: 1, center: 180, avatarY: 12, top: 79, height: 76, rankY: 107, fill: "#d3aa41" },
  { rank: 3, center: 285, avatarY: 42, top: 119, height: 36, rankY: 137, fill: "#b9835e" },
] as const;

function roiText(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

export function PoolPodium({ rows }: { rows: PoolRankingRow[] }) {
  const winners = rows.filter((row) => row.hasWin).slice(0, 3);
  const winnerByRank = new Map(winners.map((row, index) => [index + 1, row]));
  const podiumIds = new Set(winners.map((row) => row.id));
  const remaining = rows.filter((row) => !podiumIds.has(row.id));

  return (
    <div className="wb-podium-layout">
      {winners.length > 0 ? (
        <div className="wb-podium-stage">
          <svg
            className="wb-podium"
            viewBox="0 0 360 164"
            role="img"
            aria-label={`中奖榜前三名：${winners.map((row, index) => `第${index + 1}名${row.name}`).join("，")}`}
          >
            <title>本场中奖榜领奖台</title>
            <defs>
              {PODIUM_SLOT.map((slot) => (
                <clipPath id={`wb-podium-avatar-${slot.rank}`} key={slot.rank}>
                  <rect x={slot.center - 28} y={slot.avatarY} width="56" height="56" rx="14" />
                </clipPath>
              ))}
            </defs>
            {PODIUM_SLOT.map((slot) => {
              const row = winnerByRank.get(slot.rank);
              return (
                <g key={slot.rank} className={`${row ? "has-winner" : "is-empty"} rank-${slot.rank}`}>
                  <rect
                    x={slot.center - 49}
                    y={slot.top}
                    width="98"
                    height={slot.height}
                    rx="8"
                    fill={slot.fill}
                  />
                  <text className="wb-podium-rank" x={slot.center} y={slot.rankY} textAnchor="middle">
                    {slot.rank}
                  </text>
                  {row ? (
                    <>
                      <rect
                        className="wb-podium-avatar-back"
                        x={slot.center - 30}
                        y={slot.avatarY - 2}
                        width="60"
                        height="60"
                        rx="16"
                      />
                      <image
                        href={participantAvatarSrc(row.id)}
                        x={slot.center - 28}
                        y={slot.avatarY}
                        width="56"
                        height="56"
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#wb-podium-avatar-${slot.rank})`}
                      />
                      <text className="wb-podium-prize" x={slot.center} y={slot.top + slot.height - 7} textAnchor="middle">
                        收 {money(row.payout)}
                      </text>
                    </>
                  ) : (
                    <text className="wb-podium-empty" x={slot.center} y={slot.avatarY + 30} textAnchor="middle">空缺</text>
                  )}
                </g>
              );
            })}
            <path className="wb-podium-floor" d="M18 158H342" />
          </svg>
          <div className="wb-podium-stats" aria-label="领奖台前三名投入与回报率">
            {PODIUM_SLOT.map((slot) => {
              const row = winnerByRank.get(slot.rank);
              return row ? (
                <span key={slot.rank}>
                  <b>{slot.rank} · {row.name}</b>
                  <small>投 {money(row.invested)} · 回 {roiText(row.roi)}</small>
                </span>
              ) : <span key={slot.rank} aria-hidden="true" />;
            })}
          </div>
        </div>
      ) : (
        <p className="wb-no-winners">本场没有中奖彩票，全部注金滚入下一场。</p>
      )}

      {remaining.length > 0 && (
        <table className="wb-ranking" aria-label="本场其余参与者回报">
          <thead>
            <tr><th>参与者</th><th>投入</th><th>收获</th><th>回报率</th></tr>
          </thead>
          <tbody>
            {remaining.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{money(row.invested)}</td>
                <td><strong>{money(row.payout)}</strong></td>
                <td data-positive={row.roi >= 0}>{roiText(row.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
