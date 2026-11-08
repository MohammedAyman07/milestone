const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const env = fs.readFileSync('.env.local', 'utf8');
let u = '', k = '';
env.split('\n').forEach(l => {
  const t = l.trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) u = t.substring(t.indexOf('=') + 1).replace(/"/g, '').trim();
  if (t.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) k = t.substring(t.indexOf('=') + 1).replace(/"/g, '').trim();
});

const admin = createClient(u, k);

async function check() {
  const { data, error } = await admin.rpc('exec_sql', { sql: 'SELECT 1;' });
  console.log('exec_sql:', { data, error });
}
check();
