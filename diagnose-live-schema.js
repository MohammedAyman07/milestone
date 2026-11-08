const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Read .env.local without exposing secrets
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

const client = createClient(url, servKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function diagnose() {
  console.log("=== Phase 7.1 Live Supabase Schema & Data Diagnostic ===");
  const report = {};

  // 1. Existing payments data
  try {
    const { data: payments, error: pErr } = await client
      .from("payments")
      .select("id, milestone_id, project_id, amount, currency, payment_type, status, order_id, authorization_id, capture_id, created_at");
    
    if (pErr) {
      report.paymentsQuery = { error: pErr.message };
    } else {
      report.paymentsQuery = {
        rowCount: payments.length,
        statuses: [...new Set(payments.map(p => p.status))],
        paymentTypes: [...new Set(payments.map(p => p.payment_type))],
        currencies: [...new Set(payments.map(p => p.currency))],
        rows: payments,
      };

      // Check for duplicate active payment attempts per milestone
      const activeByMilestone = {};
      const duplicates = [];
      const activeStatuses = ["CREATED", "APPROVED", "AUTHORIZED", "CAPTURE_PENDING", "order", "authorization"];
      payments.forEach(p => {
        if (activeStatuses.includes(p.status) || activeStatuses.includes(p.payment_type)) {
          if (!activeByMilestone[p.milestone_id]) activeByMilestone[p.milestone_id] = [];
          activeByMilestone[p.milestone_id].push(p.id);
          if (activeByMilestone[p.milestone_id].length > 1) {
            duplicates.push({ milestoneId: p.milestone_id, paymentIds: activeByMilestone[p.milestone_id] });
          }
        }
      });
      report.duplicateActivePaymentAttempts = duplicates;
    }
  } catch (e) {
    report.paymentsQuery = { exception: e.message };
  }

  // 2. Existing milestones data
  try {
    const { data: milestones, error: mErr } = await client
      .from("milestones")
      .select("id, project_id, phase, title, amount, currency, status, payment_status, order_id, authorization_id, capture_id");

    if (mErr) {
      report.milestonesQuery = { error: mErr.message };
    } else {
      report.milestonesQuery = {
        rowCount: milestones.length,
        paymentStatuses: [...new Set(milestones.map(m => m.payment_status))],
        currencies: [...new Set(milestones.map(m => m.currency))],
        rows: milestones,
      };
    }
  } catch (e) {
    report.milestonesQuery = { exception: e.message };
  }

  // 3. Test check-migration-status query directly
  try {
    const { data, error } = await client
      .from("payments")
      .select("payment_attempt_id, idempotency_auth_capture, honor_period_expires_at")
      .limit(1);

    report.migrationCheckQueryResult = {
      hasData: !!data,
      error: error ? { message: error.message, code: error.code, details: error.details, hint: error.hint } : null,
    };
  } catch (e) {
    report.migrationCheckQueryResult = { exception: e.message };
  }

  console.log(JSON.stringify(report, null, 2));
}

diagnose();
