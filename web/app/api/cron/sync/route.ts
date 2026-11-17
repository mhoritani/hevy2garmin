import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runScheduledSync } from "@/lib/scheduled-sync";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";

// Runs the sync at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/sync  —  the scheduled-trigger entry (Vercel cron / any
 * scheduler). Requires `Authorization: Bearer <CRON_SECRET>`. Then, like the
 * live path of POST /api/sync, it hands off to the GitHub Action when
 * GITHUB_PAT + GITHUB_REPO are set (the deployed path, off the request), or
 * runs one pass of the single-workout engine in this process
 * (lib/scheduled-sync.ts). Mirrors the Python /api/cron/sync.
 */

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!secret || !m || m[1] !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  // Deployed path: hand off to the Action so the long browser-auth sync runs off
  // the request.
  // Settings row first, GITHUB_PAT fallback (#458). The DB handle may be unavailable here; env still works.
  let sqlForPat: ReturnType<typeof getDb> | null = null;
  try { sqlForPat = getDb(); } catch { sqlForPat = null; }
  const pat = await getGithubPat(sqlForPat);
  const repo = getGithubRepo();
  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      return NextResponse.json({ ok, mode: "dispatch", triggered: ok }, { status: ok ? 200 : 502 });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  // Local/self-hosted path: loop the tested engine.
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  const outcome = await runScheduledSync(sql, "cron");
  if (outcome.kind === "skipped") {
    return NextResponse.json({ ok: true, mode: "skipped", reason: outcome.reason, ran: 0 });
  }
  if (outcome.kind === "error") {
    return NextResponse.json({ ok: false, error: outcome.error, ran: outcome.ran }, { status: 500 });
  }
  return NextResponse.json({ ok: true, mode: "inline", ran: outcome.ran, synced: outcome.synced });
}
