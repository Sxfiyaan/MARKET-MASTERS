import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

type Row = Record<string, any>;

const getEnv = (key: string): string | undefined => {
  if (typeof Deno !== "undefined" && (Deno as any).env) return (Deno as any).env.get(key);
  if (typeof process !== "undefined" && process.env) return process.env[key];
  return undefined;
};

const supabaseUrl = getEnv("SUPABASE_URL");
const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

let db = (supabaseUrl && serviceRoleKey)
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : (null as unknown as SupabaseClient);

export function setTestDb(client: any) {
  db = client;
}

const CACHE_TTL_MS = 5_000;
let configCache: { value: Row; expiresAt: number } | null = null;
let leaderboardCache: { key: string; generation: number; value: Row[]; expiresAt: number } | null = null;
const inFlightLeaderboard = new Map<string, { promise: Promise<Row[]>; generation: number }>();
let cacheGeneration = 0;

const DEFAULT_CONFIG = {
  id: "event",
  event_name: "Market Masters: The Trading Floor",
  team_size: 4,
  registration_open: true,
  round1_weight: 30,
  round2_weight: 30,
  round3_weight: 40,
  round3_duration_minutes: 60,
  max_trades: 2,
  starting_capital: 100000,
  max_risk_per_trade: 2,
  performance_weight: 60,
  risk_mgmt_weight: 40,
  leaderboard_visible: true,
  trade_proof_required: false,
  speed_bonus_pct: 0.5,
  results_finalized: false,
  rounds: {
    "1": { state: "UPCOMING", started_at: null, ended_at: null },
    "2": { state: "UPCOMING", started_at: null, ended_at: null },
    "3": { state: "UPCOMING", started_at: null, ended_at: null },
  },
};

const DEFAULT_R1_STATE: Row = {
  id: "current",
  version: 1,
  status: "IDLE",
  phase: "WAITING",
  current_question_index: 0,
  current_question_id: null,
  total_questions: 0,
  phase_start_at: null,
  phase_ends_at: null,
  is_paused: false,
  paused_at: null,
  pause_phase: null,
  paused_remaining_ms: 0,
  countdown_seconds: 10,
  result_seconds: 10,
  closed_question_ids: [],
  frozen_questions: null,
  speed_bonus_pct: 0.5,
};

const DEFAULT_R2_STATE: Row = {
  id: "current",
  version: 1,
  status: "IDLE",
  phase: "WAITING",
  current_question_index: 0,
  current_question_id: null,
  total_questions: 0,
  phase_start_at: null,
  phase_ends_at: null,
  is_paused: false,
  paused_at: null,
  pause_phase: null,
  paused_remaining_ms: 0,
  countdown_seconds: 10,
  question_seconds: 120,
  result_seconds: 10,
  closed_question_ids: [],
  frozen_questions: null,
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const jsonHeaders = (request: Request) => {
  const origin = request.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };
};

function json(request: Request, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders(request) });
}

function publicJson(request: Request, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...jsonHeaders(request),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=2, s-maxage=2, stale-while-revalidate=5",
      "Vary": "Accept-Encoding",
    },
  });
}

function csv(request: Request, rows: Row[], filename: string) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const quote = (value: unknown) => {
    const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const content = [keys.map(quote).join(","), ...rows.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\n");
  return new Response(content, {
    headers: { ...jsonHeaders(request), "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=${filename}` },
  });
}

async function readBody(request: Request): Promise<Row> {
  try { return await request.json(); } catch { return {}; }
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(422, `${name} is required`);
  return value.trim();
}

async function one(table: string, filters: Row, select = "*") {
  let query = db.from(table).select(select);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query.maybeSingle();
  if (error) throw new ApiError(500, error.message);
  return data as Row | null;
}

export async function all(
  table: string,
  filters: Row = {},
  order?: [string, boolean] | Array<[string, boolean]>,
  select = "*",
  pageSize = 1000
) {
  const allRows: Row[] = [];
  let page = 0;

  // Determine deterministic order columns
  const orderSpecs: Array<[string, boolean]> = [];
  if (order) {
    if (Array.isArray(order[0])) {
      orderSpecs.push(...(order as Array<[string, boolean]>));
    } else {
      orderSpecs.push(order as [string, boolean]);
    }
  } else if (table === "score_overrides") {
    orderSpecs.push(["team_id", true], ["round", true]);
  } else if (table === "leaderboard_snapshot") {
    orderSpecs.push(["team_id", true]);
  } else if (table === "app_documents") {
    orderSpecs.push(["collection", true], ["id", true]);
  } else {
    orderSpecs.push(["id", true]);
  }

  // Ensure deterministic tie-breaker is present for pagination stability
  const tieBreakers: Array<[string, boolean]> =
    table === "score_overrides"
      ? [["team_id", true], ["round", true]]
      : table === "leaderboard_snapshot"
      ? [["team_id", true]]
      : table === "app_documents"
      ? [["collection", true], ["id", true]]
      : [["id", true]];

  for (const tb of tieBreakers) {
    if (!orderSpecs.some((s) => s[0] === tb[0])) {
      orderSpecs.push(tb);
    }
  }

  while (true) {
    let query = db.from(table).select(select);
    for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
    for (const [col, asc] of orderSpecs) {
      query = query.order(col, { ascending: asc });
    }
    query = query.range(page * pageSize, (page + 1) * pageSize - 1);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    const rows = (data || []) as Row[];
    allRows.push(...rows);
    if (rows.length < pageSize) break;
    page++;
  }
  return allRows;
}

async function insert(table: string, values: Row | Row[]) {
  const { data, error } = await db.from(table).insert(values).select().single();
  if (error) throw new ApiError(error.code === "23505" ? 400 : 500, error.code === "23505" ? "Record already exists" : error.message);
  return data as Row;
}

function questionOut(row: Row, admin: boolean) {
  const result = {
    id: row.id,
    round: row.round,
    text: row.text,
    options: row.options || [],
    correct_answer: admin ? row.correct_answer : undefined,
    base_points: row.base_points,
    time_limit: row.time_limit,
    asset: row.asset,
    timeframe: row.timeframe,
    chart_image_url: row.chart_image_url,
    order: row.question_order,
  } as Row;
  if (!admin) delete result.correct_answer;
  return result;
}

async function currentUser(request: Request, required = true): Promise<{ auth: User; profile: Row } | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    if (required) throw new ApiError(401, "Not authenticated");
    return null;
  }
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "Invalid or expired session");
  let profile = await one("profiles", { id: data.user.id });
  const adminEmail = (getEnv("ADMIN_EMAIL") || "").toLowerCase();
  if (!profile && adminEmail && data.user.email?.toLowerCase() === adminEmail) {
    profile = await insert("profiles", { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name || "Admin", role: "admin" });
  }
  if (!profile) throw new ApiError(403, "Profile is not configured");
  return { auth: data.user, profile };
}

export function invalidateConfigCache() {
  configCache = null;
}

export function invalidateLeaderboardCache() {
  cacheGeneration++;
  leaderboardCache = null;
  inFlightLeaderboard.clear();
}

async function teamUser(request: Request) {
  const user = await currentUser(request);
  if (user!.profile.role !== "team" || !user!.profile.team_id) throw new ApiError(403, "Team only");
  return user!;
}

async function adminUser(request: Request) {
  const user = await currentUser(request);
  if (user!.profile.role !== "admin") throw new ApiError(403, "Admin only");
  return user!;
}

async function audit(action: string, user: { auth: User; profile: Row } | null, details: Row = {}) {
  await db.from("audit_logs").insert({
    user_id: user?.auth.id || null,
    user_email: user?.auth.email || null,
    role: user?.profile.role || null,
    action,
    details,
  });
}

export async function config() {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.value;
  const value = (await one("event_config", { id: "event" })) || DEFAULT_CONFIG;
  configCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

async function activeRound(round: number) {
  const cfg = await config();
  if (cfg.results_finalized) throw new ApiError(400, "Results are finalized. Submissions are closed.");
  const state = cfg.rounds?.[String(round)]?.state || "UPCOMING";
  if (state === "PAUSED") throw new ApiError(400, `Round ${round} is paused`);
  if (state !== "ACTIVE") throw new ApiError(400, `Round ${round} is not active (state=${state})`);
  return cfg;
}

function profileOut(profile: Row, team?: Row | null) {
  return { id: profile.id, email: profile.email, name: profile.name, role: profile.role, team_id: profile.team_id, ...(team ? { team } : {}) };
}

// Single consistent definition of whether a Round 1 question is closed
export function isQuestionClosed(r1State: Row | null, questionId: string): boolean {
  if (!r1State || !questionId) return false;
  const closedIds = Array.isArray(r1State.closed_question_ids) ? r1State.closed_question_ids : [];
  return closedIds.includes(questionId);
}

// Single consistent definition of whether a Round 2 question is closed
export function isRound2QuestionClosed(r2State: Row | null, questionId: string): boolean {
  if (!r2State || !questionId) return false;
  const closedIds = Array.isArray(r2State.closed_question_ids) ? r2State.closed_question_ids : [];
  return closedIds.includes(questionId);
}

// Durable Round 1 state loader with controlled error handling
export async function getRound1State(): Promise<Row> {
  const { data, error } = await db.from("round1_state").select("*").eq("id", "current").maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 1 database schema is not initialized. Please apply migration 202610250007_market_masters_synchronized_round1.sql.");
    }
    throw new ApiError(500, `Database error loading Round 1 state: ${error.message}`);
  }
  if (!data) {
    throw new ApiError(500, "Round 1 state row 'current' is missing. Please run migration 202610250007_market_masters_synchronized_round1.sql.");
  }
  return data;
}

// Checked versioned update preventing stale requests from overwriting newer phase or pause
export async function saveRound1State(updates: Row, expectedVersion?: number): Promise<Row> {
  const nextVersion = expectedVersion !== undefined ? expectedVersion + 1 : undefined;
  let query = db
    .from("round1_state")
    .update({
      ...updates,
      ...(nextVersion !== undefined ? { version: nextVersion } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "current");

  if (expectedVersion !== undefined) {
    query = query.eq("version", expectedVersion);
  }

  const { data, error } = await query.select().maybeSingle();

  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 1 database schema is not initialized. Please apply migration 202610250007_market_masters_synchronized_round1.sql.");
    }
    throw new ApiError(500, `Database error saving Round 1 state: ${error.message}`);
  }

  if (!data) {
    if (expectedVersion !== undefined) {
      throw new ApiError(409, "Round 1 state conflict: state was modified by a concurrent request. Please refresh and try again.");
    }
    throw new ApiError(500, "Failed to update Round 1 state: record 'current' was not found.");
  }

  invalidateLeaderboardCache();
  return data;
}

// Procedural transactional phase advancement with row lock across edge instances
export async function advanceRound1State(): Promise<Row> {
  const nowIso = new Date().toISOString();
  const { data: rpcData, error: rpcError } = await db.rpc("advance_round1_state_tx", {
    p_now: nowIso,
  });

  if (!rpcError && rpcData) {
    if (rpcData.error) {
      throw new ApiError(500, rpcData.error);
    }
    invalidateLeaderboardCache();
    if (rpcData.phase === "COMPLETED") {
      invalidateConfigCache();
    }
    return rpcData;
  }

  if (rpcError) {
    if (rpcError.code === "42883" || rpcError.code === "42P01" || rpcError.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 1 database schema or procedure is not initialized. Please apply migration 202610250007_market_masters_synchronized_round1.sql.");
    }
    throw new ApiError(500, `Database error advancing Round 1 state: ${rpcError.message}`);
  }

  return await getRound1State();
}

// Durable Round 2 state loader with controlled error handling
export async function getRound2State(): Promise<Row> {
  const { data, error } = await db.from("round2_state").select("*").eq("id", "current").maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 2 database schema is not initialized. Please apply migration 202610250009_market_masters_synchronized_round2.sql.");
    }
    throw new ApiError(500, `Database error loading Round 2 state: ${error.message}`);
  }
  if (!data) {
    throw new ApiError(500, "Round 2 state row 'current' is missing. Please run migration 202610250009_market_masters_synchronized_round2.sql.");
  }
  return data;
}

// Checked versioned update for Round 2
export async function saveRound2State(updates: Row, expectedVersion?: number): Promise<Row> {
  const nextVersion = expectedVersion !== undefined ? expectedVersion + 1 : undefined;
  let query = db
    .from("round2_state")
    .update({
      ...updates,
      ...(nextVersion !== undefined ? { version: nextVersion } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "current");

  if (expectedVersion !== undefined) {
    query = query.eq("version", expectedVersion);
  }

  const { data, error } = await query.select().maybeSingle();

  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 2 database schema is not initialized. Please apply migration 202610250009_market_masters_synchronized_round2.sql.");
    }
    throw new ApiError(500, `Database error saving Round 2 state: ${error.message}`);
  }

  if (!data) {
    if (expectedVersion !== undefined) {
      throw new ApiError(409, "Round 2 state conflict: state was modified by a concurrent request. Please refresh and try again.");
    }
    throw new ApiError(500, "Failed to update Round 2 state: record 'current' was not found.");
  }

  invalidateLeaderboardCache();
  return data;
}

let lastR2StateSummary: { version: number; phase: string; status: string; closedCount: number } | null = null;

// Procedural transactional phase advancement for Round 2
export async function advanceRound2State(): Promise<Row> {
  const nowIso = new Date().toISOString();
  const { data: rpcData, error: rpcError } = await db.rpc("advance_round2_state_tx", {
    p_now: nowIso,
  });

  if (!rpcError && rpcData) {
    if (rpcData.error) {
      throw new ApiError(500, rpcData.error);
    }
    const closedCount = Array.isArray(rpcData.closed_question_ids) ? rpcData.closed_question_ids.length : 0;
    const hasChanged = !lastR2StateSummary ||
      lastR2StateSummary.version !== rpcData.version ||
      lastR2StateSummary.phase !== rpcData.phase ||
      lastR2StateSummary.status !== rpcData.status ||
      lastR2StateSummary.closedCount !== closedCount;

    if (hasChanged) {
      lastR2StateSummary = {
        version: rpcData.version,
        phase: rpcData.phase,
        status: rpcData.status,
        closedCount,
      };
      invalidateLeaderboardCache();
    }
    if (rpcData.phase === "COMPLETED") {
      invalidateConfigCache();
    }
    return rpcData;
  }

  if (rpcError) {
    if (rpcError.code === "42883" || rpcError.code === "42P01" || rpcError.message?.includes("does not exist")) {
      throw new ApiError(500, "Round 2 database schema or procedure is not initialized. Please apply migration 202610250009_market_masters_synchronized_round2.sql.");
    }
    throw new ApiError(500, `Database error advancing Round 2 state: ${rpcError.message}`);
  }

  return await getRound2State();
}

export async function computeScores(targetR1State?: Row, targetR2State?: Row) {
  const cfg = await config();
  const [teams, submissions, trades, overrides, previous, r1State, r2State] = await Promise.all([
    all("teams"),
    all("submissions"),
    all("trades"),
    all("score_overrides"),
    all("leaderboard_snapshot"),
    targetR1State ? Promise.resolve(targetR1State) : getRound1State(),
    targetR2State ? Promise.resolve(targetR2State) : getRound2State(),
  ]);

  // Unified closed questions check: Only count Round 1 & Round 2 submissions for genuinely CLOSED questions
  const closedIds = new Set(Array.isArray(r1State?.closed_question_ids) ? r1State.closed_question_ids : []);
  const closedR2Ids = new Set(Array.isArray(r2State?.closed_question_ids) ? r2State.closed_question_ids : []);

  const overrideMap = new Map(overrides.map((o) => [`${o.team_id}:${o.round}`, Number(o.new_score)]));
  const previousMap = new Map(previous.map((o) => [o.team_id, o.rank]));
  const rows: Row[] = teams.map((team) => {
    const tid = team.id;
    const r1 = submissions
      .filter((s) => s.team_id === tid && s.round === 1 && closedIds.has(s.question_id))
      .reduce((sum, s) => sum + Number(s.score || 0), 0);
    const r2 = submissions
      .filter((s) => s.team_id === tid && s.round === 2 && closedR2Ids.has(s.question_id))
      .reduce((sum, s) => sum + Number(s.score || 0), 0);
    // Separate risk metric tracks non-rejected trades (unchanged)
    const round3Trades = trades.filter((t) => t.team_id === tid && t.verification_status !== "REJECTED");
    let risk = round3Trades.length ? 1000 : 500;
    for (const trade of round3Trades) {
      const riskPct = Number(trade.risk_per_trade || 0);
      if (riskPct > Number(cfg.max_risk_per_trade)) risk -= 300;
      else if (riskPct <= Number(cfg.max_risk_per_trade) / 2) risk += 100;
      else risk += 50;
      if (Number(trade.pl_percentage || 0) < -Number(cfg.max_risk_per_trade) * 1.5) risk -= 200;
    }
    risk = Math.max(0, Math.min(1000, risk));

    // Only VERIFIED trades earn points in Round 3 scoring
    const verifiedTrades = trades.filter((t) => t.team_id === tid && t.verification_status === "VERIFIED");
    let performance = 0;
    let totalPl = 0;
    let r3Raw = 0;

    if (overrideMap.has(`${tid}:3`)) {
      r3Raw = Number(overrideMap.get(`${tid}:3`));
      if (verifiedTrades.length > 0) {
        totalPl = verifiedTrades.reduce((sum, t) => sum + Number(t.pl_percentage || 0), 0);
        performance = Math.max(0, Math.min(1, (totalPl + 5) / 15)) * 1000;
      }
    } else if (verifiedTrades.length > 0) {
      totalPl = verifiedTrades.reduce((sum, t) => sum + Number(t.pl_percentage || 0), 0);
      performance = Math.max(0, Math.min(1, (totalPl + 5) / 15)) * 1000;

      let verifiedRisk = 1000;
      for (const trade of verifiedTrades) {
        const riskPct = Number(trade.risk_per_trade || 0);
        if (riskPct > Number(cfg.max_risk_per_trade)) verifiedRisk -= 300;
        else if (riskPct <= Number(cfg.max_risk_per_trade) / 2) verifiedRisk += 100;
        else verifiedRisk += 50;
        if (Number(trade.pl_percentage || 0) < -Number(cfg.max_risk_per_trade) * 1.5) verifiedRisk -= 200;
      }
      verifiedRisk = Math.max(0, Math.min(1000, verifiedRisk));

      const combined = (Number(cfg.performance_weight) / 100) * performance + (Number(cfg.risk_mgmt_weight) / 100) * verifiedRisk;
      r3Raw = combined;
    } else {
      // With no verified trades and no explicit admin override, R3 score must be 0
      r3Raw = 0;
      performance = 0;
      totalPl = 0;
    }

    const r1Raw = overrideMap.get(`${tid}:1`) ?? r1;
    const r2Raw = overrideMap.get(`${tid}:2`) ?? r2;
    return {
      team_id: tid, team_name: team.team_name, college: team.college,
      round1: Number(r1Raw.toFixed(2)), round2: Number(r2Raw.toFixed(2)), round3: Number(r3Raw.toFixed(2)),
      performance_score: Number(performance.toFixed(2)), risk_score: Number(risk.toFixed(2)),
      total_pl_pct: Number(totalPl.toFixed(2)),
      total: Number(((Number(cfg.round1_weight) / 100) * r1Raw + (Number(cfg.round2_weight) / 100) * r2Raw + (Number(cfg.round3_weight) / 100) * r3Raw).toFixed(2)),
    };
  });
  rows.sort((a, b) => b.total - a.total || b.round3 - a.round3 || b.risk_score - a.risk_score || b.round2 - a.round2);
  rows.forEach((row, index) => {
    const rank = index + 1;
    const old = previousMap.get(row.team_id);
    row.rank = rank;
    row.rank_change = old == null ? "NEW" : old > rank ? "UP" : old < rank ? "DOWN" : "SAME";
  });
  return rows;
}

export async function scores() {
  const [r1State, r2State] = await Promise.all([getRound1State(), getRound2State()]);
  const cacheKey = `${r1State.version}:${r1State.status}:${r1State.phase}:${(r1State.closed_question_ids || []).join(",")}|${r2State.version}:${r2State.status}:${r2State.phase}:${(r2State.closed_question_ids || []).join(",")}`;

  if (leaderboardCache && leaderboardCache.key === cacheKey && leaderboardCache.generation === cacheGeneration && leaderboardCache.expiresAt > Date.now()) {
    return leaderboardCache.value;
  }

  // Key in-flight calculations by the specific cacheKey and generation
  const existing = inFlightLeaderboard.get(cacheKey);
  if (existing && existing.generation === cacheGeneration) {
    return existing.promise;
  }

  const calculationGen = cacheGeneration;
  let refreshPromise: Promise<Row[]>;

  refreshPromise = (async () => {
    try {
      const rows = await computeScores(r1State, r2State);
      // Cache generation guard: obsolete calculations cannot refill the cache
      if (cacheGeneration === calculationGen) {
        leaderboardCache = { key: cacheKey, generation: calculationGen, value: rows, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return rows;
    } finally {
      // Promise-identity check: do not remove a newer in-flight entry
      const cur = inFlightLeaderboard.get(cacheKey);
      if (cur && cur.promise === refreshPromise && cur.generation === calculationGen) {
        inFlightLeaderboard.delete(cacheKey);
      }
    }
  })();

  inFlightLeaderboard.set(cacheKey, { promise: refreshPromise, generation: calculationGen });
  return refreshPromise;
}

async function persistLeaderboardSnapshot(rows: Row[]) {
  const { error: deleteError } = await db.from("leaderboard_snapshot").delete().neq("team_id", "00000000-0000-0000-0000-000000000000");
  if (deleteError) throw new ApiError(500, deleteError.message);
  if (!rows.length) return;
  const { error: insertError } = await db.from("leaderboard_snapshot").insert(rows.map((row) => ({ ...row, updated_at: new Date().toISOString() })));
  if (insertError) throw new ApiError(500, insertError.message);
}

function asQuestionBody(body: Row) {
  const round = Number(body.round);
  if (round === 2) {
    const text = requiredString(body.text, "text");
    const rawAnswer = requiredString(body.correct_answer, "correct_answer").trim().toUpperCase();
    if (!["BUY", "SELL"].includes(rawAnswer)) {
      throw new ApiError(422, "Round 2 correct answer must be BUY or SELL");
    }
    const limit = Number(body.time_limit ?? 120);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ApiError(422, "Question duration must be a positive integer");
    }
    return {
      round: 2,
      text,
      options: ["BUY", "SELL", "NO_TRADE"],
      correct_answer: rawAnswer,
      base_points: 1,
      time_limit: limit,
      asset: body.asset ?? null,
      timeframe: body.timeframe ?? null,
      chart_image_url: null,
      question_order: Number(body.order ?? body.question_order ?? 0),
    };
  }

  return {
    round: Number(body.round),
    text: body.text ?? null,
    options: body.options || [],
    correct_answer: requiredString(body.correct_answer, "correct_answer"),
    base_points: Number(body.base_points ?? 100),
    time_limit: Number(body.time_limit ?? 30),
    asset: body.asset ?? null,
    timeframe: body.timeframe ?? null,
    chart_image_url: body.chart_image_url ?? null,
    question_order: Number(body.order ?? body.question_order ?? 0),
  };
}

// Edit lock preventing mutation or round re-assignment of R1 or R2 questions during active/paused round
export async function assertRoundNotActive(targetRound?: number, questionId?: string) {
  if (targetRound === 1 || questionId) {
    const r1 = await getRound1State();
    const isR1ActiveOrPaused = r1.status === "ACTIVE" || r1.status === "COUNTDOWN" || r1.is_paused || (r1.status === "PAUSED");
    if (isR1ActiveOrPaused) {
      if (targetRound === 1) {
        throw new ApiError(400, "Cannot modify Round 1 questions while Round 1 is active or paused");
      }
      if (questionId) {
        const existing = await one("questions", { id: questionId });
        if (existing && Number(existing.round) === 1) {
          throw new ApiError(400, "Cannot modify or reassign a Round 1 question while Round 1 is active or paused");
        }
      }
    }
  }

  if (targetRound === 2 || questionId) {
    const r2 = await getRound2State();
    const isR2ActiveOrPaused = r2.status === "ACTIVE" || r2.status === "COUNTDOWN" || r2.is_paused || (r2.status === "PAUSED");
    if (isR2ActiveOrPaused) {
      if (targetRound === 2) {
        throw new ApiError(400, "Cannot modify Round 2 questions while Round 2 is active or paused");
      }
      if (questionId) {
        const existing = await one("questions", { id: questionId });
        if (existing && Number(existing.round) === 2) {
          throw new ApiError(400, "Cannot modify or reassign a Round 2 question while Round 2 is active or paused");
        }
      }
    }
  }
}
export const assertRound1NotActive = assertRoundNotActive;

export async function handle(request: Request) {
  const url = new URL(request.url);
  const functionMarker = "/market-api";
  const markerIndex = url.pathname.lastIndexOf(functionMarker);
  let path = markerIndex >= 0 ? url.pathname.slice(markerIndex + functionMarker.length) : url.pathname;
  if (!path.startsWith("/api")) path = `/api${path === "/" ? "/" : path}`;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/") return publicJson(request, { service: "Market Masters Supabase API", ok: true, database: "supabase" });

  if (method === "POST" && path === "/api/auth/register-team") {
    const body = await readBody(request);
    const cfg = await config();
    if (!cfg.registration_open) throw new ApiError(400, "Registration is closed");
    const email = requiredString(body.leader_email, "leader_email").toLowerCase();
    const teamName = requiredString(body.team_name, "team_name");
    if (!Array.isArray(body.members)) body.members = [];
    if (await one("teams", { team_name: teamName })) throw new ApiError(400, "Team name already taken");
    const existing = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existing.data) throw new ApiError(400, "Email already registered");
    const leaderName = requiredString(body.leader_name, "leader_name");
    const college = requiredString(body.college, "college");

    // Require exactly 10 ASCII digits, using string representation and preserving leading zeros
    const rawPhone = typeof body.leader_phone === "string" ? body.leader_phone.trim() : "";
    if (!/^\d{10}$/.test(rawPhone)) {
      throw new ApiError(422, "Leader phone must be exactly 10 digits");
    }
    const phone = rawPhone;

    const password = requiredString(body.password, "password");
    if (password.length < 6) throw new ApiError(422, "Password must be at least 6 characters");
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: leaderName } });
    if (created.error || !created.data.user) throw new ApiError(400, created.error?.message || "Could not create account");
    const userId = created.data.user.id;
    try {
      const team = await insert("teams", { team_name: teamName, leader_name: leaderName, leader_email: email, leader_phone: phone, college, members: body.members, owner_user_id: userId });
      const profile = await insert("profiles", { id: userId, email, name: leaderName, role: "team", team_id: team.id });
      await audit("register_team", { auth: created.data.user, profile }, { team_id: team.id });
      return json(request, { ok: true, user: profileOut(profile, team) });
    } catch (error) {
      await db.auth.admin.deleteUser(userId);
      throw error;
    }
  }

  if (method === "GET" && path === "/api/auth/me") {
    const user = await currentUser(request);
    const team = user!.profile.team_id ? await one("teams", { id: user!.profile.team_id }) : null;
    return json(request, profileOut(user!.profile, team));
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const user = await currentUser(request);
    await audit("logout", user);
    return json(request, { ok: true });
  }

  if (method === "GET" && path === "/api/event/config") return publicJson(request, await config());

  if (method === "PUT" && path === "/api/event/config") {
    const user = await adminUser(request);
    const body = await readBody(request);
    const allowed = ["event_name", "team_size", "registration_open", "round1_weight", "round2_weight", "round3_weight", "round3_duration_minutes", "max_trades", "starting_capital", "max_risk_per_trade", "performance_weight", "risk_mgmt_weight", "leaderboard_visible", "trade_proof_required", "speed_bonus_pct"];
    const update: Row = {};
    for (const key of allowed) if (body[key] !== undefined) update[key] = body[key];
    if (Object.keys(update).length) {
      const { error } = await db.from("event_config").update(update).eq("id", "event");
      if (error) throw new ApiError(500, error.message);
      invalidateConfigCache();
      invalidateLeaderboardCache();
    }
    await audit("config_update", user, update);
    return json(request, await config());
  }

  const roundState = path.match(/^\/api\/rounds\/(\d+)\/state$/);
  if (method === "POST" && roundState) {
    const user = await adminUser(request);
    const round = Number(roundState[1]);
    if (![1, 2, 3].includes(round)) throw new ApiError(400, "Invalid round");
    const body = await readBody(request);
    const state = requiredString(body.state, "state");
    if (!["UPCOMING", "ACTIVE", "PAUSED", "COMPLETED"].includes(state)) throw new ApiError(400, "Invalid round state");
    const cfg = await config();
    const rounds = structuredClone(cfg.rounds || DEFAULT_CONFIG.rounds);
    const key = String(round);
    const value = rounds[key] || { state: "UPCOMING", started_at: null, ended_at: null };

    if (round === 1) {
      let frozenQuestions: Row[] | null = null;
      if (state === "ACTIVE") {
        const cur = await getRound1State();
        if (!cur.is_paused && cur.status !== "ACTIVE" && cur.status !== "COUNTDOWN") {
          const qs = await all("questions", { round: 1 }, ["question_order", true]);
          if (!qs.length) throw new ApiError(400, "No Round 1 questions configured");
          frozenQuestions = qs.map((q) => ({
            id: q.id,
            round: 1,
            text: q.text,
            options: q.options || [],
            correct_answer: q.correct_answer,
            base_points: Number(q.base_points ?? 100),
            time_limit: Number(q.time_limit ?? 30),
            question_order: Number(q.question_order ?? 0),
            asset: q.asset ?? null,
            timeframe: q.timeframe ?? null,
            chart_image_url: q.chart_image_url ?? null,
          }));
        }
      }

      const { data: rpcData, error: rpcError } = await db.rpc("admin_set_round1_state_tx", {
        p_action: state,
        p_now: new Date().toISOString(),
        p_frozen_questions: frozenQuestions,
        p_speed_bonus: Number(cfg.speed_bonus_pct ?? 0.5),
      });

      if (rpcError) {
        throw new ApiError(500, `Round 1 state change failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && !rpcData.ok) {
        throw new ApiError(400, rpcData.error || "Cannot change Round 1 state");
      }

      invalidateConfigCache();
      invalidateLeaderboardCache();
      await audit(`round1_state_change`, user, { state });
      return json(request, rpcData.round_value || { state });
    }

    if (round === 2) {
      let frozenQuestions: Row[] | null = null;
      let qs: any[] = [];
      if (state === "ACTIVE") {
        const cur = await getRound2State();
        if (!cur.is_paused && cur.status !== "ACTIVE" && cur.status !== "COUNTDOWN") {
          qs = await all("questions", { round: 2 }, ["question_order", true]);
          if (!qs.length) throw new ApiError(400, "No Round 2 questions configured");

          for (const q of qs) {
            const ans = String(q.correct_answer || "").trim().toUpperCase();
            if (ans !== "BUY" && ans !== "SELL") {
              throw new ApiError(400, `Round 2 question "${q.text || q.id}" must have correct answer BUY or SELL`);
            }
            const dur = Number(q.time_limit);
            if (!Number.isInteger(dur) || dur <= 0) {
              throw new ApiError(400, `Round 2 question "${q.text || q.id}" duration must be a positive integer`);
            }
          }

          frozenQuestions = qs.map((q) => ({
            id: q.id,
            round: 2,
            text: q.text,
            options: ["BUY", "SELL", "NO_TRADE"],
            correct_answer: String(q.correct_answer).trim().toUpperCase(),
            base_points: 1,
            time_limit: Number(q.time_limit ?? 120),
            question_order: Number(q.question_order ?? 0),
            asset: q.asset ?? null,
            timeframe: q.timeframe ?? null,
          }));
        }
      }

      const questionDuration = Number(body.question_seconds || body.time_limit || (qs.length ? qs[0].time_limit : 120));

      const { data: rpcData, error: rpcError } = await db.rpc("admin_set_round2_state_tx", {
        p_action: state,
        p_now: new Date().toISOString(),
        p_frozen_questions: frozenQuestions,
        p_question_seconds: questionDuration,
      });

      if (rpcError) {
        throw new ApiError(500, `Round 2 state change failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && !rpcData.ok) {
        throw new ApiError(400, rpcData.error || "Cannot change Round 2 state");
      }

      invalidateConfigCache();
      invalidateLeaderboardCache();
      await audit(`round2_state_change`, user, { state });
      return json(request, rpcData.round_value || { state });
    }

    value.state = state;
    if (state === "ACTIVE" && !value.started_at) value.started_at = new Date().toISOString();
    if (state === "COMPLETED") value.ended_at ||= new Date().toISOString();
    rounds[key] = value;
    const { error } = await db.from("event_config").update({ rounds }).eq("id", "event");
    if (error) throw new ApiError(500, error.message);
    invalidateConfigCache();
    invalidateLeaderboardCache();
    await audit(`round${round}_state_change`, user, { state });
    return json(request, value);
  }

  // Synchronized Round 1 participant status
  if (method === "GET" && path === "/api/rounds/1/status") {
    const user = await currentUser(request);
    const state = await advanceRound1State();
    const cfg = await config();
    const teamId = user!.profile.team_id;

    const now = Date.now();
    let timeLeft = 0;
    if (state.is_paused) {
      timeLeft = Math.max(0, Math.round(Number(state.paused_remaining_ms ?? 0) / 1000));
    } else if (state.phase_ends_at) {
      timeLeft = Math.max(0, Math.round((new Date(state.phase_ends_at).getTime() - now) / 1000));
    }

    let questionData: Row | null = null;
    let teamSubmission: Row = { answered: false };
    let teamScore = 0;
    let standings: Row | null = null;
    let leaderboardRows: Row[] = [];

    const isCurClosed = isQuestionClosed(state, state.current_question_id);

    if (state.current_question_id && (state.phase === "QUESTION" || state.phase === "RESULT")) {
      const q = (state.frozen_questions?.find((x: any) => x.id === state.current_question_id)) || (await one("questions", { id: state.current_question_id }));
      if (q) {
        if (!isCurClosed) {
          // Never leak correct_answer during active or paused question phase
          questionData = {
            id: q.id,
            round: 1,
            text: q.text,
            options: q.options || [],
            base_points: q.base_points,
            time_limit: q.time_limit,
            order: q.question_order,
          };
        } else {
          // Reveal correct_answer in RESULT phase
          questionData = questionOut(q, true);
        }
      }

      if (teamId) {
        const sub = await one("submissions", { team_id: teamId, question_id: state.current_question_id });
        if (sub) {
          if (!isCurClosed) {
            // Never leak correctness, score, or time_taken before the question closes
            teamSubmission = {
              answered: true,
              answer: sub.answer,
              submitted_at: sub.submitted_at,
            };
          } else {
            // Reveal in RESULT phase
            teamSubmission = {
              answered: true,
              answer: sub.answer,
              correct: sub.correct,
              score: sub.score,
              time_taken: sub.time_taken,
              submitted_at: sub.submitted_at,
            };
          }
        }
      }
    }

    // Cumulative team score only sums genuinely closed questions
    if (teamId) {
      const teamSubs = await all("submissions", { team_id: teamId, round: 1 });
      const closedIds = new Set(Array.isArray(state?.closed_question_ids) ? state.closed_question_ids : []);
      teamScore = teamSubs
        .filter((s) => closedIds.has(s.question_id))
        .reduce((sum, s) => sum + Number(s.score || 0), 0);
    }

    // Include full agreed leaderboard in RESULT and COMPLETED phases
    if (state.phase === "RESULT" || state.phase === "COMPLETED") {
      const allSc = await scores();
      if (teamId) {
        const me = allSc.find((s) => s.team_id === teamId);
        if (me) standings = { rank: me.rank, total: me.total, round1: me.round1 };
      }
      leaderboardRows = allSc.slice(0, 10).map((r) => ({
        rank: r.rank,
        team_id: r.team_id,
        team_name: r.team_name,
        college: r.college,
        round1: r.round1,
        total: r.total,
      }));
    }

    return json(request, {
      server_time: new Date().toISOString(),
      status: state.status,
      phase: state.phase,
      is_paused: Boolean(state.is_paused),
      paused_phase: state.pause_phase || null,
      time_left: timeLeft,
      phase_start_at: state.phase_start_at,
      phase_ends_at: state.phase_ends_at,
      question_index: state.current_question_index,
      total_questions: state.total_questions,
      countdown_seconds: state.countdown_seconds || 10,
      result_seconds: state.result_seconds || 10,
      question: questionData,
      team_submission: teamSubmission,
      team_score: teamScore,
      standings,
      leaderboard: leaderboardRows,
      round_state: cfg.rounds?.["1"]?.state || "UPCOMING",
    });
  }

  // Synchronized Round 2 participant status
  if (method === "GET" && path === "/api/rounds/2/status") {
    const user = await currentUser(request);
    const state = await advanceRound2State();
    const cfg = await config();
    const teamId = user!.profile.team_id;

    const now = Date.now();
    let timeLeft = 0;
    if (state.is_paused) {
      timeLeft = Math.max(0, Math.round(Number(state.paused_remaining_ms ?? 0) / 1000));
    } else if (state.phase_ends_at) {
      timeLeft = Math.max(0, Math.round((new Date(state.phase_ends_at).getTime() - now) / 1000));
    }

    let questionData: Row | null = null;
    let teamSubmission: Row = { answered: false };
    let teamScore = 0;
    let standings: Row | null = null;
    let leaderboardRows: Row[] = [];

    const isCurClosed = isRound2QuestionClosed(state, state.current_question_id);

    if (state.current_question_id && (state.phase === "QUESTION" || state.phase === "RESULT")) {
      const q = (state.frozen_questions?.find((x: any) => x.id === state.current_question_id)) || (await one("questions", { id: state.current_question_id }));
      if (q) {
        if (!isCurClosed) {
          // Never leak correct_answer during active or paused question phase
          // R2 participant displays only the current question, options, explanation field and shared timer.
          questionData = {
            id: q.id,
            round: 2,
            text: q.text,
            options: ["BUY", "SELL", "NO_TRADE"],
            base_points: 1,
            time_limit: q.time_limit || state.question_seconds || 120,
            order: q.question_order,
            asset: q.asset,
            timeframe: q.timeframe,
          };
        } else {
          // Reveal correct_answer in RESULT phase
          questionData = {
            id: q.id,
            round: 2,
            text: q.text,
            options: ["BUY", "SELL", "NO_TRADE"],
            correct_answer: q.correct_answer,
            base_points: 1,
            time_limit: q.time_limit || state.question_seconds || 120,
            order: q.question_order,
            asset: q.asset,
            timeframe: q.timeframe,
          };
        }
      }

      if (teamId) {
        const sub = await one("submissions", { team_id: teamId, question_id: state.current_question_id });
        if (sub) {
          if (!isCurClosed) {
            // Never leak correctness, score, or time_taken before the question closes
            teamSubmission = {
              answered: true,
              answer: sub.answer,
              explanation: sub.explanation,
              submitted_at: sub.submitted_at,
            };
          } else {
            // Reveal in RESULT phase
            teamSubmission = {
              answered: true,
              answer: sub.answer,
              explanation: sub.explanation,
              correct: sub.correct,
              score: sub.score,
              time_taken: sub.time_taken,
              submitted_at: sub.submitted_at,
            };
          }
        }
      }
    }

    // Cumulative team score only sums genuinely closed R2 questions unless overridden by admin
    if (teamId) {
      const teamSubs = await all("submissions", { team_id: teamId, round: 2 });
      const closedIds = new Set(Array.isArray(state?.closed_question_ids) ? state.closed_question_ids : []);
      teamScore = teamSubs
        .filter((s) => closedIds.has(s.question_id))
        .reduce((sum, s) => sum + Number(s.score || 0), 0);

      const override = await one("score_overrides", { team_id: teamId, round: 2 });
      if (override) {
        teamScore = Number(override.new_score);
      }
    }

    // Include full agreed leaderboard in RESULT and COMPLETED phases
    if (state.phase === "RESULT" || state.phase === "COMPLETED") {
      const allSc = await scores();
      if (teamId) {
        const me = allSc.find((s) => s.team_id === teamId);
        if (me) {
          standings = {
            rank: cfg.leaderboard_visible ? me.rank : null,
            total: me.total,
            round2: me.round2,
          };
          teamScore = me.round2;
        }
      }
      if (cfg.leaderboard_visible) {
        leaderboardRows = allSc.slice(0, 10).map((r) => ({
          rank: r.rank,
          team_id: r.team_id,
          team_name: r.team_name,
          college: r.college,
          round2: r.round2,
          total: r.total,
        }));
      } else {
        leaderboardRows = [];
      }
    }

    return json(request, {
      server_time: new Date().toISOString(),
      status: state.status,
      phase: state.phase,
      is_paused: Boolean(state.is_paused),
      paused_phase: state.pause_phase || null,
      time_left: timeLeft,
      phase_start_at: state.phase_start_at,
      phase_ends_at: state.phase_ends_at,
      question_index: state.current_question_index,
      total_questions: state.total_questions,
      countdown_seconds: state.countdown_seconds || 10,
      question_seconds: state.question_seconds || 120,
      result_seconds: state.result_seconds || 10,
      question: questionData,
      team_submission: teamSubmission,
      team_score: teamScore,
      standings,
      leaderboard: leaderboardRows,
      round_state: cfg.rounds?.["2"]?.state || "UPCOMING",
    });
  }

  if (method === "GET" && path === "/api/questions") {
    const user = await currentUser(request);
    const round = Number(url.searchParams.get("round"));
    if (![1, 2].includes(round)) throw new ApiError(422, "round must be 1 or 2");

    // Prevent non-admin users from fetching the full Round 1 or Round 2 question list
    if ([1, 2].includes(round) && user!.profile.role !== "admin") {
      throw new ApiError(403, `Round ${round} questions are synchronized. Use /rounds/${round}/status`);
    }

    const rows = await all("questions", { round }, ["question_order", true]);
    return json(request, rows.map((row) => questionOut(row, user!.profile.role === "admin")));
  }

  if (method === "POST" && path === "/api/questions") {
    const user = await adminUser(request);
    const body = await readBody(request);
    await assertRoundNotActive(Number(body.round));
    const row = await insert("questions", asQuestionBody(body));
    await audit("question_create", user, { id: row.id, round: row.round });
    return json(request, questionOut(row, true));
  }

  const questionId = path.match(/^\/api\/questions\/([^/]+)$/);
  if (method === "PUT" && questionId) {
    const user = await adminUser(request);
    const body = await readBody(request);
    const existing = await one("questions", { id: questionId[1] });
    if (!existing) throw new ApiError(404, "Question not found");
    const round = Number(body.round ?? existing.round);
    await assertRoundNotActive(round, questionId[1]);
    const update = asQuestionBody({ ...body, round });
    const { data, error } = await db.from("questions").update(update).eq("id", questionId[1]).select().maybeSingle();
    if (error) throw new ApiError(500, error.message);
    if (!data) throw new ApiError(404, "Question not found");
    await audit("question_update", user, { id: questionId[1] });
    return json(request, questionOut(data, true));
  }

  if (method === "DELETE" && questionId) {
    const user = await adminUser(request);
    await assertRoundNotActive(undefined, questionId[1]);
    await db.from("questions").delete().eq("id", questionId[1]);
    await audit("question_delete", user, { id: questionId[1] });
    return json(request, { ok: true });
  }

  // Synchronized Round 1 submit - Single execution path via atomic database procedure
  if (method === "POST" && path === "/api/rounds/1/submit") {
    const user = await teamUser(request);
    const cfg = await config();
    if (cfg.results_finalized) {
      throw new ApiError(400, "Results are finalized. Submissions are closed.");
    }
    if (cfg.rounds?.["1"]?.state !== "ACTIVE") {
      throw new ApiError(400, "Round 1 is not active");
    }

    const state = await advanceRound1State();
    if (state.is_paused) throw new ApiError(400, "Round 1 is paused");
    if (state.status !== "ACTIVE" || state.phase !== "QUESTION") {
      throw new ApiError(400, "Question is not currently open");
    }

    const body = await readBody(request);
    const questionIdValue = requiredString(body.question_id, "question_id");
    if (state.current_question_id !== questionIdValue) {
      throw new ApiError(400, "Question is not currently active");
    }

    // Server-side deadline check using server time
    if (state.phase_ends_at && Date.now() >= new Date(state.phase_ends_at).getTime()) {
      throw new ApiError(400, "Question deadline has expired");
    }

    const answer = requiredString(body.answer, "answer").toUpperCase();

    // Single R1 submission path: Atomic database stored procedure (runs with service_role privileges)
    const { data: rpcData, error: rpcError } = await db.rpc("submit_round1_answer", {
      p_team_id: user.profile.team_id,
      p_question_id: questionIdValue,
      p_answer: answer,
    });

    if (rpcError) {
      if (rpcError.code === "42883" || rpcError.code === "42P01" || rpcError.message?.includes("does not exist")) {
        throw new ApiError(500, "Round 1 database procedure 'submit_round1_answer' is not initialized. Please apply migration 202610250007_market_masters_synchronized_round1.sql.");
      }
      throw new ApiError(500, `Database error during submission: ${rpcError.message}`);
    }

    if (!rpcData) {
      throw new ApiError(500, "No response returned from submission procedure");
    }

    if (!rpcData.ok) {
      if (rpcData.code === "ALREADY_SUBMITTED" || rpcData.error === "Already submitted") {
        throw new ApiError(409, "Already submitted");
      }
      if (rpcData.code === "DEADLINE_EXPIRED") {
        throw new ApiError(400, "Question deadline has expired");
      }
      if (rpcData.code === "NOT_OPEN" || rpcData.code === "NOT_ACTIVE") {
        throw new ApiError(400, rpcData.error || "Question is not currently open");
      }
      if (rpcData.code === "NOT_OPEN_YET") {
        throw new ApiError(400, "Question has not opened yet");
      }
      if (rpcData.code === "INVALID_TIMING") {
        throw new ApiError(400, "Question timing is invalid");
      }
      throw new ApiError(400, rpcData.error || "Submission rejected");
    }

    invalidateLeaderboardCache();
    await audit("round1_submit", user, { question_id: questionIdValue, submission_id: rpcData.submission_id });

    // During QUESTION: Return strictly submission acknowledgement and accepted answer.
    // Reveal correctness and points only after the shared deadline (via /rounds/1/status or /scores/me).
    return json(request, {
      ok: true,
      submission_id: rpcData.submission_id,
      answer,
    });
  }

  // Synchronized Round 2 submit - Transactional RPC enforcing write lock and results_finalized
  if (method === "POST" && path === "/api/rounds/2/submit") {
    const user = await teamUser(request);
    const body = await readBody(request);
    const questionIdValue = requiredString(body.question_id, "question_id");
    const rawAnswer = String(body.answer ?? "").trim().toUpperCase();
    const rawExplanation = typeof body.explanation === "string" ? body.explanation.trim() : "";

    // Let the transactional database procedure authoritatively enforce current round, pause, finalization, deadline state, and option/explanation validation
    const { data: rpcData, error: rpcError } = await db.rpc("submit_round2_answer_tx", {
      p_team_id: user.profile.team_id,
      p_question_id: questionIdValue,
      p_answer: rawAnswer,
      p_explanation: rawExplanation,
    });

    if (rpcError) {
      if (rpcError.code === "42883" || rpcError.code === "42P01" || rpcError.message?.includes("does not exist")) {
        throw new ApiError(500, "Round 2 database procedure 'submit_round2_answer_tx' is not initialized. Please apply migration 202610250010_market_masters_round2_fixes.sql.");
      }
      throw new ApiError(500, `Round 2 submission failed: ${rpcError.message || rpcError}`);
    }
    if (!rpcData) {
      throw new ApiError(500, "No response returned from submission procedure");
    }
    if (!rpcData.ok) {
      if (rpcData.code === "ALREADY_SUBMITTED" || rpcData.error === "Already submitted") {
        throw new ApiError(409, "Already submitted");
      }
      if (rpcData.code === "DEADLINE_EXPIRED") {
        throw new ApiError(400, "Question deadline has expired");
      }
      if (rpcData.code === "ROUND_PAUSED") {
        throw new ApiError(400, "Round 2 is paused");
      }
      if (rpcData.code === "NOT_OPEN" || rpcData.code === "NOT_ACTIVE") {
        throw new ApiError(400, rpcData.error || "Question is not currently open");
      }
      if (rpcData.code === "NOT_OPEN_YET") {
        throw new ApiError(400, "Question has not opened yet");
      }
      if (rpcData.code === "FINALIZED") {
        throw new ApiError(400, "Results are finalized. Submissions are closed.");
      }
      if (rpcData.code === "QUESTION_MISMATCH") {
        throw new ApiError(400, "Question is not currently active");
      }
      if (rpcData.code === "INVALID_OPTION" || rpcData.code?.startsWith("EXPLANATION_")) {
        throw new ApiError(422, rpcData.error || "Invalid submission parameters");
      }
      throw new ApiError(400, rpcData.error || "Submission failed");
    }

    invalidateLeaderboardCache();
    await audit("round2_submit", user, { question_id: questionIdValue, submission_id: rpcData.submission_id });

    // During QUESTION: Return strictly submission acknowledgement and accepted answer & explanation
    return json(request, {
      ok: true,
      submission_id: rpcData.submission_id,
      answer: rpcData.answer || rawAnswer,
      explanation: rpcData.explanation || rawExplanation,
    });
  }

  const mySubmissions = path.match(/^\/api\/rounds\/(\d+)\/my-submissions$/);
  if (method === "GET" && mySubmissions) {
    const user = await teamUser(request);
    const round = Number(mySubmissions[1]);
    const rows = await all("submissions", { team_id: user.profile.team_id, round }, ["submitted_at", true]);
    if (round === 1) {
      const r1State = await getRound1State();
      // Mask any question that is not yet genuinely closed (including paused or unfinished questions)
      const closedIds = new Set(Array.isArray(r1State?.closed_question_ids) ? r1State.closed_question_ids : []);
      return json(request, rows.map((r) => {
        if (!closedIds.has(r.question_id)) {
          return { ...r, correct: null, score: null, time_taken: null };
        }
        return r;
      }));
    }
    if (round === 2) {
      const r2State = await getRound2State();
      // Mask any question that is not yet genuinely closed (including paused or unfinished questions)
      const closedIds = new Set(Array.isArray(r2State?.closed_question_ids) ? r2State.closed_question_ids : []);
      return json(request, rows.map((r) => {
        if (!closedIds.has(r.question_id)) {
          return { ...r, correct: null, score: null, time_taken: null };
        }
        return r;
      }));
    }
    return json(request, rows);
  }

  if (method === "POST" && path === "/api/rounds/3/start") {
    const user = await teamUser(request); const cfg = await activeRound(3); let session = await one("round3_sessions", { team_id: user.profile.team_id });
    if (!session) { const start = new Date(); const end = new Date(start.getTime() + Number(cfg.round3_duration_minutes) * 60000); session = await insert("round3_sessions", { team_id: user.profile.team_id, started_at: start.toISOString(), ends_at: end.toISOString(), closed: false }); await audit("round3_start", user); }
    return json(request, { ...session, server_time: new Date().toISOString() });
  }
  if (method === "GET" && path === "/api/rounds/3/status") {
    const user = await teamUser(request); const [session, trades, cfg] = await Promise.all([one("round3_sessions", { team_id: user.profile.team_id }), all("trades", { team_id: user.profile.team_id }, ["trade_number", true]), config()]);
    return json(request, { session: session ? { ...session, server_time: new Date().toISOString() } : null, trades, max_trades: cfg.max_trades, round_state: cfg.rounds?.["3"]?.state || "UPCOMING", starting_capital: cfg.starting_capital, max_risk_per_trade: cfg.max_risk_per_trade, trade_proof_required: cfg.trade_proof_required });
  }
  if (method === "POST" && path === "/api/rounds/3/trades") {
    const user = await teamUser(request);
    const body = await readBody(request);
    const resultType = requiredString(body.result_type, "result_type").toUpperCase();
    const profit = Number(body.profit || 0);
    const loss = Number(body.loss || 0);
    const pl = Number(body.pl_percentage);
    const risk = Number(body.risk_per_trade);
    if (!Number.isFinite(risk) || risk < 0) throw new ApiError(422, "Risk % must be >= 0");
    if (resultType === "PROFIT" && (profit <= 0 || loss !== 0 || pl <= 0)) throw new ApiError(400, "Profit must be > 0, loss must be 0, and P/L % must be positive for PROFIT");
    if (resultType === "LOSS" && (loss <= 0 || profit !== 0 || pl >= 0)) throw new ApiError(400, "Loss must be > 0, profit must be 0, and P/L % must be negative for LOSS");
    if (!["PROFIT", "LOSS"].includes(resultType)) throw new ApiError(422, "Invalid result_type");
    const asset = requiredString(body.asset, "asset");
    const accountSize = Number(body.account_size);

    const { data: rpcData, error: rpcError } = await db.rpc("submit_round3_trade_tx", {
      p_team_id: user.profile.team_id,
      p_asset: asset,
      p_account_size: accountSize,
      p_risk_per_trade: risk,
      p_result_type: resultType,
      p_profit: profit,
      p_loss: loss,
      p_pl_percentage: pl,
      p_proof_url: body.proof_url || null,
    });

    if (rpcError) {
      throw new ApiError(500, `Round 3 trade submission failed: ${rpcError.message || rpcError}`);
    }
    if (rpcData && !rpcData.ok) {
      if (rpcData.code === "FINALIZED") throw new ApiError(400, "Results are finalized. Submissions are closed.");
      if (rpcData.code === "NOT_ACTIVE") throw new ApiError(400, "Round 3 is not active");
      if (rpcData.code === "NO_SESSION") throw new ApiError(400, "Start Round 3 first");
      if (rpcData.code === "SESSION_CLOSED") throw new ApiError(400, "Round 3 window has closed");
      if (rpcData.code === "TRADE_LIMIT") throw new ApiError(400, "Trade limit reached");
      throw new ApiError(400, rpcData.error || "Trade submission failed");
    }

    invalidateLeaderboardCache();
    await audit("round3_trade_submit", user, { trade_number: rpcData.trade.trade_number, asset: rpcData.trade.asset });
    return json(request, rpcData.trade);
  }
  if (method === "POST" && path === "/api/rounds/3/close") { const user = await teamUser(request); await db.from("round3_sessions").update({ closed: true }).eq("team_id", user.profile.team_id); await audit("round3_close", user); return json(request, { ok: true }); }

  if (method === "GET" && path === "/api/leaderboard") { const cfg = await config(); if (!cfg.leaderboard_visible) return publicJson(request, { visible: false, rows: [] }); return publicJson(request, { visible: true, rows: await scores() }); }
  if (method === "GET" && path === "/api/scores/me") { const user = await teamUser(request); const row = (await scores()).find((item) => item.team_id === user.profile.team_id); return json(request, row || { rank: null, total: 0 }); }

  const verifyPath = path.match(/^\/api\/admin\/trades\/([^/]+)\/verify$/);
  if (method === "POST" && verifyPath) {
    const user = await adminUser(request);
    const body = await readBody(request);
    const status = requiredString(body.status, "status").toUpperCase();
    if (!["VERIFIED", "REJECTED"].includes(status) || (status === "REJECTED" && !body.reason)) {
      throw new ApiError(400, "Valid status and rejection reason are required");
    }

    const { data: rpcData, error: rpcError } = await db.rpc("admin_verify_trade_tx", {
      p_trade_id: verifyPath[1],
      p_status: status,
      p_reason: body.reason || null,
    });

    if (rpcError) {
      throw new ApiError(500, `Trade verification failed: ${rpcError.message || rpcError}`);
    }
    if (rpcData && !rpcData.ok) {
      if (rpcData.code === "FINALIZED") throw new ApiError(400, "Results are finalized. Reopen results before modifying trades.");
      if (rpcData.code === "NOT_FOUND") throw new ApiError(404, "Trade not found");
      throw new ApiError(400, rpcData.error || "Trade verification failed");
    }

    invalidateLeaderboardCache();
    await audit("trade_verify", user, { trade_id: verifyPath[1], status });
    return json(request, rpcData.trade);
  }
  if (method === "GET" && path === "/api/admin/trades") { await adminUser(request); const status = url.searchParams.get("status"); const trades = await all("trades", status ? { verification_status: status.toUpperCase() } : {}, ["submitted_at", false]); const teams = await all("teams"); const names = new Map(teams.map((team) => [team.id, team.team_name])); return json(request, trades.map((trade) => ({ ...trade, team_name: names.get(trade.team_id) || "Unknown" }))); }
  if (method === "GET" && path === "/api/admin/teams") { await adminUser(request); return json(request, await all("teams", {}, ["created_at", false])); }

  if (method === "POST" && path === "/api/admin/score-override") {
    const user = await adminUser(request);
    const body = await readBody(request);
    const teamId = requiredString(body.team_id, "team_id");
    const round = Number(body.round);
    const newScore = Number(body.new_score);
    const reason = requiredString(body.reason, "reason");

    const { data: rpcData, error: rpcError } = await db.rpc("admin_set_score_override_tx", {
      p_team_id: teamId,
      p_round: round,
      p_new_score: newScore,
      p_reason: reason,
      p_now: new Date().toISOString(),
    });

    if (rpcError) {
      throw new ApiError(500, `Score override failed: ${rpcError.message || rpcError}`);
    }
    if (rpcData && !rpcData.ok) {
      if (rpcData.code === "FINALIZED") throw new ApiError(400, "Results are finalized. Reopen results before modifying scores.");
      throw new ApiError(400, rpcData.error || "Score override failed");
    }

    invalidateLeaderboardCache();
    await audit("score_override", user, { team_id: teamId, round, new_score: newScore, reason });
    return json(request, { ok: true });
  }

  const deleteTeamPath = path.match(/^\/api\/admin\/teams\/([^/]+)$/);
  if (method === "DELETE" && deleteTeamPath) {
    const user = await adminUser(request);

    const { data: rpcData, error: rpcError } = await db.rpc("admin_delete_team_tx", {
      p_team_id: deleteTeamPath[1],
    });

    if (rpcError) {
      throw new ApiError(500, `Team deletion failed: ${rpcError.message || rpcError}`);
    }
    if (rpcData && !rpcData.ok) {
      if (rpcData.code === "FINALIZED") throw new ApiError(400, "Results are finalized. Reopen results before deleting teams.");
      if (rpcData.code === "NOT_FOUND") throw new ApiError(404, "Team not found");
      throw new ApiError(400, rpcData.error || "Team deletion failed");
    }

    await db.auth.admin.deleteUser(rpcData.owner_user_id);
    invalidateLeaderboardCache();
    await audit("team_delete", user, { team_id: deleteTeamPath[1], team_name: rpcData.team_name });
    return json(request, { ok: true });
  }
  const deleteTradePath = path.match(/^\/api\/admin\/trades\/([^/]+)$/);
  if (method === "DELETE" && deleteTradePath) {
    const user = await adminUser(request);

    const { data: rpcData, error: rpcError } = await db.rpc("admin_delete_trade_tx", {
      p_trade_id: deleteTradePath[1],
    });

    if (rpcError) {
      throw new ApiError(500, `Trade deletion failed: ${rpcError.message || rpcError}`);
    }
    if (rpcData && !rpcData.ok) {
      if (rpcData.code === "FINALIZED") throw new ApiError(400, "Results are finalized. Reopen results before deleting trades.");
      if (rpcData.code === "NOT_FOUND") throw new ApiError(404, "Trade not found");
      throw new ApiError(400, rpcData.error || "Trade deletion failed");
    }

    invalidateLeaderboardCache();
    await audit("trade_delete", user, { trade_id: rpcData.trade_id, team_id: rpcData.team_id });
    return json(request, { ok: true });
  }

  if (method === "POST" && path === "/api/admin/event/action") {
    const user = await adminUser(request);
    const action = requiredString((await readBody(request)).action, "action");
    if (!["start", "stop", "reset", "finalize", "reopen"].includes(action)) throw new ApiError(400, "action must be start | stop | reset | finalize | reopen");

    const nowIso = new Date().toISOString();

    if (action === "start") {
      const { data: rpcData, error: rpcError } = await db.rpc("admin_start_event_tx", { p_now: nowIso });
      if (rpcError) {
        throw new ApiError(500, `Start event failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && !rpcData.ok) {
        throw new ApiError(400, rpcData.error || "Cannot start event");
      }
    }

    if (action === "stop") {
      // Transactional Stop Event: stops R1 and event_config in a single transaction
      const { data: rpcData, error: rpcError } = await db.rpc("admin_stop_event_tx", { p_now: nowIso });
      if (rpcError) {
        throw new ApiError(500, `Stop event failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && rpcData.error) {
        throw new ApiError(500, `Stop event failed: ${rpcData.error}`);
      }
    }

    if (action === "finalize") {
      // Transactional finalization RPC with consistent lock order (round1_state then event_config)
      const { data: rpcData, error: rpcError } = await db.rpc("admin_finalize_results_tx");
      if (rpcError) {
        throw new ApiError(500, `Finalize results failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && !rpcData.ok) {
        throw new ApiError(400, rpcData.error || "Cannot finalize results");
      }
    }

    if (action === "reopen") {
      // Transactional reopen results RPC with consistent lock order
      const { data: rpcData, error: rpcError } = await db.rpc("admin_reopen_results_tx");
      if (rpcError) {
        throw new ApiError(500, `Reopen results failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && !rpcData.ok) {
        throw new ApiError(400, rpcData.error || "Cannot reopen results");
      }
    }

    if (action === "reset") {
      // Transactional Reset: deletes gameplay data and resets state in a single transaction
      const { data: rpcData, error: rpcError } = await db.rpc("admin_reset_gameplay_tx", { p_now: nowIso });
      if (rpcError) {
        throw new ApiError(500, `Reset gameplay failed: ${rpcError.message || rpcError}`);
      }
      if (rpcData && rpcData.error) {
        throw new ApiError(500, `Reset gameplay failed: ${rpcData.error}`);
      }
    }

    invalidateConfigCache();
    invalidateLeaderboardCache();
    await audit(`event_${action}`, user);
    return json(request, await config());
  }

  if (method === "GET" && path === "/api/announcements") return publicJson(request, await all("announcements", {}, ["created_at", false]));
  if (method === "POST" && path === "/api/announcements") { const user = await adminUser(request); const message = requiredString((await readBody(request)).message, "message"); const row = await insert("announcements", { message }); await audit("announcement", user, { message }); return json(request, row); }
  if (method === "GET" && path === "/api/admin/audit-logs") { await adminUser(request); return json(request, (await all("audit_logs", {}, ["timestamp", false])).slice(0, 200)); }
  if (method === "GET" && path === "/api/admin/analytics") {
    await adminUser(request); const [teams, r1, r2, trades, sessions, rows] = await Promise.all([all("teams"), all("submissions", { round: 1 }), all("submissions", { round: 2 }), all("trades"), all("round3_sessions", { closed: false }), scores()]); await persistLeaderboardSnapshot(rows); const valid = trades.filter((trade) => trade.verification_status !== "REJECTED"); const returns = valid.map((trade) => Number(trade.pl_percentage || 0)); return json(request, { total_teams: teams.length, r1_submissions: r1.length, r2_submissions: r2.length, trades_total: trades.length, trade_1: trades.filter((t) => t.trade_number === 1).length, trade_2: trades.filter((t) => t.trade_number === 2).length, pending_verification: trades.filter((t) => t.verification_status === "PENDING").length, verified: trades.filter((t) => t.verification_status === "VERIFIED").length, rejected: trades.filter((t) => t.verification_status === "REJECTED").length, active_round3_sessions: sessions.length, avg_return_pct: returns.length ? Number((returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2)) : 0, best_return_pct: returns.length ? Math.max(...returns) : 0, best_risk_score: Math.max(0, ...rows.map((row) => row.risk_score)) });
  }

  if (method === "GET" && path === "/api/admin/round2/explanations") {
    await adminUser(request);
    const subs = await all("submissions", { round: 2 }, ["submitted_at", false]);
    const [teams, questions] = await Promise.all([all("teams"), all("questions", { round: 2 })]);
    const teamMap = new Map(teams.map((t) => [t.id, t.team_name]));
    const qMap = new Map(questions.map((q) => [q.id, q]));
    const rows = subs.map((s) => {
      const q = qMap.get(s.question_id);
      return {
        id: s.id,
        team_id: s.team_id,
        team_name: teamMap.get(s.team_id) || "Unknown",
        question_id: s.question_id,
        question_order: q?.question_order ?? 0,
        question_text: q?.text ?? "",
        decision: s.answer,
        correct_answer: q?.correct_answer ?? "",
        correct: s.correct,
        score: s.score,
        explanation: s.explanation || "",
        submitted_at: s.submitted_at,
      };
    });
    return json(request, rows);
  }

  const exportPath = path.match(/^\/api\/admin\/export\/(teams|round1|round2|round3|leaderboard)$/);
  if (method === "GET" && exportPath) {
    await adminUser(request);
    const kind = exportPath[1];
    if (kind === "round2") {
      const r2State = await getRound2State();
      const closedIds = new Set(Array.isArray(r2State?.closed_question_ids) ? r2State.closed_question_ids : []);
      const subs = await all("submissions", { round: 2 }, ["submitted_at", true]);
      const [teams, questions] = await Promise.all([all("teams"), all("questions", { round: 2 })]);
      const teamMap = new Map(teams.map((t) => [t.id, t.team_name]));
      const qMap = new Map(questions.map((q) => [q.id, q]));
      const rows = subs.map((s) => {
        const q = qMap.get(s.question_id);
        const isClosed = closedIds.has(s.question_id);
        return {
          submission_id: s.id,
          team_id: s.team_id,
          team_name: teamMap.get(s.team_id) || "Unknown",
          question_id: s.question_id,
          question_order: q?.question_order ?? 0,
          question_text: q?.text ?? "",
          asset: q?.asset ?? "",
          timeframe: q?.timeframe ?? "",
          decision: s.answer,
          correct_answer: q?.correct_answer ?? "",
          correct: isClosed ? s.correct : null,
          score: isClosed ? s.score : 0,
          explanation: s.explanation || "",
          time_taken: s.time_taken,
          submitted_at: s.submitted_at,
        };
      });
      return csv(request, rows, "round2.csv");
    }
    const rows = kind === "teams" ? await all("teams") : kind === "round1" ? await all("submissions", { round: 1 }) : kind === "round3" ? await all("trades") : await scores();
    return csv(request, rows, `${kind}.csv`);
  }

  throw new ApiError(404, "Route not found");
}

if (typeof Deno !== "undefined" && (Deno as any).serve) {
  (Deno as any).serve(async (request: Request) => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: jsonHeaders(request) });
    try { return await handle(request); }
    catch (error) { console.error(error); return json(request, { detail: error instanceof ApiError ? error.message : "Unexpected server error" }, error instanceof ApiError ? error.status : 500); }
  });
}
