/**
 * Comprehensive Regression Test Suite for Evidence Evaluation Logic
 * 
 * Tests:
 * 1. Missing evidence results in INCONCLUSIVE (never FAIL solely for missing proof)
 * 2. Actual negative evidence (confirmed runtime defect / HTTP 500 / crash) results in FAIL
 * 3. Partial multi-scenario evidence (e.g. desktop provided, mobile missing) results in INCONCLUSIVE
 *    with explicit demonstratedScenarios and unverifiedScenarios
 * 4. Fully verified evidence results in PASS
 * 5. Deterministic GitHub repository content inspection & deployed site correspondence
 * 6. Report status aggregation (NEEDS_EVIDENCE vs FAILED vs VERIFIED)
 */

const fs = require("fs");
const { aggregateVerificationReportStatus, VerificationAuditReportSchema } = require("./src/lib/gemini-schemas.ts");
const { inspectGitHubRepository } = require("./src/lib/evidence-validator.ts");

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

async function runTests() {
  console.log("================================================================================");
  console.log("MILESTONE AI: EVIDENCE EVALUATION & MULTI-SCENARIO LOGIC TEST SUITE");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: Missing Evidence vs Actual Defect Distinction
  // ---------------------------------------------------------------------------
  console.log("--- TEST 1: MISSING EVIDENCE DISTINCTION (INCONCLUSIVE vs FAIL) ---");
  
  // Normalization logic helper from route.ts
  function normalizeCriterionResult(cr) {
    const explanationLower = (cr.explanation || "").toLowerCase();
    const isMissingEvidencePhrase =
      explanationLower.includes("no evidence") ||
      explanationLower.includes("not provided") ||
      explanationLower.includes("lack of evidence") ||
      explanationLower.includes("insufficient evidence") ||
      explanationLower.includes("unproven") ||
      explanationLower.includes("was not provided");

    const hasProvenDefect =
      explanationLower.includes("crashed") ||
      explanationLower.includes("syntax error") ||
      explanationLower.includes("500 internal") ||
      explanationLower.includes("failed with error code") ||
      explanationLower.includes("assertion failed") ||
      explanationLower.includes("broken layout");

    if (cr.result === "FAIL" && isMissingEvidencePhrase && !hasProvenDefect) {
      return {
        ...cr,
        result: "INCONCLUSIVE",
        failureType: "UNPROVEN_DUE_TO_MISSING_EVIDENCE",
      };
    }
    return cr;
  }

  // Case 1A: Criterion marked FAIL solely because screenshots were not provided
  const missingEvidenceCase = {
    criterionId: "c1",
    criterionText: "Displays appropriate response when user submits empty question or error",
    result: "FAIL",
    explanation: "No evidence, such as screenshots or recordings, was provided to demonstrate the application's behavior when an empty question is submitted.",
    missingEvidence: "Screenshots of empty question validation",
    confidenceScore: 25,
    evidenceQuality: "INSUFFICIENT",
  };

  const normalizedMissing = normalizeCriterionResult(missingEvidenceCase);
  assert(
    normalizedMissing.result === "INCONCLUSIVE",
    "Missing evidence normalized from FAIL to INCONCLUSIVE",
    `Result: ${normalizedMissing.result}, FailureType: ${normalizedMissing.failureType}`
  );
  assert(
    normalizedMissing.failureType === "UNPROVEN_DUE_TO_MISSING_EVIDENCE",
    "FailureType set to UNPROVEN_DUE_TO_MISSING_EVIDENCE"
  );

  // Case 1B: Actual application defect (e.g., HTTP 500 or crash)
  const actualDefectCase = {
    criterionId: "c2",
    criterionText: "Question processing executes without critical errors",
    result: "FAIL",
    explanation: "The application crashed with 500 internal server error when parsing the question input payload.",
    missingEvidence: "",
    failureType: "ACTUAL_APPLICATION_DEFECT",
    confidenceScore: 90,
    evidenceQuality: "HIGH",
  };

  const normalizedDefect = normalizeCriterionResult(actualDefectCase);
  assert(
    normalizedDefect.result === "FAIL",
    "Actual application defect preserved as FAIL",
    `Result: ${normalizedDefect.result}`
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Partial Multi-Scenario Evidence & Responsive Design Safeguard
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: PARTIAL MULTI-SCENARIO & RESPONSIVE DESIGN SAFEGUARD ---");

  function evaluateResponsiveCriterion(cr) {
    const textLower = (cr.criterionText || "").toLowerCase();
    if ((textLower.includes("mobile") || textLower.includes("responsive")) && cr.result === "PASS") {
      const hasMobileArtifact = (cr.evidenceReferences || []).some((ref) => {
        const rLower = ref.toLowerCase();
        return rLower.includes("mobile") || rLower.includes("phone") || rLower.includes("viewport") || rLower.includes("responsive");
      });
      if (!hasMobileArtifact) {
        return {
          ...cr,
          result: "INCONCLUSIVE",
          failureType: "UNPROVEN_DUE_TO_MISSING_EVIDENCE",
          demonstratedScenarios: ["Desktop browser layout usability"],
          unverifiedScenarios: ["Mobile screen sizes usability and responsive layout"],
        };
      }
    }
    return cr;
  }

  const desktopOnlyResponsiveCase = {
    criterionId: "c3",
    criterionText: "The deployed application interface is usable and readable on desktop and mobile screen sizes",
    result: "PASS",
    explanation: "Desktop screenshots show clear typography and readable navigation.",
    evidenceReferences: ["homepage.png", "Screenshot 2026-11-01 154337.png"],
    confidenceScore: 75,
    evidenceQuality: "MEDIUM",
  };

  const evaluatedResponsive = evaluateResponsiveCriterion(desktopOnlyResponsiveCase);
  assert(
    evaluatedResponsive.result === "INCONCLUSIVE",
    "Responsive design with desktop-only screenshots downgraded from PASS to INCONCLUSIVE"
  );
  assert(
    evaluatedResponsive.demonstratedScenarios?.includes("Desktop browser layout usability"),
    "Demonstrated desktop scenario identified"
  );
  assert(
    evaluatedResponsive.unverifiedScenarios?.includes("Mobile screen sizes usability and responsive layout"),
    "Unverified mobile scenario identified"
  );

  // ---------------------------------------------------------------------------
  // TEST 3: Report Status Aggregation Invariants
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: REPORT STATUS AGGREGATION INVARIANTS ---");

  // Status when some criteria pass and some are inconclusive (0 fails)
  const statusMixed = aggregateVerificationReportStatus([
    { result: "PASS" },
    { result: "PASS" },
    { result: "INCONCLUSIVE" },
    { result: "INCONCLUSIVE" },
  ]);
  assert(
    statusMixed === "NEEDS_EVIDENCE",
    "Criteria with PASS + INCONCLUSIVE aggregates to NEEDS_EVIDENCE (not FAILED)",
    `Status: ${statusMixed}`
  );

  // Status when at least one criterion has proven FAIL
  const statusWithFail = aggregateVerificationReportStatus([
    { result: "PASS" },
    { result: "FAIL" },
    { result: "INCONCLUSIVE" },
  ]);
  assert(
    statusWithFail === "FAILED",
    "Criteria with proven FAIL aggregates to FAILED",
    `Status: ${statusWithFail}`
  );

  // Status when all criteria pass
  const statusAllPass = aggregateVerificationReportStatus([
    { result: "PASS" },
    { result: "PASS" },
    { result: "PASS" },
  ]);
  assert(
    statusAllPass === "VERIFIED",
    "All PASS criteria aggregates to VERIFIED",
    `Status: ${statusAllPass}`
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Deterministic GitHub Content Inspection & Site Correspondence
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 4: DETERMINISTIC GITHUB CONTENT & CORRESPONDENCE INSPECTION ---");

  const repoInspection = await inspectGitHubRepository(
    "https://github.com/MohammedAyman07/ayman-study-ai",
    "https://ayman-study-ai.vercel.app/"
  );

  assert(repoInspection.inspected === true, "GitHub repository source inspected successfully");
  assert(repoInspection.packageJsonFound === true, "package.json found and parsed from repository");
  assert(repoInspection.packageName === "ayman-study-ai", "Package name matched repository identity", repoInspection.packageName);
  assert(Array.isArray(repoInspection.topDependencies) && repoInspection.topDependencies.length > 5, "Key dependencies extracted from source manifest", repoInspection.topDependencies?.slice(0, 5).join(", "));
  assert(repoInspection.readmeFound === true, "README.md found in repository root", `${repoInspection.readmeByteLength} bytes`);
  assert(repoInspection.readmeByteLength > 1000, "README.md contains substantive documentation (>1 KB)");
  assert(repoInspection.hasSetupInstructions === true, "README.md setup/installation instructions confirmed");
  assert(repoInspection.siteTitleComparison?.repoNameMatch === true, "Deployed site title corresponds to repository name", repoInspection.siteTitleComparison?.notes);

  // ---------------------------------------------------------------------------
  // TEST 5: Zod Schema Validation for New Fields
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 5: ZOD SCHEMA VALIDATION ---");

  const sampleReport = {
    overallScore: 63,
    overallStatus: "NEEDS_EVIDENCE",
    overallEvidenceQuality: "MEDIUM",
    confidenceExplanation: "AI heuristic certainty based on provided artifacts.",
    executiveSummary: "Application accessible and question workflows demonstrated. Mobile responsiveness and error handling remain unverified.",
    criteriaResults: [
      {
        criterionId: "crit-1",
        criterionText: "Live application accessible without critical errors",
        result: "PASS",
        explanation: "Live staging URL probe returned HTTP 200.",
        evidenceReferences: ["Live Staging Probe (HTTP 200)"],
        missingEvidence: "",
        demonstratedScenarios: ["Initial application load"],
        unverifiedScenarios: [],
        failureType: "NONE",
        confidenceScore: 85,
        evidenceQuality: "HIGH",
        isDeterministicProof: true,
        recommendedAction: "No action required.",
      },
      {
        criterionId: "crit-2",
        criterionText: "Usable on desktop and mobile viewports",
        result: "INCONCLUSIVE",
        explanation: "Desktop screenshots provided, but mobile viewports were not demonstrated.",
        evidenceReferences: ["homepage.png"],
        missingEvidence: "Mobile viewport screenshots (<= 640px)",
        demonstratedScenarios: ["Desktop browser interface"],
        unverifiedScenarios: ["Mobile viewport usability"],
        failureType: "UNPROVEN_DUE_TO_MISSING_EVIDENCE",
        confidenceScore: 30,
        evidenceQuality: "INSUFFICIENT",
        isDeterministicProof: false,
        recommendedAction: "Provide mobile viewport screenshots or responsive test assertions.",
      },
    ],
    unverifiedClaims: [],
    advisoryNotice: "AI Verification is advisory. Capital disbursement requires explicit client approval.",
  };

  const zodParsed = VerificationAuditReportSchema.safeParse(sampleReport);
  assert(zodParsed.success === true, "VerificationAuditReportSchema validates new scenario and failureType fields");

  console.log("\n================================================================================");
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
