import type { Metadata } from "next";
import { PoolWorkbench } from "./components/PoolWorkbench";

export const metadata: Metadata = {
  title: "球局 · 世界杯奖池",
  description: "七人世界杯竞猜奖池的记录、锁盘与结算工具。",
};

export default function Home() {
  return <PoolWorkbench />;
}
