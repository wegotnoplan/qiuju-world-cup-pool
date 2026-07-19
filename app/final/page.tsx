import type { Metadata } from "next";
import { FinalPoolLedger } from "../components/FinalPoolLedger";

export const metadata: Metadata = {
  title: "最终总账",
  description: "世界杯奖池封账后的完整派彩、最终排名与三桶审计。",
};

export default function FinalLedgerPage() {
  return <FinalPoolLedger />;
}
