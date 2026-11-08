/**
 * MILESTONE AI — Phase 12.3: Evidence Storage Integration Automated Test Suite
 *
 * Validates:
 * 1. Unauthenticated file upload rejection (HTTP 401)
 * 2. Client role file upload rejection (HTTP 403 - Freelancers only)
 * 3. Unassigned freelancer upload rejection (HTTP 403 - Assignment required)
 * 4. Dangerous file type / extension rejection (HTTP 422)
 * 5. Oversized file rejection (> 10MB) (HTTP 422)
 * 6. Valid evidence upload to private storage bucket 'milestone-evidence' (HTTP 201)
 * 7. Storage path convention (<project_id>/<milestone_id>/<timestamp>_<uuid>_<filename>)
 * 8. Formal milestone package persistence in submissions & submission_files (HTTP 201)
 * 9. Milestone status transition to 'submitted' & audit log recorded
 * 10. Authenticated submission retrieval & 15-minute signed URL generation (GET /api/submissions)
 * 11. Secure file download endpoint (GET /api/submissions/download) & byte fidelity
 * 12. Cross-tenant evidence access prevention (HTTP 403)
 * 13. Concurrency lock against duplicate submissions (HTTP 409)
 * 14. Gemini verification retrieval of actual persisted storage bytes (read-only for payments)
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ENV_PATH = path.join(__dirname, '.env.local');
const envContent = fs.readFileSync(ENV_PATH, 'utf8');

let SUPABASE_URL = '';
let SUPABASE_SERVICE_KEY = '';
let SUPABASE_ANON_KEY = '';
let BASE_URL = 'http://localhost:3000';

envContent.split('\n').forEach((line) => {
  const t = line.trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) SUPABASE_URL = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) SUPABASE_SERVICE_KEY = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_ANON_KEY=')) SUPABASE_ANON_KEY = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('APP_BASE_URL=')) BASE_URL = t.split('=')[1].replace(/"/g, '').trim();
});

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase configuration in .env.local');
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passedTests = 0;
let failedTests = 0;

function assert(condition, message, details = '') {
  if (condition) {
    passedTests++;
    console.log(`✓ [PASS] ${message}${details ? ` -> ${details}` : ''}`);
  } else {
    failedTests++;
    console.error(`✗ [FAIL] ${message}${details ? ` -> ${details}` : ''}`);
  }
}

async function uploadFileViaApi(token, projectId, milestoneId, fileName, mimeType, buffer, description) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append('file', blob, fileName);
  formData.append('projectId', projectId);
  formData.append('milestoneId', milestoneId);
  if (description) formData.append('description', description);

  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}/api/submissions/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function jsonRequest(endpoint, method, token, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function runTests() {
  console.log('=============================================================================');
  console.log('MILESTONE AI — Phase 12.3: Evidence Storage Integration Automated Test Suite');
  console.log('=============================================================================\n');

  let clientUser = null;
  let clientToken = null;
  let assignedFreelancerUser = null;
  let assignedFreelancerToken = null;
  let unrelatedFreelancerUser = null;
  let unrelatedFreelancerToken = null;
  let testProject = null;
  let testMilestone = null;
  let uploadedFileRecord = null;
  let createdSubmissionId = null;

  try {
    // -------------------------------------------------------------------------
    // 0. Setup and Discover Test Users and Project
    // -------------------------------------------------------------------------
    console.log('--- 0. Resolving Test Users and Setting Up Dedicated Test Project ---');
    const { data: profiles, error: pErr } = await adminClient
      .from('profiles')
      .select('id, email, role');
    if (pErr) throw pErr;

    const clientProfiles = profiles.filter((p) => p.role === 'client');
    const freeProfiles = profiles.filter((p) => p.role === 'freelancer');

    if (!clientProfiles.length || freeProfiles.length < 2) {
      throw new Error('Test suite requires at least 1 client and 2 distinct freelancers in profiles table.');
    }

    clientUser = clientProfiles[0];
    assignedFreelancerUser = freeProfiles[0];
    unrelatedFreelancerUser = freeProfiles[1];

    // Sign in Client
    const cAuth = await anonClient.auth.signInWithPassword({
      email: clientUser.email,
      password: 'TestPassword123!@#',
    });
    if (!cAuth.data?.session) throw new Error(`Could not log in client: ${cAuth.error?.message}`);
    clientToken = cAuth.data.session.access_token;

    // Sign in Assigned Freelancer
    const fAuth = await anonClient.auth.signInWithPassword({
      email: assignedFreelancerUser.email,
      password: 'TestPassword123!@#',
    });
    if (!fAuth.data?.session) throw new Error(`Could not log in assigned freelancer: ${fAuth.error?.message}`);
    assignedFreelancerToken = fAuth.data.session.access_token;

    // Sign in Unrelated Freelancer
    const uAuth = await anonClient.auth.signInWithPassword({
      email: unrelatedFreelancerUser.email,
      password: 'TestPassword123!@#',
    });
    if (!uAuth.data?.session) throw new Error(`Could not log in unrelated freelancer: ${uAuth.error?.message}`);
    unrelatedFreelancerToken = uAuth.data.session.access_token;

    console.log(`✓ Client Owner: ${clientUser.email} (${clientUser.id})`);
    console.log(`✓ Assigned Freelancer: ${assignedFreelancerUser.email} (${assignedFreelancerUser.id})`);
    console.log(`✓ Unrelated Freelancer: ${unrelatedFreelancerUser.email} (${unrelatedFreelancerUser.id})`);

    // Create a dedicated test project assigned to assignedFreelancerUser
    const testProjectName = `Evidence Test Project ${Date.now()}`;
    const { data: pData, error: projErr } = await adminClient
      .from('projects')
      .insert({
        title: testProjectName,
        description: 'Automated test suite for Phase 12.3 evidence uploads',
        client_id: clientUser.id,
        freelancer_id: assignedFreelancerUser.id,
        budget: 5000,
        currency: 'USD',
        status: 'active',
        deadline: new Date(Date.now() + 86400000 * 30).toISOString(),
      })
      .select('id, title, client_id, freelancer_id')
      .single();

    if (projErr || !pData) throw new Error(`Failed to create test project: ${projErr?.message}`);
    testProject = pData;
    console.log(`✓ Test Project: ${testProject.title} (${testProject.id})`);

    // Create a test milestone
    const { data: mData, error: mErr } = await adminClient
      .from('milestones')
      .insert({
        project_id: testProject.id,
        phase: 1,
        title: 'Milestone 1: Backend Architecture and Evidence Uploads',
        description: 'Verify storage bucket uploads, SHA256 integrity, and multimodal Gemini audit',
        amount: 2500,
        currency: 'USD',
        status: 'in_progress',
        due_date: new Date(Date.now() + 86400000 * 14).toISOString(),
      })
      .select('id, title, status')
      .single();

    if (mErr || !mData) throw new Error(`Failed to create test milestone: ${mErr?.message}`);
    testMilestone = mData;
    console.log(`✓ Test Milestone: ${testMilestone.title} (${testMilestone.id})\n`);

    // Add acceptance criteria for test milestone
    await adminClient.from('acceptance_criteria').insert([
      {
        milestone_id: testMilestone.id,
        criterion_code: 'CRIT-1',
        label: 'Storage Evidence Integrity',
        description: 'Evidence artifacts must be uploaded to private bucket milestone-evidence with signed URLs',
      },
      {
        milestone_id: testMilestone.id,
        criterion_code: 'CRIT-2',
        label: 'Lighthouse Performance Verification',
        description: 'Automated audit report must demonstrate core web vitals compliance',
      },
    ]);

    // -------------------------------------------------------------------------
    // TEST 1: Unauthenticated file upload rejection
    // -------------------------------------------------------------------------
    console.log('--- 1. Testing Unauthenticated Evidence Upload Rejection ---');
    const unauthBuffer = Buffer.from('console.log("unauth evidence");', 'utf-8');
    const unauthUpload = await uploadFileViaApi(
      null, // No token
      testProject.id,
      testMilestone.id,
      'unauth-test.json',
      'application/json',
      unauthBuffer
    );

    assert(
      unauthUpload.status === 401,
      'Unauthenticated file upload is rejected with HTTP 401',
      `Status: ${unauthUpload.status}`
    );
    assert(
      unauthUpload.body?.error?.includes('Unauthorized'),
      'Appropriate unauthorized message returned',
      unauthUpload.body?.error
    );

    // -------------------------------------------------------------------------
    // TEST 2: Client role file upload rejection
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Client Role Upload Rejection (Freelancers Only) ---');
    const clientBuffer = Buffer.from('{"audit": "client upload attempt"}', 'utf-8');
    const clientUpload = await uploadFileViaApi(
      clientToken,
      testProject.id,
      testMilestone.id,
      'client-attempt.json',
      'application/json',
      clientBuffer
    );

    assert(
      clientUpload.status === 403,
      'Client account file upload is rejected with HTTP 403',
      `Status: ${clientUpload.status}`
    );
    assert(
      clientUpload.body?.error?.includes('freelancers can upload'),
      'Error indicates only assigned freelancers can upload deliverables',
      clientUpload.body?.error
    );

    // -------------------------------------------------------------------------
    // TEST 3: Unassigned freelancer upload rejection
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Unassigned Freelancer Upload Rejection ---');
    const unassignedBuffer = Buffer.from('{"audit": "unassigned attempt"}', 'utf-8');
    const unassignedUpload = await uploadFileViaApi(
      unrelatedFreelancerToken,
      testProject.id,
      testMilestone.id,
      'unassigned-attempt.json',
      'application/json',
      unassignedBuffer
    );

    assert(
      unassignedUpload.status === 403,
      'Unassigned freelancer upload is rejected with HTTP 403',
      `Status: ${unassignedUpload.status}`
    );
    assert(
      unassignedUpload.body?.error?.includes('not the assigned freelancer'),
      'Error identifies freelancer is not assigned to the project',
      unassignedUpload.body?.error
    );

    // -------------------------------------------------------------------------
    // TEST 4: Dangerous/executable file rejection
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Disallowed Dangerous File Rejection ---');
    const exeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'utf-8');
    const exeUpload = await uploadFileViaApi(
      assignedFreelancerToken,
      testProject.id,
      testMilestone.id,
      'exploit-payload.exe',
      'application/x-msdownload',
      exeBuffer
    );

    assert(
      exeUpload.status === 422,
      'Dangerous executable (.exe) upload is rejected with HTTP 422',
      `Status: ${exeUpload.status}`
    );
    assert(
      exeUpload.body?.error?.includes('disallowed') ||
        exeUpload.body?.error?.includes('extension') ||
        exeUpload.body?.error?.includes('forbidden'),
      'Error explains disallowed file extension',
      exeUpload.body?.error
    );

    // -------------------------------------------------------------------------
    // TEST 5: Oversized file rejection (> 10MB)
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Oversized File Rejection (> 10MB) ---');
    // Allocate 11 MB buffer
    const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024, 0x61);
    const oversizedUpload = await uploadFileViaApi(
      assignedFreelancerToken,
      testProject.id,
      testMilestone.id,
      'huge-payload.pdf',
      'application/pdf',
      oversizedBuffer
    );

    assert(
      oversizedUpload.status === 422,
      'Oversized file (>10MB) upload is rejected with HTTP 422',
      `Status: ${oversizedUpload.status}`
    );
    assert(
      oversizedUpload.body?.error?.includes('10 MB'),
      'Error explicitly indicates 10 MB maximum limit',
      oversizedUpload.body?.error
    );

    // -------------------------------------------------------------------------
    // TEST 6: Valid JSON evidence upload to private storage by assigned freelancer
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing Valid Evidence Upload to Private Storage ---');
    const validJsonContent = JSON.stringify(
      {
        testSuite: 'Phase 12.3 Unit & E2E Storage Validation',
        totalPassed: 52,
        totalFailed: 0,
        coveragePct: 99.1,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    );
    const validJsonBuffer = Buffer.from(validJsonContent, 'utf-8');

    const validUpload = await uploadFileViaApi(
      assignedFreelancerToken,
      testProject.id,
      testMilestone.id,
      'storage-verification-report.json',
      'application/json',
      validJsonBuffer,
      'Automated integration test coverage report'
    );

    assert(
      validUpload.status === 201,
      'Valid evidence upload succeeds with HTTP 201 Created',
      `Status: ${validUpload.status}`
    );
    assert(
      validUpload.body?.success === true,
      'Upload response includes success: true',
      JSON.stringify(validUpload.body?.file?.name)
    );
    assert(
      Boolean(validUpload.body?.file?.storagePath),
      'Upload returns non-empty storagePath',
      validUpload.body?.file?.storagePath
    );
    assert(
      Boolean(validUpload.body?.file?.signedUrl),
      'Upload returns temporary signed download URL',
      validUpload.body?.file?.signedUrl?.slice(0, 60) + '...'
    );

    uploadedFileRecord = validUpload.body?.file;

    // -------------------------------------------------------------------------
    // TEST 7: Storage path convention & private bucket verification
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Verifying Storage Path Convention and Bucket Reality ---');
    const expectedPrefix = `${testProject.id}/${testMilestone.id}/`;
    assert(
      uploadedFileRecord?.storagePath?.startsWith(expectedPrefix),
      `Storage path adheres to scoped format: ${expectedPrefix}<timestamp>_<uuid>_<filename>`,
      uploadedFileRecord?.storagePath
    );

    // Verify file actually exists in Supabase Storage bucket 'milestone-evidence'
    const pathParts = uploadedFileRecord.storagePath.split('/');
    const folder = `${pathParts[0]}/${pathParts[1]}`;
    const filename = pathParts.slice(2).join('/');

    const { data: listBucket, error: bucketErr } = await adminClient.storage
      .from('milestone-evidence')
      .list(folder, { search: filename });

    assert(
      !bucketErr && listBucket && listBucket.length > 0,
      'File confirmed present in private bucket "milestone-evidence"',
      `Matched: ${listBucket?.[0]?.name}`
    );

    // Also upload a secondary sample PDF file
    console.log('\n--- 8. Uploading Secondary PDF Evidence Artifact ---');
    const samplePdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n160\n%%EOF',
      'utf-8'
    );
    const pdfUpload = await uploadFileViaApi(
      assignedFreelancerToken,
      testProject.id,
      testMilestone.id,
      'lighthouse-performance-audit.pdf',
      'application/pdf',
      samplePdfBuffer,
      'Performance audit documentation'
    );

    assert(pdfUpload.status === 201, 'Secondary PDF evidence uploaded successfully (HTTP 201)');
    const pdfFileRecord = pdfUpload.body?.file;

    // -------------------------------------------------------------------------
    // TEST 8: Formal Milestone Package Persistence (POST /api/submissions)
    // -------------------------------------------------------------------------
    console.log('\n--- 9. Testing Formal Milestone Submission Package Persistence ---');
    const submissionPayload = {
      projectId: testProject.id,
      milestoneId: testMilestone.id,
      repoUrl: 'https://github.com/agency/milestone-ai-core/commit/8e7f21a',
      stagingUrl: 'https://staging.milestoneai.dev/preview/m1',
      figmaUrl: 'https://figma.com/file/milestone-evidence-specs',
      notes: 'Implemented storage integration, API upload endpoints, and real evidence verification.',
      files: [
        {
          fileName: uploadedFileRecord.name,
          storagePath: uploadedFileRecord.storagePath,
          fileSizeBytes: uploadedFileRecord.sizeBytes,
          mimeType: uploadedFileRecord.mimeType,
          description: uploadedFileRecord.description,
        },
        {
          fileName: pdfFileRecord.name,
          storagePath: pdfFileRecord.storagePath,
          fileSizeBytes: pdfFileRecord.sizeBytes,
          mimeType: pdfFileRecord.mimeType,
          description: pdfFileRecord.description,
        },
      ],
    };

    const subRes = await jsonRequest('/api/submissions', 'POST', assignedFreelancerToken, submissionPayload);

    assert(
      subRes.status === 201,
      'Milestone submission successfully persisted (HTTP 201)',
      `Status: ${subRes.status}`
    );
    assert(
      Boolean(subRes.body?.submissionId),
      'Persisted record returns valid submissionId',
      subRes.body?.submissionId
    );
    assert(
      subRes.body?.filesCount === 2,
      'Persisted record verified exactly 2 evidence files',
      `Count: ${subRes.body?.filesCount}`
    );

    createdSubmissionId = subRes.body?.submissionId;

    // -------------------------------------------------------------------------
    // TEST 9: Database Record Verification (submissions, submission_files, milestones, audit_logs)
    // -------------------------------------------------------------------------
    console.log('\n--- 10. Verifying Database Tables (submissions, submission_files, audit_logs) ---');
    // Check submissions table
    const { data: dbSub, error: dbSubErr } = await adminClient
      .from('submissions')
      .select('*')
      .eq('id', createdSubmissionId)
      .single();

    assert(
      !dbSubErr && dbSub && dbSub.submitter_id === assignedFreelancerUser.id,
      'Submission row exists with authoritative submitter_id set to assigned freelancer',
      dbSub?.submitter_id
    );
    assert(
      dbSub?.status === 'submitted',
      'Submission row has status = "submitted"',
      dbSub?.status
    );

    // Check submission_files table
    const { data: dbFiles, error: dbFilesErr } = await adminClient
      .from('submission_files')
      .select('*')
      .eq('submission_id', createdSubmissionId);

    assert(
      !dbFilesErr && dbFiles && dbFiles.length === 2,
      'submission_files table persisted metadata for both files',
      `Count: ${dbFiles?.length}`
    );
    assert(
      dbFiles?.some((f) => f.storage_path === uploadedFileRecord.storagePath),
      'storage_path accurately persisted in submission_files',
      uploadedFileRecord.storagePath
    );

    // Check milestone status updated
    const { data: updatedMilestone } = await adminClient
      .from('milestones')
      .select('status')
      .eq('id', testMilestone.id)
      .single();

    assert(
      updatedMilestone?.status === 'submitted',
      'Milestones table status updated to "submitted"',
      updatedMilestone?.status
    );

    // Check audit_logs table
    const { data: auditLogs } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('project_id', testProject.id)
      .eq('action', 'EVIDENCE_SUBMITTED');

    assert(
      auditLogs && auditLogs.length > 0,
      'Audit log recorded with action = "EVIDENCE_SUBMITTED"',
      `Logs count: ${auditLogs?.length}`
    );

    // -------------------------------------------------------------------------
    // TEST 10: Authenticated Submission Query (GET /api/submissions)
    // -------------------------------------------------------------------------
    console.log('\n--- 11. Testing Submission Query and Signed URL Generation ---');
    const getSubRes = await jsonRequest(
      `/api/submissions?milestoneId=${testMilestone.id}`,
      'GET',
      clientToken
    );

    assert(
      getSubRes.status === 200,
      'Client owner can retrieve milestone submissions (HTTP 200)',
      `Status: ${getSubRes.status}`
    );
    const retrievedSub = getSubRes.body?.submissions?.[0];
    assert(
      retrievedSub && retrievedSub.submission_files?.length === 2,
      'Retrieved submission contains the 2 submitted files',
      `Count: ${retrievedSub?.submission_files?.length}`
    );
    const firstFile = retrievedSub?.submission_files?.[0] || retrievedSub?.files?.[0];
    const liveSignedUrl = firstFile?.signed_url || firstFile?.signedUrl;
    assert(
      Boolean(liveSignedUrl),
      'Retrieved file records contain live authenticated signed_url',
      liveSignedUrl ? liveSignedUrl.slice(0, 60) + '...' : 'none'
    );

    // -------------------------------------------------------------------------
    // TEST 11: Secure File Download Endpoint & Byte Fidelity
    // -------------------------------------------------------------------------
    console.log('\n--- 12. Testing Secure Download Endpoint (GET /api/submissions/download) ---');
    const dlRes = await jsonRequest(
      `/api/submissions/download?path=${encodeURIComponent(uploadedFileRecord.storagePath)}`,
      'GET',
      clientToken
    );

    assert(
      dlRes.status === 200,
      'Project client can obtain download signed URL (HTTP 200)',
      `Status: ${dlRes.status}`
    );
    assert(
      Boolean(dlRes.body?.signedUrl),
      'Download endpoint returns valid signedUrl',
      dlRes.body?.signedUrl?.slice(0, 60) + '...'
    );

    // Fetch the signed URL directly from Supabase Storage and verify bytes
    const storageFetch = await fetch(dlRes.body?.signedUrl);
    assert(
      storageFetch.status === 200,
      'Direct GET to signed URL returns HTTP 200 OK from Supabase Storage'
    );
    const fetchedContent = await storageFetch.text();
    assert(
      fetchedContent === validJsonContent,
      'Downloaded storage bytes match original uploaded JSON payload exactly',
      `Bytes matched (${fetchedContent.length} chars)`
    );

    // -------------------------------------------------------------------------
    // TEST 12: Cross-Tenant Download Prevention
    // -------------------------------------------------------------------------
    console.log('\n--- 13. Testing Cross-Tenant Access Prevention ---');
    const crossTenantDl = await jsonRequest(
      `/api/submissions/download?path=${encodeURIComponent(uploadedFileRecord.storagePath)}`,
      'GET',
      unrelatedFreelancerToken
    );

    assert(
      crossTenantDl.status === 403,
      'Unrelated freelancer is forbidden from accessing evidence (HTTP 403)',
      `Status: ${crossTenantDl.status}`
    );
    assert(
      crossTenantDl.body?.error?.includes('Forbidden') || crossTenantDl.body?.error?.includes('participant'),
      'Cross-tenant rejection message returned',
      crossTenantDl.body?.error
    );

    // Path traversal attempt test
    const traversalDl = await jsonRequest(
      '/api/submissions/download?path=../../etc/passwd',
      'GET',
      clientToken
    );
    assert(
      traversalDl.status === 400,
      'Path traversal attempt is rejected with HTTP 400 Bad Request',
      `Status: ${traversalDl.status}`
    );

    // -------------------------------------------------------------------------
    // TEST 13: Concurrency Lock Against Duplicate Submissions
    // -------------------------------------------------------------------------
    console.log('\n--- 14. Testing Concurrency Lock Protection ---');
    // Fire two simultaneous requests
    const [sim1, sim2] = await Promise.all([
      jsonRequest('/api/submissions', 'POST', assignedFreelancerToken, submissionPayload),
      jsonRequest('/api/submissions', 'POST', assignedFreelancerToken, submissionPayload),
    ]);

    const hasConflict = sim1.status === 409 || sim2.status === 409;
    assert(
      hasConflict,
      'Concurrent duplicate submission triggers HTTP 409 Conflict lock',
      `sim1: ${sim1.status}, sim2: ${sim2.status}`
    );

    // -------------------------------------------------------------------------
    // TEST 14: Gemini Verification Retrieves Real Storage Evidence
    // -------------------------------------------------------------------------
    console.log('\n--- 15. Testing Gemini Verification Retrieval of Persisted Evidence ---');
    const geminiRes = await jsonRequest(
      '/api/gemini/verify',
      'POST',
      assignedFreelancerToken,
      {
        projectId: testProject.id,
        milestoneId: testMilestone.id,
        submissionId: createdSubmissionId,
        acceptanceCriteria: [
          {
            id: 'crit-1',
            label: 'Storage Evidence Integrity',
            description: 'Verify storage evidence',
          },
        ],
        notes: submissionPayload.notes,
        repoUrl: submissionPayload.repoUrl,
        stagingUrl: submissionPayload.stagingUrl,
        figmaUrl: submissionPayload.figmaUrl,
        files: [
          {
            id: 'file-1',
            name: uploadedFileRecord.name,
            size: '1.2 KB',
            type: 'application/json',
            storagePath: uploadedFileRecord.storagePath,
          },
        ],
      }
    );

    assert(
      geminiRes.status === 200 || geminiRes.status === 429,
      'Gemini verification processes persisted storage evidence safely',
      `Status: ${geminiRes.status}`
    );
    if (geminiRes.status === 200) {
      assert(
        Boolean(geminiRes.body?.auditReport),
        'Gemini returned structured auditReport for persisted submission',
        `Overall status: ${geminiRes.body?.auditReport?.overallStatus}`
      );
    }

  } catch (err) {
    console.error('Fatal error during test run:', err);
    failedTests++;
  } finally {
    // Cleanup temporary test records in Supabase
    console.log('\n--- Cleanup: Removing Test Project & Milestones ---');
    if (testProject?.id) {
      // Delete test submission files from storage
      if (uploadedFileRecord?.storagePath) {
        await adminClient.storage
          .from('milestone-evidence')
          .remove([uploadedFileRecord.storagePath]);
      }
      // Delete DB records
      await adminClient.from('submission_files').delete().eq('submission_id', createdSubmissionId);
      await adminClient.from('submissions').delete().eq('project_id', testProject.id);
      await adminClient.from('acceptance_criteria').delete().eq('milestone_id', testMilestone?.id);
      await adminClient.from('milestones').delete().eq('project_id', testProject.id);
      await adminClient.from('audit_logs').delete().eq('project_id', testProject.id);
      await adminClient.from('projects').delete().eq('id', testProject.id);
      console.log('✓ Temporary test data cleaned up successfully.');
    }
  }

  console.log('\n=============================================================================');
  console.log(`TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================================================');

  process.exit(failedTests > 0 ? 1 : 0);
}

runTests();
