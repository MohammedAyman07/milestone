import { z } from "zod";

// Criterion-level outcomes: PASS, FAIL, INCONCLUSIVE
export const CriterionStatusEnum = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);

// Report-level statuses: VERIFIED, FAILED, NEEDS_EVIDENCE
export const ReportStatusEnum = z.enum(["VERIFIED", "FAILED", "NEEDS_EVIDENCE"]);

// Evidence quality levels
export const EvidenceQualityEnum = z.enum(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"]);

// Deterministic aggregation rule function:
// - VERIFIED only when every required criterion passes.
// - FAILED when at least one required criterion definitively fails.
// - NEEDS_EVIDENCE when no required criterion definitively fails but one or more remain inconclusive.
export function aggregateVerificationReportStatus(
  criteria: Array<{ result: "PASS" | "FAIL" | "INCONCLUSIVE" }>
): "VERIFIED" | "FAILED" | "NEEDS_EVIDENCE" {
  if (!criteria || criteria.length === 0) {
    return "NEEDS_EVIDENCE";
  }
  const hasFail = criteria.some((c) => c.result === "FAIL");
  if (hasFail) {
    return "FAILED";
  }
  const allPass = criteria.every((c) => c.result === "PASS");
  if (allPass) {
    return "VERIFIED";
  }
  return "NEEDS_EVIDENCE";
}

// Zod schema for single acceptance criterion evaluation
export const CriterionVerificationSchema = z.object({
  criterionId: z.string(),
  criterionText: z.string(),
  result: CriterionStatusEnum,
  explanation: z.string(),
  evidenceReferences: z.array(z.string()).default([]),
  missingEvidence: z.string().optional().default(""),
  confidenceScore: z.number().min(0).max(100),
  evidenceQuality: EvidenceQualityEnum.default("MEDIUM"),
  isDeterministicProof: z.boolean().optional().default(false),
  recommendedAction: z.string(),
});

// Zod schema for complete verification audit report from Gemini
export const VerificationAuditReportSchema = z.object({
  overallScore: z.number().min(0).max(100),
  overallStatus: ReportStatusEnum,
  overallEvidenceQuality: EvidenceQualityEnum.default("MEDIUM"),
  confidenceExplanation: z
    .string()
    .default(
      "Confidence scores measure AI assessment certainty given the submitted artifacts, not an empirical statistical probability."
    ),
  executiveSummary: z.string(),
  criteriaResults: z.array(CriterionVerificationSchema),
  unverifiedClaims: z.array(z.string()).default([]),
  advisoryNotice: z
    .string()
    .default(
      "AI Verification is advisory and based strictly on provided artifacts. Capital disbursement requires explicit client approval."
    ),
});

// Request body validation schemas
export const StagedFileRequestSchema = z.object({
  id: z.string().default(() => `f-${Date.now()}`),
  name: z.string().max(255),
  size: z.string().max(64),
  type: z.string().max(128),
  description: z.string().max(500).optional(),
  contentSnippet: z.string().max(50000).optional(),
});

export const VerifySubmissionRequestSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  milestoneId: z.string().min(1, "Milestone ID is required"),
  acceptanceCriteria: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .min(1, "At least one acceptance criterion is required"),
  notes: z.string().max(10000).optional(),
  repoUrl: z.string().max(500).optional(),
  stagingUrl: z.string().max(500).optional(),
  figmaUrl: z.string().max(500).optional(),
  files: z.array(StagedFileRequestSchema).max(20).optional(),
});

export const AnalyzeContractRequestSchema = z.object({
  title: z.string().max(255).optional(),
  description: z.string().max(20000).optional(),
  rawContractText: z.string().max(50000).optional(),
  totalBudget: z.number().min(0).max(10000000).optional(),
  deadline: z.string().max(100).optional(),
});

// Zod schema for contract analysis result
export const ContractAnalysisSuggestedMilestoneSchema = z.object({
  title: z.string(),
  description: z.string(),
  suggestedAmount: z.number().min(0),
  suggestedDeadline: z.string().optional().default(""),
  acceptanceCriteria: z.array(z.string()),
});

export const ContractAnalysisResultSchema = z.object({
  projectSummary: z.string(),
  deliverables: z.array(z.string()),
  suggestedMilestones: z.array(ContractAnalysisSuggestedMilestoneSchema),
  totalSuggestedBudget: z.number().min(0),
  ambiguousRequirements: z.array(z.string()),
  missingInformation: z.array(z.string()),
  scopeContradictions: z.array(z.string()),
  disclaimer: z.string(),
});
