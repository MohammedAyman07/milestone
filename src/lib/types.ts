export type ProjectStatus =
  | "draft"
  | "active"
  | "in_progress"
  | "completed"
  | "on_hold";

export type MilestoneStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "under_review"
  | "approved"
  | "completed";

export type PaymentStatus =
  | "unauthorized"
  | "authorized"
  | "captured"
  | "voided"
  | "refunded"
  | "failed";

export type UserRole = "client" | "freelancer";

export interface AcceptanceCriterion {
  id: string;
  label: string;
  description?: string;
  isPassed?: boolean;
}

export interface StagedFile {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  type: string;
  description?: string;
  contentSnippet?: string; // Text snippet or base64 data for AI inspection
  storagePath?: string;
  signedUrl?: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  amount: number;
  currency: string;
  dueDate: string;
  phase: number;
  totalPhases: number;
  status: MilestoneStatus;
  paymentStatus: PaymentStatus;
  acceptanceCriteria: AcceptanceCriterion[];
  authorizedDate?: string;
  capturedDate?: string;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
}

export type EvidenceQuality = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export type ReportVerificationStatus = "VERIFIED" | "FAILED" | "NEEDS_EVIDENCE";
export type CriterionStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface CriterionVerificationResult {
  criterionId: string;
  criterionText: string;
  result: CriterionStatus;
  explanation: string;
  evidenceReferences: string[];
  missingEvidence?: string;
  confidenceScore: number; // 0 to 100: AI heuristic assessment confidence based solely on artifacts
  evidenceQuality: EvidenceQuality;
  isDeterministicProof?: boolean;
  recommendedAction: string;
}

export interface VerificationAuditReport {
  id: string;
  submissionId: string;
  projectId: string;
  milestoneId: string;
  timestamp: string;
  overallScore: number;
  overallStatus: ReportVerificationStatus;
  overallEvidenceQuality: EvidenceQuality;
  confidenceExplanation: string;
  executiveSummary: string;
  criteriaResults: CriterionVerificationResult[];
  unverifiedClaims: string[];
  advisoryNotice: string;
  modelUsed?: string;
  deterministicAudit?: {
    filesValid: boolean;
    fileErrors: string[];
    githubReachable: boolean;
    githubDetails: string;
    stagingReachable: boolean;
    stagingDetails: string;
  };
  clientReviewed?: boolean;
  clientDecision?: "pending" | "approved" | "revisions_requested" | "rejected";
  clientNotes?: string;
}

export interface Submission {
  id: string;
  milestoneId: string;
  projectId: string;
  repoUrl: string;
  stagingUrl?: string;
  figmaUrl?: string;
  notes: string;
  files: StagedFile[];
  submittedAt: string;
  status: "submitted" | "under_review" | "approved" | "revision_requested";
  aiConfidence?: number;
  auditReport?: VerificationAuditReport;
}

export interface Counterparty {
  id?: string;
  name: string;
  email: string;
  role: string;
  avatar?: string;
  paypalMerchantId?: string;
  rating?: number;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  budget: number;
  currency: string;
  startDate: string;
  deadline: string;
  status: ProjectStatus;
  clientId?: string;
  freelancerId?: string;
  client: Counterparty;
  freelancer: Counterparty;
  milestones: Milestone[];
  image?: string;
  createdAt: string;
}

export interface TransactionRecord {
  id: string;
  transactionRef: string;
  projectId: string;
  projectName: string;
  milestoneTitle: string;
  amount: number;
  currency: string;
  date: string;
  type: "authorization" | "capture" | "refund";
  status: "AUTHORIZED" | "CAPTURED" | "SETTLED" | "PENDING" | "VOIDED";
  payee: string;
  paymentMethod: string;
  paypalOrderId?: string;
}

// Contract Analysis Models
export interface ContractAnalysisSuggestedMilestone {
  title: string;
  description: string;
  suggestedAmount: number;
  suggestedDeadline?: string;
  acceptanceCriteria: string[];
}

export interface ContractAnalysisResult {
  projectSummary: string;
  deliverables: string[];
  suggestedMilestones: ContractAnalysisSuggestedMilestone[];
  totalSuggestedBudget: number;
  ambiguousRequirements: string[];
  missingInformation: string[];
  scopeContradictions: string[];
  disclaimer: string;
}
