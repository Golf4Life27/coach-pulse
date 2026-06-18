#!/usr/bin/env node
// Milestone ↔ build-event pairing guard (operator 2026-06-18).
//
// THE PROBLEM: M5–M7 shipped as commits but no Spine build_event was written, so
// the continuity layer never learned they existed — a future session paid to
// re-read code to rediscover them. Discipline failed; this enforces the pairing
// in the pipeline.
//
// THE RULE: any commit whose SUBJECT starts with `M<n>` (a milestone commit) MUST
// ship a durable record at docs/build-events/M<n>.json. CI runs this on every
// push/PR and fails red if a milestone commit lacks its record. The committed
// JSON is the source of truth the Spine write (maverick_write_state build_event)
// mirrors — and it survives even if the MCP write is skipped or the Spine is down.
//
// Range: BUILD_EVENTS_BASE..BUILD_EVENTS_HEAD from env (CI sets them), else
// `main..HEAD` locally. No external deps.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BUILD_EVENTS_BASE || "main";
const head = process.env.BUILD_EVENTS_HEAD || "HEAD";

function gitSubjects(range) {
  return execSync(`git log --format=%s ${range}`, { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

let subjects;
try {
  subjects = gitSubjects(`${base}..${head}`);
} catch {
  // base may be unreachable (shallow clone / brand-new branch) → check HEAD only.
  subjects = gitSubjects(`-1 ${head}`);
}

// A milestone commit's subject STARTS with M<n> + a word boundary (": ", " Part",
// " (", …). "AS_BUILT §8c: record M7" does NOT match — it must be at the start.
const MILESTONE_RE = /^M(\d+)\b/;
const milestones = new Set();
for (const s of subjects) {
  const m = s.match(MILESTONE_RE);
  if (m) milestones.add(m[1]);
}

if (milestones.size === 0) {
  console.log(`[check-build-events] no milestone commits in ${base}..${head} — ok.`);
  process.exit(0);
}

const missing = [];
for (const n of [...milestones].sort((a, b) => Number(a) - Number(b))) {
  if (!existsSync(join(repoRoot, `docs/build-events/M${n}.json`))) {
    missing.push(`docs/build-events/M${n}.json`);
  }
}

if (missing.length > 0) {
  console.error(`::error::Milestone commit(s) found without a paired build-event record.`);
  console.error(`Missing: ${missing.join(", ")}`);
  console.error(`Every commit whose subject starts with "M<n>" must ship docs/build-events/M<n>.json`);
  console.error(`AND the same content to the Spine via maverick_write_state (build_event) in the same cycle.`);
  console.error(`See docs/build-events/README.md.`);
  process.exit(1);
}

const tags = [...milestones].sort((a, b) => Number(a) - Number(b)).map((n) => `M${n}`);
console.log(`[check-build-events] ${tags.join(", ")} each have a build-event record — ok.`);
process.exit(0);
