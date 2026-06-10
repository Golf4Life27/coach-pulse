"use client";

// V2Frame — the single mount point for everything V2 adds to the V1 shell
// (rendered by the root layout when the flag is on):
//   - one shared V2DataProvider (so /today and the strip share one fetch loop)
//   - the slim header health strip (charter ruling 4)
//   - the embedded Maverick panel (design law 3), floating bottom-right
// Children render inside V1's normal <main> container, untouched.

import { V2DataProvider, MaverickPanelProvider } from "../_lib/data";
import HealthStripSlim from "./HealthStripSlim";
import MaverickPanel from "./MaverickPanel";

export default function V2Frame({ children }: { children: React.ReactNode }) {
  return (
    <V2DataProvider>
      <MaverickPanelProvider>
        <HealthStripSlim />
        <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        <MaverickPanel />
      </MaverickPanelProvider>
    </V2DataProvider>
  );
}
