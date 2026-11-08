const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const envPath = path.resolve(__dirname, ".env.local");
let url = "";
let servKey = "";
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) url = trimmed.split("=")[1].replace(/"/g, "").trim();
    if (trimmed.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) servKey = trimmed.split("=")[1].replace(/"/g, "").trim();
  });
}

const client = createClient(url, servKey);

async function check() {
  const { data, error } = await client.from("payments").select("payment_attempt_id, idempotency_auth_capture, honor_period_expires_at").limit(1);
  if (error) {
    console.log("STATUS: MIGRATION_PENDING -> " + error.message);
  } else {
    console.log("STATUS: MIGRATION_APPLIED -> All Phase 6.3 columns verified on live database!");
  }
}

check();
