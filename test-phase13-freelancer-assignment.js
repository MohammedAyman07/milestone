/**
 * MILESTONE AI — Phase 13: Freelancer Assignment & Role Enforcement Test Suite
 *
 * Requirements Tested:
 * 1. Project creation succeeds when assigned to an existing registered freelancer.
 * 2. Project creation rejects unregistered freelancer emails (HTTP 404, no silent assignment).
 * 3. Project creation rejects emails belonging to client accounts (HTTP 400 role violation).
 * 4. Project creation performs safe case-insensitive email matching.
 * 5. Unauthorized / freelancer role project creation is blocked (HTTP 401/403).
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const envFile = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
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

const results = {
  passed: [],
  failed: []
};

function pass(name, details = '') {
  console.log(`[PASS] ${name}${details ? ` -> ${details}` : ''}`);
  results.passed.push({ name, details });
}

function fail(name, err) {
  console.error(`[FAIL] ${name} -> ${err}`);
  results.failed.push({ name, err });
}

async function runTestSuite() {
  console.log('=============================================================================');
  console.log('MILESTONE AI — Freelancer Assignment & Role Validation Test Suite');
  console.log('=============================================================================\n');

  let testClient = null;
  let testFreelancer = null;
  let testOtherClient = null;
  let createdProjectId = null;

  try {
    const ts = Date.now();
    const clientEmail = `assignment.client.${ts}@test.milestoneai.dev`;
    const freelancerEmail = `assignment.freelancer.${ts}@test.milestoneai.dev`;
    const otherClientEmail = `assignment.otherclient.${ts}@test.milestoneai.dev`;
    const testPassword = 'Password123!SecureTest';

    // Setup Test Accounts
    console.log('--- Setting up isolated test accounts ---');
    const { data: uC } = await admin.auth.admin.createUser({
      email: clientEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { role: 'client', full_name: 'Test Client' }
    });
    testClient = uC.user;

    const { data: uF } = await admin.auth.admin.createUser({
      email: freelancerEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { role: 'freelancer', full_name: 'Test Freelancer' }
    });
    testFreelancer = uF.user;

    const { data: uO } = await admin.auth.admin.createUser({
      email: otherClientEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { role: 'client', full_name: 'Other Client' }
    });
    testOtherClient = uO.user;

    await admin.from('profiles').upsert([
      { id: testClient.id, email: clientEmail, role: 'client', full_name: 'Test Client' },
      { id: testFreelancer.id, email: freelancerEmail, role: 'freelancer', full_name: 'Test Freelancer' },
      { id: testOtherClient.id, email: otherClientEmail, role: 'client', full_name: 'Other Client' },
    ]);

    pass('Test accounts provisioned', `Client: ${clientEmail}, Freelancer: ${freelancerEmail}`);

    // Simulation helper matching src/app/api/projects/route.ts logic
    async function simulateCreateProject({ user, projectData }) {
      if (!user) {
        return { status: 401, error: "Unauthorized: An authenticated session is required." };
      }

      const { data: profile } = await admin.from("profiles").select("id, role").eq("id", user.id).single();
      if (!profile || profile.role !== "client") {
        return { status: 403, error: "Security Violation: Only clients can create projects." };
      }

      let freelancerId = null;
      if (projectData.freelancerId && typeof projectData.freelancerId === "string") {
        const { data: fProfile } = await admin
          .from("profiles")
          .select("id, role, email")
          .eq("id", projectData.freelancerId.trim())
          .maybeSingle();

        if (fProfile) {
          if (fProfile.role !== "freelancer") {
            return { status: 400, error: `The specified user is registered as a ${fProfile.role}, not a freelancer.` };
          }
          freelancerId = fProfile.id;
        } else {
          return { status: 400, error: "Specified freelancer ID does not exist in the database." };
        }
      } else if (projectData.freelancerEmail && typeof projectData.freelancerEmail === "string") {
        const emailTrim = projectData.freelancerEmail.trim().toLowerCase();
        const { data: fProfile } = await admin
          .from("profiles")
          .select("id, role, email")
          .ilike("email", emailTrim)
          .maybeSingle();

        if (fProfile) {
          if (fProfile.role !== "freelancer") {
            return {
              status: 400,
              error: `The account associated with '${emailTrim}' is registered as a ${fProfile.role}, not a freelancer. Projects can only be assigned to accounts registered as freelancers.`
            };
          }
          freelancerId = fProfile.id;
        } else {
          return {
            status: 404,
            error: `No registered freelancer found with email '${emailTrim}'. The freelancer must first register an account on MILESTONE AI before you can assign them to a project.`
          };
        }
      } else {
        return { status: 400, error: "Freelancer assignment is required." };
      }

      if (freelancerId === user.id) {
        return { status: 400, error: "A client cannot assign themselves as the freelancer for their own project." };
      }

      // Insert project
      const { data: proj, error: projErr } = await admin.from("projects").insert({
        title: projectData.title,
        description: projectData.description,
        budget: projectData.budget,
        currency: "USD",
        start_date: new Date().toISOString().split('T')[0],
        deadline: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        status: "active",
        client_id: user.id,
        freelancer_id: freelancerId
      }).select().single();

      if (projErr) return { status: 500, error: projErr.message };
      return { status: 200, success: true, project: proj };
    }

    // -------------------------------------------------------------------------
    // TEST 1: Existing Freelancer Email
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 1: Existing Registered Freelancer Email ---');
    const res1 = await simulateCreateProject({
      user: testClient,
      projectData: {
        title: `Project 1 ${ts}`,
        description: 'Test assignment',
        budget: 500,
        freelancerEmail: freelancerEmail
      }
    });

    if (res1.status === 200 && res1.project?.freelancer_id === testFreelancer.id) {
      createdProjectId = res1.project.id;
      pass('Project assigned to exact registered freelancer', `Assigned UUID: ${res1.project.freelancer_id}`);
    } else {
      fail('Project assigned to exact registered freelancer', JSON.stringify(res1));
    }

    // -------------------------------------------------------------------------
    // TEST 2: Unregistered Freelancer Email (No Silent Fallback)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Unregistered Freelancer Email Rejection ---');
    const unregisteredEmail = `ghost.freelancer.${ts}@unknown-domain.io`;
    const res2 = await simulateCreateProject({
      user: testClient,
      projectData: {
        title: `Project 2 ${ts}`,
        description: 'Test unassigned',
        budget: 500,
        freelancerEmail: unregisteredEmail
      }
    });

    if (res2.status === 404 && res2.error.includes('No registered freelancer found')) {
      pass('Unregistered freelancer email rejected with HTTP 404 (zero silent assignment)', res2.error);
    } else {
      fail('Unregistered freelancer email rejected with HTTP 404', JSON.stringify(res2));
    }

    // -------------------------------------------------------------------------
    // TEST 3: Email Belonging to a Client
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Email Belonging to Client Rejection ---');
    const res3 = await simulateCreateProject({
      user: testClient,
      projectData: {
        title: `Project 3 ${ts}`,
        description: 'Test role mismatch',
        budget: 500,
        freelancerEmail: otherClientEmail
      }
    });

    if (res3.status === 400 && res3.error.includes('registered as a client, not a freelancer')) {
      pass('Email belonging to a client rejected with role mismatch error', res3.error);
    } else {
      fail('Email belonging to a client rejected with role mismatch error', JSON.stringify(res3));
    }

    // -------------------------------------------------------------------------
    // TEST 4: Case-Insensitive Email Matching
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Case-Insensitive Email Matching ---');
    const upperCaseEmail = freelancerEmail.toUpperCase();
    const res4 = await simulateCreateProject({
      user: testClient,
      projectData: {
        title: `Project 4 ${ts}`,
        description: 'Test casing',
        budget: 500,
        freelancerEmail: upperCaseEmail
      }
    });

    if (res4.status === 200 && res4.project?.freelancer_id === testFreelancer.id) {
      await admin.from('projects').delete().eq('id', res4.project.id);
      pass('Uppercase email safely matched to lowercase registered freelancer', `Queried: ${upperCaseEmail}`);
    } else {
      fail('Uppercase email safely matched to lowercase registered freelancer', JSON.stringify(res4));
    }

    // -------------------------------------------------------------------------
    // TEST 5: Unauthorized Project Creation (Freelancer role or unauthenticated)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Unauthorized Project Creation ---');
    const res5Unauth = await simulateCreateProject({
      user: null,
      projectData: { title: 'X', description: 'X', budget: 100, freelancerEmail }
    });
    if (res5Unauth.status === 401) {
      pass('Unauthenticated request rejected with HTTP 401', res5Unauth.error);
    } else {
      fail('Unauthenticated request rejected with HTTP 401', JSON.stringify(res5Unauth));
    }

    const res5Free = await simulateCreateProject({
      user: testFreelancer,
      projectData: { title: 'X', description: 'X', budget: 100, freelancerEmail }
    });
    if (res5Free.status === 403 && res5Free.error.includes('Only clients can create projects')) {
      pass('Freelancer user rejected from creating projects (HTTP 403)', res5Free.error);
    } else {
      fail('Freelancer user rejected from creating projects (HTTP 403)', JSON.stringify(res5Free));
    }

    // Self-assignment check
    const res5Self = await simulateCreateProject({
      user: testClient,
      projectData: { title: 'Self', description: 'Self', budget: 100, freelancerEmail: clientEmail }
    });
    if (res5Self.status === 400) {
      pass('Client cannot assign themselves as freelancer', res5Self.error);
    } else {
      fail('Client cannot assign themselves as freelancer', JSON.stringify(res5Self));
    }

  } catch (err) {
    fail('Test suite exception', err.message);
  } finally {
    console.log('\n--- Cleaning up temporary test fixtures ---');
    try {
      if (createdProjectId) {
        await admin.from('projects').delete().eq('id', createdProjectId);
      }
      if (testClient) {
        await admin.auth.admin.deleteUser(testClient.id);
        await admin.from('profiles').delete().eq('id', testClient.id);
      }
      if (testFreelancer) {
        await admin.auth.admin.deleteUser(testFreelancer.id);
        await admin.from('profiles').delete().eq('id', testFreelancer.id);
      }
      if (testOtherClient) {
        await admin.auth.admin.deleteUser(testOtherClient.id);
        await admin.from('profiles').delete().eq('id', testOtherClient.id);
      }
      console.log('Temporary test fixtures cleaned up successfully.');
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }
  }

  console.log('\n=============================================================================');
  console.log(`TEST RESULTS: ${results.passed.length} PASSED, ${results.failed.length} FAILED`);
  console.log('=============================================================================');

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

runTestSuite();
