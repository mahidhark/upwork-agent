/**
 * Typed wrappers over the Upwork MCP tools we use.
 *
 * Shapes were read from live schemas and get_tool_help, and are recorded in
 * docs/mcp-tool-surface.md. Traps worth remembering: job_reference wants the
 * numeric id and not the ~02… ciphertext; `Accepted` means submitted, not won;
 * and client_work_history is a 5+5 sample from which no total can be derived.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { toolJson } from './client.js';
import type { JobDetail } from '../screen/gates.js';

export interface SearchParams {
  query?: string;
  job_type?: 'fixed' | 'hourly';
  budget_min?: number;
  budget_max?: number;
  proposals_max?: number;
  client_hires_min?: number;
  client_hires_max?: number;
  verified_payment_only?: boolean;
  location?: string;
  sort?: 'recency' | 'relevance' | 'client_total_charge' | 'client_rating';
  limit?: number;
  cursor?: string;
}

export interface SearchHit {
  skills?: string[];
  id: string;
  title: string;
  url?: string;
  budget?: string;
  job_type?: string;
  proposal_count?: number;
  created_date: string;
  published_date?: string;
  description_snippet?: string;
}

export interface SearchPage {
  jobs: SearchHit[];
  hasMore: boolean;
  endCursor?: string;
}

export async function searchJobs(
  client: Client,
  orgUid: string,
  params: SearchParams,
): Promise<SearchPage> {
  const raw = toolJson<{
    jobs?: SearchHit[];
    hasMore?: boolean;
    pageInfo?: { endCursor?: string; hasNextPage?: boolean };
  }>(
    await client.callTool({
      name: 'upwork__find_jobs',
      arguments: { action: 'search', org_uid: orgUid, params },
    }),
  );
  return {
    jobs: raw.jobs ?? [],
    hasMore: Boolean(raw.pageInfo?.hasNextPage ?? raw.hasMore),
    endCursor: raw.pageInfo?.endCursor,
  };
}

/**
 * Full detail for one posting. This is the only place preferred_qualifications
 * and the client's hiring record appear — search does not carry them, which is
 * why the eligibility screen costs one call per candidate.
 */
export async function getJob(client: Client, orgUid: string, id: string): Promise<JobDetail> {
  const raw = toolJson<{
    can_apply?: boolean;
    connects_cost?: number;
    connects_balance?: number;
    client_record?: Record<string, unknown>;
    preferred_qualifications?: Record<string, unknown>;
    screening_questions?: string[];
    data?: {
      marketplaceJobPosting?: {
        id?: string;
        url?: string;
        content?: { title?: string; description?: string };
        contractTerms?: {
          contractType?: string;
          fixedPriceContractTerms?: { amount?: { rawValue?: string } };
          hourlyContractTerms?: {
            hourlyBudgetMin?: number;
            hourlyBudgetMax?: number;
            engagementType?: string;
          };
        };
        activityStat?: { jobActivity?: { totalHired?: number; invitesSent?: number } };
      };
    };
  }>(
    await client.callTool({
      name: 'upwork__find_jobs',
      arguments: { action: 'get', org_uid: orgUid, params: { id } },
    }),
  );

  const posting = raw.data?.marketplaceJobPosting;
  const amount = posting?.contractTerms?.fixedPriceContractTerms?.amount?.rawValue;
  const contractType = posting?.contractTerms?.contractType?.toLowerCase();
  const jobType = contractType === 'hourly' ? 'hourly' : contractType === 'fixed' ? 'fixed' : null;
  const hourly = posting?.contractTerms?.hourlyContractTerms;

  return {
    id: posting?.id ?? id,
    title: posting?.content?.title ?? '',
    description: posting?.content?.description ?? '',
    jobType,
    budget: amount == null ? null : Number(amount),
    hourlyMin: hourly?.hourlyBudgetMin ?? null,
    hourlyMax: hourly?.hourlyBudgetMax ?? null,
    proposalCountInferred: false,
    screeningQuestions: raw.screening_questions ?? [],
    skillTags: [],
    // The search hit carries created_date; get does not, so the caller supplies it.
    createdDate: new Date().toISOString(),
    proposalCount: null,
    canApply: raw.can_apply ?? false,
    connectsCost: raw.connects_cost ?? null,
    clientRecord: (raw.client_record ?? {}) as JobDetail['clientRecord'],
    preferredQualifications: (raw.preferred_qualifications ?? {}) as JobDetail['preferredQualifications'],
    jobActivity: (posting?.activityStat?.jobActivity ?? {}) as JobDetail['jobActivity'],
  };
}

export interface ConnectsBalance {
  connectsBalance: number;
  connectsBalanceFree: number;
  connectsBalancePaid: number;
}

export async function connectsBalance(client: Client, orgUid: string): Promise<ConnectsBalance> {
  const raw = toolJson<{ balance: ConnectsBalance }>(
    await client.callTool({
      name: 'upwork__get_profile',
      arguments: { action: 'connects_balance', org_uid: orgUid, params: {} },
    }),
  );
  return raw.balance;
}

export async function firstOrgUid(client: Client): Promise<string> {
  const raw = toolJson<{ accounts: Array<{ org_uid: string }> }>(
    await client.callTool({ name: 'upwork__list_accounts', arguments: {} }),
  );
  const uid = raw.accounts?.[0]?.org_uid;
  if (!uid) throw new Error('no Upwork account returned by list_accounts');
  return uid;
}

// ------------------------------------------------------------ the write path

export interface PreflightResult {
  clear: boolean;
  reason?: string;
}

/**
 * FR-10, mandatory before any create. Upwork rejects a create with VJ-JA-10 if
 * an invitation or prior proposal already exists for the job, which wastes the
 * turn — and an invitation needs accept_invitation rather than create anyway.
 */
export async function preflight(
  client: Client,
  orgUid: string,
  jobId: string,
): Promise<PreflightResult> {
  const invitations = toolJson<{ data?: { invitations?: Array<{ jobPosting?: { id?: string } }> } }>(
    await client.callTool({
      name: 'upwork__list_freelancer_proposals',
      arguments: { action: 'invitations', org_uid: orgUid, params: { status: 'pending', limit: 10 } },
    }),
  );
  for (const inv of invitations.data?.invitations ?? []) {
    if (inv.jobPosting?.id === jobId) {
      return { clear: false, reason: 'an invitation exists — use accept_invitation, not create' };
    }
  }

  const proposals = toolJson<{
    data?: { vendorProposals?: { edges?: Array<{ node?: { marketplaceJobPosting?: { id?: string } } }> } };
  }>(
    await client.callTool({
      name: 'upwork__list_freelancer_proposals',
      arguments: { action: 'list', org_uid: orgUid, params: { limit: 10 } },
    }),
  );
  for (const edge of proposals.data?.vendorProposals?.edges ?? []) {
    if (edge.node?.marketplaceJobPosting?.id === jobId) {
      return { clear: false, reason: 'a proposal for this job already exists' };
    }
  }

  return { clear: true };
}

export interface CreatePreview {
  draft_id: string;
  connects_cost?: number;
  connects_balance?: number;
  can_apply?: boolean;
  boost?: import('../submit/boost.js').BoostBlock;
  unmet_preferred_qualifications?: unknown;
}

/** Stages the proposal server-side. Spends nothing — only confirm does. */
export async function createProposal(
  client: Client,
  orgUid: string,
  params: {
    job_reference: string;
    cover_letter: string;
    charged_amount: number;
    boost_connects?: number;
    answers?: Array<{ question: string; answer: string }>;
  },
): Promise<CreatePreview> {
  const raw = toolJson<{ draft_id?: string; preview?: Record<string, unknown> }>(
    await client.callTool({
      name: 'upwork__manage_proposals',
      arguments: { action: 'create', org_uid: orgUid, params },
    }),
  );
  if (!raw.draft_id) throw new Error('create returned no draft_id');
  return { draft_id: raw.draft_id, ...(raw.preview as object) } as CreatePreview;
}

/** The only call that spends Connects. */
export async function confirmProposal(
  client: Client,
  orgUid: string,
  draftId: string,
): Promise<string> {
  const raw = toolJson<{
    data?: { createJobProposal?: { newProposalId?: string; status?: string } };
    status?: string;
  }>(
    await client.callTool({
      name: 'upwork__confirm_draft',
      arguments: { action: 'confirm', org_uid: orgUid, params: { type: 'proposal', draft_id: draftId } },
    }),
  );
  const id = raw.data?.createJobProposal?.newProposalId;
  if (!id) throw new Error(`confirm did not return a proposal id (status: ${raw.status})`);
  return id;
}
