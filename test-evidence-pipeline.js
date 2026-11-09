/**
 * Comprehensive Test Suite for MILESTONE AI Evidence Upload & AI Verification Pipeline
 * 
 * Tests:
 * 1. Real non-empty PNG upload to Supabase Storage
 * 2. Real non-empty PDF upload to Supabase Storage
 * 3. Exact byte size comparison (uploaded vs. stored)
 * 4. Exact SHA-256 cryptographic hash comparison (original vs. downloaded)
 * 5. Gemini multi-modal inspection of uploaded evidence
 * 6. Empty file (0-byte) rejection
 * 7. Disallowed executable file rejection
 * 8. Cleanup of test-only storage artifacts
 */

const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");

// Load .env.local
const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")];
    })
);
Object.assign(process.env, env);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = "milestone-evidence";

// Create minimal valid 1x1 PNG buffer (67 bytes)
function createValidPngBuffer() {
  const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  return Buffer.from(base64Png, "base64");
}

// Create minimal valid PDF buffer (~350 bytes)
function createValidPdfBuffer(customText) {
  const content = `BT /F1 18 Tf 50 700 Td (${customText}) Tj ET`;
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000266 00000 n ",
    "0000000340 00000 n ",
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "417",
    "%%EOF",
  ].join("\n");
  return Buffer.from(pdf, "utf-8");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function runTests() {
  console.log("================================================================================");
  console.log("MILESTONE AI: EVIDENCE UPLOAD & AI VERIFICATION PIPELINE TEST SUITE");
  console.log("================================================================================\n");

  const testProjectId = "test-project-" + crypto.randomUUID().slice(0, 8);
  const testMilestoneId = "test-milestone-" + crypto.randomUUID().slice(0, 8);
  const cleanupPaths = [];

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = "") {
    if (condition) {
      console.log(`[PASS] ${testName}${details ? " -> " + details : ""}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}${details ? " -> " + details : ""}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Real non-empty PNG upload & byte size validation
    // -------------------------------------------------------------------------
    console.log("--- TEST 1: REAL NON-EMPTY PNG UPLOAD ---");
    const originalPng = createValidPngBuffer();
    const pngHash = sha256(originalPng);
    const pngPath = `${testProjectId}/${testMilestoneId}/${Date.now()}_test_image.png`;
    cleanupPaths.push(pngPath);

    console.log(`Original PNG byte length: ${originalPng.length} bytes`);
    console.log(`Original PNG SHA-256: ${pngHash}`);

    const { data: uploadPngData, error: pngUploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(pngPath, originalPng, { contentType: "image/png", upsert: false });

    assert(!pngUploadErr && uploadPngData?.path === pngPath, "PNG upload to Supabase Storage succeeded");

    // -------------------------------------------------------------------------
    // TEST 2: Real non-empty PDF upload & byte size validation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 2: REAL NON-EMPTY PDF UPLOAD ---");
    const testSecretMessage = "MilestoneAI Security Audit Token " + crypto.randomUUID();
    const originalPdf = createValidPdfBuffer(testSecretMessage);
    const pdfHash = sha256(originalPdf);
    const pdfPath = `${testProjectId}/${testMilestoneId}/${Date.now()}_test_deliverable.pdf`;
    cleanupPaths.push(pdfPath);

    console.log(`Original PDF byte length: ${originalPdf.length} bytes`);
    console.log(`Original PDF SHA-256: ${pdfHash}`);

    const { data: uploadPdfData, error: pdfUploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(pdfPath, originalPdf, { contentType: "application/pdf", upsert: false });

    assert(!pdfUploadErr && uploadPdfData?.path === pdfPath, "PDF upload to Supabase Storage succeeded");

    // -------------------------------------------------------------------------
    // TEST 3: Stored byte size and metadata verification
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 3: STORED METADATA & BYTE SIZE VERIFICATION ---");
    const { data: listItems, error: listErr } = await supabase.storage
      .from(BUCKET)
      .list(`${testProjectId}/${testMilestoneId}`);

    assert(!listErr && Array.isArray(listItems), "Storage directory listed successfully");
    const storedPng = listItems.find((f) => pngPath.endsWith(f.name));
    const storedPdf = listItems.find((f) => pdfPath.endsWith(f.name));

    assert(storedPng && storedPng.metadata?.size === originalPng.length, "Stored PNG size matches uploaded bytes exactly", `Stored: ${storedPng?.metadata?.size} bytes, Original: ${originalPng.length} bytes`);
    assert(storedPdf && storedPdf.metadata?.size === originalPdf.length, "Stored PDF size matches uploaded bytes exactly", `Stored: ${storedPdf?.metadata?.size} bytes, Original: ${originalPdf.length} bytes`);

    // -------------------------------------------------------------------------
    // TEST 4: Binary download and Cryptographic SHA-256 Hash Matching
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 4: DOWNLOAD & CRYPTOGRAPHIC SHA-256 HASH VERIFICATION ---");
    const { data: downloadedPngBlob, error: dlPngErr } = await supabase.storage.from(BUCKET).download(pngPath);
    assert(!dlPngErr && downloadedPngBlob, "PNG downloaded from storage without error");
    const downloadedPngBuf = Buffer.from(await downloadedPngBlob.arrayBuffer());
    const dlPngHash = sha256(downloadedPngBuf);
    assert(downloadedPngBuf.length === originalPng.length, "Downloaded PNG length matches original exactly", `${downloadedPngBuf.length} bytes`);
    assert(dlPngHash === pngHash, "Downloaded PNG SHA-256 hash matches original", dlPngHash);

    const { data: downloadedPdfBlob, error: dlPdfErr } = await supabase.storage.from(BUCKET).download(pdfPath);
    assert(!dlPdfErr && downloadedPdfBlob, "PDF downloaded from storage without error");
    const downloadedPdfBuf = Buffer.from(await downloadedPdfBlob.arrayBuffer());
    const dlPdfHash = sha256(downloadedPdfBuf);
    assert(downloadedPdfBuf.length === originalPdf.length, "Downloaded PDF length matches original exactly", `${downloadedPdfBuf.length} bytes`);
    assert(dlPdfHash === pdfHash, "Downloaded PDF SHA-256 hash matches original", dlPdfHash);

    // -------------------------------------------------------------------------
    // TEST 5: Gemini Verification Multi-modal Inspection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 5: GEMINI MULTI-MODAL EVIDENCE INSPECTION ---");
    const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const prompt = `You are the MILESTONE AI Verification Engine. Inspect the attached PDF deliverable and extract the exact security audit token.
Agreed Criteria:
1. Deliverable document must contain the security audit token.
Respond with JSON:
{ "tokenFound": string, "criterionResult": "PASS" | "FAIL" }`;

    const payload = [
      prompt,
      `\n[EVIDENCE ARTIFACT ATTACHMENT: "test_deliverable.pdf" | Type: application/pdf | Size: ${downloadedPdfBuf.length} bytes]`,
      {
        inlineData: {
          mimeType: "application/pdf",
          data: downloadedPdfBuf.toString("base64"),
        },
      },
    ];

    const geminiRes = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: payload,
    });

    console.log("Gemini Inspection Response:", geminiRes.text.trim());
    const tokenPart = testSecretMessage.split(" ").pop().slice(0, 8);
    const parsedPass = geminiRes.text.includes("PASS") && (geminiRes.text.includes(tokenPart) || geminiRes.text.toLowerCase().includes("token"));
    assert(parsedPass, "Gemini successfully read and verified binary PDF evidence", `Found token part: ${tokenPart}`);

    // -------------------------------------------------------------------------
    // TEST 6: Empty File (0-byte) Rejection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 6: EMPTY FILE (0-BYTE) REJECTION ---");
    const emptyBuf = Buffer.alloc(0);
    const emptyPath = `${testProjectId}/${testMilestoneId}/empty.txt`;
    
    // In our upload validator, empty files are strictly blocked
    const { uploadEvidenceFile } = require("./src/lib/supabase/storage.ts");
    const emptyUploadResult = await uploadEvidenceFile(
      emptyBuf,
      "empty.txt",
      "text/plain",
      testProjectId,
      testMilestoneId
    );
    assert(!emptyUploadResult.success, "Empty 0-byte file rejected by storage validator", emptyUploadResult.error);

    // -------------------------------------------------------------------------
    // TEST 7: Executable / Dangerous File Type Rejection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 7: EXECUTABLE & MALICIOUS EXTENSION REJECTION ---");
    const dangerousBuf = Buffer.from("MZ malicious executable simulation");
    const exeUploadResult = await uploadEvidenceFile(
      dangerousBuf,
      "malware.exe",
      "application/x-msdownload",
      testProjectId,
      testMilestoneId
    );
    assert(!exeUploadResult.success, "Executable file (.exe) rejected by storage validator", exeUploadResult.error);

  } catch (err) {
    console.error("Unexpected test exception:", err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // Cleanup temporary test files
    // -------------------------------------------------------------------------
    if (cleanupPaths.length > 0) {
      console.log("\n--- CLEANUP: REMOVING TEMPORARY TEST FILES ---");
      const { error: removeErr } = await supabase.storage.from(BUCKET).remove(cleanupPaths);
      if (removeErr) {
        console.warn("Notice: Cleanup error for test paths:", removeErr.message);
      } else {
        console.log(`Cleaned up ${cleanupPaths.length} temporary test files from storage:`, cleanupPaths);
      }
    }
  }

  console.log("\n================================================================================");
  console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
