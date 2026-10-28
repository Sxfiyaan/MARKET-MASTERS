/**
 * =============================================================================
 * Script: scripts/seed_round2_sample_questions.mjs
 * Description:
 * Helper script to execute scripts/seed_round2_sample_questions.sql against the local
 * Supabase container (supabase_db_market-masters-supabase).
 *
 * NOTE:
 * These sample questions are strictly for local development and practice runs.
 * They are NOT organizer-approved event questions.
 * =============================================================================
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTAINER = "supabase_db_market-masters-supabase";
const SQL_PATH = path.join(__dirname, "seed_round2_sample_questions.sql");

if (!fs.existsSync(SQL_PATH)) {
  console.error(`SQL file not found at ${SQL_PATH}`);
  process.exit(1);
}

const sql = fs.readFileSync(SQL_PATH, "utf8");

const proc = spawn("docker", [
  "exec",
  "-i",
  CONTAINER,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1"
]);

proc.stdin.write(sql);
proc.stdin.end();

let stdout = "";
let stderr = "";
proc.stdout.on("data", (d) => (stdout += d));
proc.stderr.on("data", (d) => (stderr += d));

proc.on("close", (code) => {
  if (code !== 0) {
    console.error(`Failed to seed sample questions (exit ${code}):`, stderr || stdout);
    process.exit(code);
  }
  console.log("Successfully seeded sample Round 2 practice questions into local database.");
});
