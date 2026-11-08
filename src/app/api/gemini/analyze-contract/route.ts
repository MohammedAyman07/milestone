import { NextRequest, NextResponse } from "next/server";
import { generateContentWithResilience, extractJsonFromResponse } from "@/lib/gemini";
import {
  AnalyzeContractRequestSchema,
  ContractAnalysisResultSchema,
} from "@/lib/gemini-schemas";
import { checkRateLimit } from "@/lib/rate-limiter";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Rate limiting check
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  const rateCheck = checkRateLimit(`contract:${clientIp}`, 20, 60000);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded. Please wait before requesting another contract analysis.",
        retryAfterMs: rateCheck.resetMs,
      },
      { status: 429 }
    );
  }

  // Payload size check
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 2 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Payload too large. Maximum contract request payload is 2 MB." },
      { status: 413 }
    );
  }

  try {
    const rawBody = await req.json();

    const parsedBody = AnalyzeContractRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json(
        {
          error: "Invalid contract analysis request parameters.",
          details: parsedBody.error.format(),
        },
        { status: 400 }
      );
    }

    const { title, description, rawContractText, totalBudget, deadline } = parsedBody.data;

    if (!description && !rawContractText) {
      return NextResponse.json(
        { error: "Project description or contract text is required for analysis." },
        { status: 400 }
      );
    }

    const prompt = `You are the MILESTONE AI Contract Analysis Specialist.
Your task is to analyze contract specifications and project scopes to recommend realistic, testable milestones and identify ambiguities.

INPUT DETAILS:
Project Title: ${title || "Untitled Project"}
Project Description: ${description || "None provided"}
Contract Agreement Text: ${rawContractText || "None provided"}
Contract Total Budget: ${totalBudget ? `$${totalBudget} USD` : "Not explicitly specified"}
Contract Deadline: ${deadline || "Not explicitly specified"}

RULES FOR CONTRACT EXTRACTION & STRUCTURING:
1. Never invent contract terms, dates, budgets or deliverables that are not stated or strongly implied.
2. Mark missing information as explicitly unknown or missing.
3. Distinguish extracted facts from your suggested milestones.
4. Flag ambiguous requirements so the client can clarify them with the freelancer BEFORE scoping work.
5. Identify any internal contradictions in the scope (e.g. tight deadline vs huge scope).
6. Total suggested milestone amounts must sum up reasonably to or within the agreed budget ($${totalBudget || 1000} USD).
7. Acceptance criteria for each milestone must be testable, verifiable, and specific.

OUTPUT JSON FORMAT:
You MUST respond with valid JSON matching this exact structure:
{
  "projectSummary": "<factual summary of the contract requirements>",
  "deliverables": ["<explicit deliverable 1>", "<explicit deliverable 2>"],
  "suggestedMilestones": [
    {
      "title": "<Milestone title with Phase #>",
      "description": "<detailed milestone scope>",
      "suggestedAmount": <number for milestone budget>,
      "suggestedDeadline": "<suggested due date if estimable>",
      "acceptanceCriteria": [
        "<measurable criterion 1>",
        "<measurable criterion 2>"
      ]
    }
  ],
  "totalSuggestedBudget": <sum of suggested amounts>,
  "ambiguousRequirements": ["<ambiguous requirement 1 that needs clarification>"],
  "missingInformation": ["<missing information such as staging credentials, design assets, etc.>"],
  "scopeContradictions": ["<any scope or timeline contradictions>"],
  "disclaimer": "This analysis is an AI-assisted suggestion. Client review and explicit approval are required before any milestones are created or funds committed."
}
`;

    const { text: rawText } = await generateContentWithResilience(prompt);
    const cleanJson = extractJsonFromResponse(rawText);

    let parsedData;
    try {
      parsedData = JSON.parse(cleanJson);
    } catch {
      return NextResponse.json(
        { error: "Gemini did not return valid JSON output." },
        { status: 502 }
      );
    }

    const validationResult = ContractAnalysisResultSchema.safeParse(parsedData);
    if (!validationResult.success) {
      console.error("Contract Analysis Zod Error:", validationResult.error.format());
      return NextResponse.json(
        {
          error: "Gemini response did not match the contract analysis schema.",
          details: validationResult.error.format(),
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, analysis: validationResult.data });
  } catch (err: unknown) {
    console.error("AI Contract Analysis Error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: "Failed to run contract analysis", message },
      { status: 500 }
    );
  }
}
