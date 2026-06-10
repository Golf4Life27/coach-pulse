// Server-side V2 flag (shared by the mounted tab routes and the V1 nav).
//   - production: OFF unless V2_DASHBOARD=true on the project
//   - Vercel preview deploys: ON automatically (where v2 is reviewed)
//   - local dev: ON
// The mounted surfaces are read-only against the spine; the only mutations
// are PATCH /api/operator-actions and POST /api/mark-dead — both existing
// v1 routes the v1 Queue / deal page already call.

export function v2Enabled(): boolean {
  if (process.env.V2_DASHBOARD === "true") return true;
  if (process.env.VERCEL_ENV === "preview") return true;
  if (process.env.NODE_ENV === "development") return true;
  return false;
}
