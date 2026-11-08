const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Read .env.local cleanly
const envPath = path.resolve(__dirname, ".env.local");
const envVars = {};
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      envVars[k] = v;
    }
  });
}

const supabaseUrl = envVars["NEXT_PUBLIC_SUPABASE_URL"];
const serviceKey = envVars["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE credentials in .env.local");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runLiveDatabaseAudit() {
  console.log("==================================================================");
  console.log("  GENUINE LIVE SUPABASE SCHEMA & RECORD AUDIT");
  console.log("  Target: " + supabaseUrl);
  console.log("==================================================================\n");

  const results = {
    paymentsTableExists: false,
    paymentsColumns: [],
    paymentsRowCount: 0,
    paymentsStatusesPresent: [],
    milestonesTableExists: false,
    milestonesColumns: [],
    milestonesRowCount: 0,
    milestonesPaymentStatusesPresent: [],
    liveAuditErrors: [],
  };

  // 1. Inspect payments table live
  try {
    const { data: paymentsRows, error: pErr } = await admin
      .from("payments")
      .select("*")
      .limit(10);

    if (pErr) {
      results.liveAuditErrors.push("payments select error: " + pErr.message);
    } else {
      results.paymentsTableExists = true;
      results.paymentsRowCount = paymentsRows.length;
      if (paymentsRows.length > 0) {
        results.paymentsColumns = Object.keys(paymentsRows[0]);
        results.paymentsStatusesPresent = [...new Set(paymentsRows.map((r) => r.status))];
      }
    }
  } catch (err) {
    results.liveAuditErrors.push("payments exception: " + err.message);
  }

  // 2. Count total rows in payments
  try {
    const { count, error: countErr } = await admin
      .from("payments")
      .select("*", { count: "exact", head: true });
    if (!countErr) {
      results.paymentsRowCount = count || 0;
    }
  } catch (err) {
    results.liveAuditErrors.push("payments count exception: " + err.message);
  }

  // 3. Inspect milestones table live
  try {
    const { data: milestonesRows, error: mErr } = await admin
      .from("milestones")
      .select("*")
      .limit(10);

    if (mErr) {
      results.liveAuditErrors.push("milestones select error: " + mErr.message);
    } else {
      results.milestonesTableExists = true;
      results.milestonesRowCount = milestonesRows.length;
      if (milestonesRows.length > 0) {
        results.milestonesColumns = Object.keys(milestonesRows[0]);
        results.milestonesPaymentStatusesPresent = [...new Set(milestonesRows.map((r) => r.payment_status))];
      }
    }
  } catch (err) {
    results.liveAuditErrors.push("milestones exception: " + err.message);
  }

  // 4. Count total rows in milestones
  try {
    const { count, error: mCountErr } = await admin
      .from("milestones")
      .select("*", { count: "exact", head: true });
    if (!mCountErr) {
      results.milestonesRowCount = count || 0;
    }
  } catch (err) {
    results.liveAuditErrors.push("milestones count exception: " + err.message);
  }

  // 5. Test probe schema columns via information_schema or direct dummy insert rollbacks
  try {
    // Probe columns on payments by querying empty set
    const { data: sampleP, error: probePErr } = await admin
      .from("payments")
      .select("id, project_id, milestone_id, payer_id, payee_id, amount, currency, payment_type, status, order_id, authorization_id, capture_id, payment_method, metadata, created_at")
      .limit(0);

    if (!probePErr) {
      results.paymentsColumns = [
        "id", "project_id", "milestone_id", "payer_id", "payee_id",
        "amount", "currency", "payment_type", "status", "order_id",
        "authorization_id", "capture_id", "payment_method", "metadata", "created_at"
      ];
    }
  } catch (err) {
    results.liveAuditErrors.push("column probe payments: " + err.message);
  }

  try {
    // Probe columns on milestones
    const { data: sampleM, error: probeMErr } = await admin
      .from("milestones")
      .select("id, project_id, phase, title, description, amount, currency, due_date, status, payment_status, order_id, authorization_id, capture_id, authorized_date, captured_date, created_at, updated_at")
      .limit(0);

    if (!probeMErr) {
      results.milestonesColumns = [
        "id", "project_id", "phase", "title", "description",
        "amount", "currency", "due_date", "status", "payment_status",
        "order_id", "authorization_id", "capture_id", "authorized_date",
        "captured_date", "created_at", "updated_at"
      ];
    }
  } catch (err) {
    results.liveAuditErrors.push("column probe milestones: " + err.message);
  }

  console.log("LIVE AUDIT RESULTS SUMMARY:");
  console.log("------------------------------------------------------------------");
  console.log("1. TABLE: public.payments");
  console.log("   - Table Exists: " + results.paymentsTableExists);
  console.log("   - Total Rows in Live DB: " + results.paymentsRowCount);
  console.log("   - Verified Live Columns (" + results.paymentsColumns.length + "): " + results.paymentsColumns.join(", "));
  console.log("   - Existing Statuses Found in Rows: " + (results.paymentsStatusesPresent.length > 0 ? results.paymentsStatusesPresent.join(", ") : "None (Table is currently empty of persisted rows)"));
  console.log("");
  console.log("2. TABLE: public.milestones");
  console.log("   - Table Exists: " + results.milestonesTableExists);
  console.log("   - Total Rows in Live DB: " + results.milestonesRowCount);
  console.log("   - Verified Live Columns (" + results.milestonesColumns.length + "): " + results.milestonesColumns.join(", "));
  console.log("   - Existing Payment Statuses Found in Rows: " + (results.milestonesPaymentStatusesPresent.length > 0 ? results.milestonesPaymentStatusesPresent.join(", ") : "None (Table is currently empty of persisted rows)"));
  console.log("");
  console.log("3. LIVE AUDIT ERRORS / ANOMALIES: " + (results.liveAuditErrors.length === 0 ? "Zero errors" : results.liveAuditErrors.join("; ")));
  console.log("==================================================================");

  return results;
}

runLiveDatabaseAudit();
