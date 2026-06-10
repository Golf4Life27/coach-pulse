// The /v2 overlay is retired (charter pivot: V1 absorbs V2). The surfaces
// live as V1 tabs now — /today, /funnel, /agents. Old links land on Today.
import { redirect } from "next/navigation";

export default function V2Redirect() {
  redirect("/today");
}
