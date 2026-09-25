const BASE = "https://alfred.tailde2d45.ts.net";

export interface DailyIntakeItem {
  id: string;
  source: "whatsapp_forward";
  state: "new" | "review" | "filed";
  kind: "note" | "task" | "reminder" | "clarify" | null;
  title: string | null;
  due: string | null;
  triaged_at: string | null;
  reviewed_at: string | null;
  core_request_id: string | null;
  approval_id: string | null;
  approval_state: string | null;
  proposed_at: string | null;
}

export interface DailyNeedItem {
  type: "intake" | "agent_approval" | "agent_attention";
  reason: string;
  id: string | null;
  source?: string;
  kind?: string | null;
  title?: string | null;
  due?: string | null;
  approval_id?: string | null;
  approval_state?: string | null;
  action?: string;
  risk_level?: string;
  state?: string;
  why?: string;
}

export interface DailyOperationsToday {
  mode: "daily_command_centre_v1";
  capture_mode: "reviewed_capture_v1";
  dispatch_mode: "phase5_guarded_dispatch_v1";
  date: string;
  content_policy: "owner_reviewed_titles_only";
  raw_forwarded_body_exposed: false;
  forwarded_detail_exposed: false;
  cloud_models: false;
  counts: {
    pending_intake: number;
    needs_you: number;
    open_local_items: number;
    due_today: number;
    overdue: number;
    active_goals: number;
    waiting_agent_approvals: number;
    completed_work_today: number;
    attention_items_today: number;
  };
  needs_you: DailyNeedItem[];
  pending_intake: DailyIntakeItem[];
  open_local_items: Array<{
    source_id: string;
    kind: "task" | "reminder";
    title: string;
    due: string | null;
    created_at: string;
  }>;
}

export interface WhatsAppCoreProposal {
  message_id: string;
  inbox_state: string;
  suggested_kind: string | null;
  core_request_id: string | null;
  approval_id: string | null;
  proposal_state: string | null;
  request_state: string | null;
  proposed_at: string | null;
}

async function coreRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Can't reach Alfred's Dell. Check Tailscale and try again.");
  }
  if (!response.ok) {
    const message = await response.json().catch(() => undefined) as { detail?: string } | undefined;
    throw new Error(message?.detail ?? `Alfred Core request failed (${response.status})`);
  }
  return response;
}

export async function fetchDailyOperations(): Promise<DailyOperationsToday> {
  const response = await coreRequest("/v1/core/daily/today");
  return await response.json() as DailyOperationsToday;
}

export async function reviewWhatsAppForCore(id: string, review: {
  kind: "note" | "task" | "reminder" | "clarify";
  title: string;
  due: string | null;
  detail: string;
}): Promise<void> {
  await coreRequest(`/v1/core/daily/intake/${encodeURIComponent(id)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(review),
  });
}

export async function proposeWhatsAppForCore(id: string): Promise<WhatsAppCoreProposal> {
  const response = await coreRequest(`/v1/core/daily/intake/${encodeURIComponent(id)}/propose`, {
    method: "POST",
  });
  return await response.json() as WhatsAppCoreProposal;
}

export async function resolveWhatsAppCore(id: string, approved: boolean): Promise<{
  message_id: string;
  approval_id: string;
  approved: boolean;
  state: string;
  inbox_state: string;
}> {
  const response = await coreRequest(`/v1/core/daily/intake/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  return await response.json() as {
    message_id: string;
    approval_id: string;
    approved: boolean;
    state: string;
    inbox_state: string;
  };
}
