const BASE = "https://alfred.tailde2d45.ts.net";

export interface AgentInboxItem {
  id: string | null;
  type: string;
  state: "needs_you" | "working" | "done";
  title: string;
  reason: string;
  due?: string | null;
  risk_level?: string | null;
  step_state?: string | null;
  completed_at?: string | null;
  route: string;
}

export interface AgentInbox {
  mode: "agent_inbox_v1";
  content_policy: "metadata_and_owner_reviewed_titles";
  raw_forwarded_body_exposed: false;
  tool_arguments_exposed: false;
  tool_results_exposed: false;
  counts: {
    needs_you: number;
    working: number;
    done: number;
  };
  needs_you: AgentInboxItem[];
  working: AgentInboxItem[];
  done: AgentInboxItem[];
}

export interface PersonalSearchResult {
  id: string;
  kind: string;
  memory_type?: string | null;
  title: string;
  snippet: string;
  due?: string | null;
  url?: string | null;
  source?: string | null;
  score?: number | null;
}

export interface PersonalSearchResponse {
  mode: "personal_search_local_first_v1";
  query: string;
  count: number;
  results: PersonalSearchResult[];
  cloud_models: false;
  connected_account_search: "use_command_interface";
}

export interface AttentionNotification {
  id: string;
  level: "attention" | "completed";
  title: string;
  reason: string;
  route: string;
}

export interface AttentionFeed {
  mode: "event_driven_attention_v1";
  delivery: "in_app_event_feed";
  daily_briefing: false;
  unsolicited_cloud_reasoning: false;
  count: number;
  items: AttentionNotification[];
}

async function coreRequest(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Can't reach Alfred's Dell. Check Tailscale and try again.");
  }
  if (!response.ok) {
    const message = await response.json().catch(() => undefined) as { detail?: string } | undefined;
    throw new Error(message?.detail ?? `Alfred Core request failed (${response.status})`);
  }
  return response;
}

export async function fetchAgentInbox(): Promise<AgentInbox> {
  const response = await coreRequest("/v1/core/experience/inbox");
  return await response.json() as AgentInbox;
}

export async function searchAlfred(query: string, limit = 16): Promise<PersonalSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await coreRequest(`/v1/core/experience/search?${params.toString()}`);
  return await response.json() as PersonalSearchResponse;
}

export async function fetchAttentionFeed(): Promise<AttentionFeed> {
  const response = await coreRequest("/v1/core/experience/notifications");
  return await response.json() as AttentionFeed;
}
