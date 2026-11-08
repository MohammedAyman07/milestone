const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const envFile = fs.readFileSync('.env.local', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let v = match[2] || '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[match[1]] = v.trim();
  }
});

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function checkTables() {
  const tables = [
    'profiles',
    'projects',
    'milestones',
    'acceptance_criteria',
    'submissions',
    'submission_files',
    'verification_reports',
    'verification_criteria_results',
    'payments',
    'audit_logs',
    'paypal_webhook_events'
  ];

  console.log('Inspecting live Supabase database tables...');
  let allGood = true;
  for (const t of tables) {
    const { data, error } = await client.from(t).select('id').limit(1);
    if (error) {
      console.error(`❌ Table error on ${t}: ${error.message}`);
      allGood = false;
    } else {
      console.log(`✓ Table exists and accessible: ${t}`);
    }
  }

  // Check milestone-evidence bucket
  const { data: buckets, error: bErr } = await client.storage.listBuckets();
  if (bErr) {
    console.error(`❌ Bucket list error: ${bErr.message}`);
    allGood = false;
  } else {
    const evidenceBucket = buckets.find(b => b.name === 'milestone-evidence');
    if (evidenceBucket) {
      console.log(`✓ Storage bucket exists: milestone-evidence (public: ${evidenceBucket.public})`);
    } else {
      console.error(`❌ Bucket milestone-evidence not found in:`, buckets.map(b => b.name));
      allGood = false;
    }
  }

  process.exit(allGood ? 0 : 1);
}
checkTables();
