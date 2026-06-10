// FUNNEL — V1 tab (V2 absorption), behind the V2 flag. Named FUNNEL so it
// doesn't collide with V1's PIPELINE tab (the listings table).

import FunnelBoard from "../v2/_components/FunnelBoard";
import FlagOff from "../v2/_components/FlagOff";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function FunnelPage() {
  if (!v2Enabled()) return <FlagOff surface="Funnel" />;
  return <FunnelBoard />;
}
