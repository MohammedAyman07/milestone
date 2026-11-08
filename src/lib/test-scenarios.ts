import { AcceptanceCriterion, StagedFile } from "@/lib/types";

export interface TestScenario {
  id: string;
  name: string;
  description: string;
  expectedOverallStatus: "PASS" | "FAIL" | "NEEDS_EVIDENCE";
  acceptanceCriteria: AcceptanceCriterion[];
  notes: string;
  repoUrl: string;
  stagingUrl: string;
  figmaUrl?: string;
  files: StagedFile[];
}

export const testScenarios: TestScenario[] = [
  // Scenario 1: Clearly Satisfied Criteria
  {
    id: "scenario-satisfied",
    name: "Scenario 1: Fully Satisfied Criteria",
    description: "All acceptance criteria have concrete proof (passing test logs, staging URL, token exports).",
    expectedOverallStatus: "PASS",
    acceptanceCriteria: [
      {
        id: "c-sat-1",
        label: "Lighthouse Performance and Accessibility Score >= 90",
        description: "Audit reports must show raw scores exceeding 90.",
      },
      {
        id: "c-sat-2",
        label: "Design token variable export matches Figma specs",
        description: "Exported spacing and color palette tokens conform to design guidelines.",
      },
    ],
    notes: "Completed all responsive components. Lighthouse audit reports attached showing performance 98 and accessibility 100.",
    repoUrl: "https://github.com/agency/website-redesign/commit/4a89f2",
    stagingUrl: "https://staging.acmecorp-redesign.com",
    figmaUrl: "https://figma.com/file/acme-design-tokens-v2",
    files: [
      {
        id: "f-sat-1",
        name: "lighthouse-audit.pdf",
        size: "1.2 MB",
        type: "application/pdf",
        description: "Official Lighthouse performance audit confirming 98/100 score on staging URL.",
      },
      {
        id: "f-sat-2",
        name: "figma-design-tokens.json",
        size: "240 KB",
        type: "application/json",
        description: "Complete design token variables export matching Figma tokens.",
      },
    ],
  },

  // Scenario 2: Clearly Failed Criteria
  {
    id: "scenario-failed",
    name: "Scenario 2: Clearly Failed Criteria",
    description: "Criteria failed (Lighthouse score below threshold, tests failing in report).",
    expectedOverallStatus: "FAIL",
    acceptanceCriteria: [
      {
        id: "c-fail-1",
        label: "Lighthouse score strictly >= 95 across all runs",
        description: "Performance must not drop below 95.",
      },
      {
        id: "c-fail-2",
        label: "Automated unit test suite passes with zero failures",
        description: "All unit tests must pass with 100% success rate.",
      },
    ],
    notes: "We deployed staging, but automated performance scored 62/100 due to unoptimized images, and 4 unit tests failed.",
    repoUrl: "https://github.com/agency/website-redesign/commit/fail-test-123",
    stagingUrl: "https://staging-failed.acmecorp-redesign.com",
    files: [
      {
        id: "f-fail-1",
        name: "lighthouse-audit-failing.pdf",
        size: "1.0 MB",
        type: "application/pdf",
        description: "Lighthouse audit showing score 62/100 (below threshold of 95).",
      },
      {
        id: "f-fail-2",
        name: "jest-test-results.json",
        size: "150 KB",
        type: "application/json",
        description: "Jest test output showing 4 failing tests in auth module.",
      },
    ],
  },

  // Scenario 3: Insufficient Evidence (INCONCLUSIVE)
  {
    id: "scenario-insufficient",
    name: "Scenario 3: Insufficient Evidence",
    description: "Criteria cannot be validated because no test reports or raw proof artifacts are attached.",
    expectedOverallStatus: "NEEDS_EVIDENCE",
    acceptanceCriteria: [
      {
        id: "c-inc-1",
        label: "End-to-end payment gateway transaction completed in sandbox",
        description: "Must provide transaction receipt ID and webhook log confirmation.",
      },
      {
        id: "c-inc-2",
        label: "Zero SQL injection or security vulnerabilities on static scan",
        description: "Must provide security scan report from Snyk or SonarQube.",
      },
    ],
    notes: "I tested the payment gateway manually and it works on my machine. No scan tool was run yet.",
    repoUrl: "https://github.com/agency/website-redesign/commit/unknown",
    stagingUrl: "https://staging.acmecorp-redesign.com",
    files: [], // Zero evidence files attached
  },
];
