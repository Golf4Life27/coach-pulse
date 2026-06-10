// TODAY — V1 tab (V2 absorption), behind the V2 flag. The board lives in
// app/v2/_components and carries the four portable libs; deal links point
// at V1's canonical /pipeline/[id].

import TodayBoard from "../v2/_components/TodayBoard";
import FlagOff from "../v2/_components/FlagOff";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function TodayPage() {
  if (!v2Enabled()) return <FlagOff surface="Today" />;
  return <TodayBoard />;
}
