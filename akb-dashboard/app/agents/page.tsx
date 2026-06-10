// AGENTS — V1 tab (V2 absorption), behind the V2 flag.

import AgentsBoard from "../v2/_components/AgentsBoard";
import FlagOff from "../v2/_components/FlagOff";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  if (!v2Enabled()) return <FlagOff surface="Agents" />;
  return <AgentsBoard />;
}
