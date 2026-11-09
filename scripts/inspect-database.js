const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function inspect() {
  console.log('=== AUTH USERS & PROFILES ===');
  const { data: usersData, error: uErr } = await admin.auth.admin.listUsers();
  if (usersData?.users) {
    console.table(usersData.users.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in: u.last_sign_in_at })));
  }

  console.log('\n=== PROFILES ===');
  const { data: profiles } = await admin.from('profiles').select('id, email, full_name, role');
  console.table(profiles);

  console.log('\n=== PROJECTS ===');
  const { data: projects } = await admin.from('projects').select('id, title, budget, client_id, freelancer_id, created_at');
  console.table(projects);

  console.log('\n=== MILESTONES ===');
  const { data: milestones } = await admin.from('milestones').select('id, project_id, title, amount, status, payment_status');
  console.table(milestones);
}

inspect();
