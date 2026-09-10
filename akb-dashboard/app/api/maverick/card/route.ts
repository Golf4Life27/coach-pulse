// Maverick Decision Card — creation route.
// @agent: maverick
//
// POST here to mint a one-screen decision card: Maverick declares the
// title, the evidence, and up to three PRE-BAKED options (each carrying its
// own already-decided action). The response is a short URL Maverick puts in
// the alert SMS. Tapping it in app/a/[token] and choosing one of the
// options is the ONLY thing the resulting token can do — see
// lib/maverick/decision-card.ts for why that's the security property that
// makes a bearer token in a text message acceptable here.
//
// Validation is deliberately strict and fails closed: every option's
// action.type must be in the allowlist (isAllowedCardAction) or the whole
// request is rejected with 400. sign_contract and walk_away are NOT in that
// allowlist — they move money or kill a deal outright and stay laptop-only
// until there's a reason to trust a text-message tap with them.
//
// Auth mirrors the rest of the write surface (contract-watch, priorities):
// same-origin dashboard session OR the OAuth/cron/dev-bearer waterfall.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { generateOpaqueToken } from "@/lib/maverick/oauth/crypto";
import {
  putCard,
  cardUrl,
  resolveBaseUrl,
  isAllowedCardAction,
  type CardOption,
  type DecisionCard,
} from "@/lib/maverick/decision-card";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_TTL_HOURS = 24;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168; // 7 days

function clampTtlHours(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_TTL_HOURS;
  return Math.min(Math.max(n, MIN_TTL_HOURS), MAX_TTL_HOURS);
}

interface CreateCardBody {
  title?: unknown;
  context?: unknown;
  options?: unknown;
  ttlHours?: unknown;
}

type ValidationError = { field: string; detail: string };

/** Validate one option's shape + allowlist its action.type. Returns either
 *  the typed CardOption or an error describing exactly what was wrong —
 *  an unknown action type is a 400, never a silent drop. */
function validateOption(x: unknown, index: number): CardOption | ValidationError {
  if (typeof x !== "object" || x === null) {
    return { field: `options[${index}]`, detail: "must be an object" };
  }
  const o = x as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key.length === 0) {
    return { field: `options[${index}].key`, detail: "required non-empty string" };
  }
  if (typeof o.label !== "string" || o.label.length === 0) {
    return { field: `options[${index}].label`, detail: "required non-empty string" };
  }
  if (o.style !== "primary" && o.style !== "secondary" && o.style !== "danger") {
    return { field: `options[${index}].style`, detail: 'must be "primary" | "secondary" | "danger"' };
  }
  if (typeof o.confirmation !== "string" || o.confirmation.length === 0) {
    return { field: `options[${index}].confirmation`, detail: "required non-empty string" };
  }
  const action = o.action;
  if (typeof action !== "object" || action === null) {
    return { field: `options[${index}].action`, detail: "required object" };
  }
  const a = action as Record<string, unknown>;
  if (typeof a.type !== "string" || !isAllowedCardAction(a.type)) {
    return {
      field: `options[${index}].action.type`,
      detail: `"${String(a.type)}" is not an allowed card action type`,
    };
  }
  if (typeof a.recordId !== "string" || a.recordId.length === 0) {
    return { field: `options[${index}].action.recordId`, detail: "required non-empty string" };
  }
  if (a.table !== undefined && a.table !== "listings" && a.table !== "deals") {
    return { field: `options[${index}].action.table`, detail: 'must be "listings" | "deals"' };
  }
  if (a.until !== undefined && typeof a.until !== "string") {
    return { field: `options[${index}].action.until`, detail: "must be a string" };
  }
  if (a.note !== undefined && typeof a.note !== "string") {
    return { field: `options[${index}].action.note`, detail: "must be a string" };
  }
  return {
    key: o.key,
    label: o.label,
    style: o.style,
    confirmation: o.confirmation,
    action: {
      type: a.type,
      recordId: a.recordId,
      table: a.table as "listings" | "deals" | undefined,
      until: a.until as string | undefined,
      note: a.note as string | undefined,
    },
  };
}

function isValidationError(x: CardOption | ValidationError): x is ValidationError {
  return "field" in x;
}

export async function POST(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) — writes are never open ──
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }

  if (!kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }

  let body: CreateCardBody;
  try {
    body = (await req.json()) as CreateCardBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.title !== "string" || body.title.length === 0) {
    return NextResponse.json({ error: "title required (non-empty string)" }, { status: 400 });
  }
  if (!Array.isArray(body.context) || !body.context.every((c) => typeof c === "string")) {
    return NextResponse.json({ error: "context required (string[])" }, { status: 400 });
  }
  if (!Array.isArray(body.options) || body.options.length < 1 || body.options.length > 3) {
    return NextResponse.json({ error: "options required (1-3 entries)" }, { status: 400 });
  }

  const validated = body.options.map((o, i) => validateOption(o, i));
  const errors = validated.filter(isValidationError);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_options", detail: errors }, { status: 400 });
  }
  const options = validated as CardOption[];

  const ttlHours = clampTtlHours(body.ttlHours);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();

  const token = generateOpaqueToken("");
  const card: DecisionCard = {
    token,
    title: body.title,
    context: body.context as string[],
    options,
    createdAt: nowIso,
    expiresAt,
  };

  await putCard(kvProd, card, nowIso);

  const baseUrl = resolveBaseUrl();
  const url = baseUrl ? cardUrl(token, baseUrl) : null;

  await audit({
    agent: "maverick",
    event: "decision_card_created",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, options: options.map((o) => o.action.type), ttl_hours: ttlHours },
    outputSummary: { token, has_url: url !== null },
    decision: "decision_card_created",
    ms: Date.now() - t0,
  }).catch(() => {});

  if (!url) {
    return NextResponse.json({
      ok: true,
      token,
      url: null,
      warning: "DASHBOARD_BASE_URL is not set — cannot build an absolute link. Set it to enable card URLs.",
    });
  }

  return NextResponse.json({ ok: true, token, url });
}
