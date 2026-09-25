const BASE = "https://alfred.tailde2d45.ts.net";

export interface AgentActivityStep {
  id: string;
  position: number;
  action: string;
  state: string;
  integration: string | null;
  risk_level: string;
  dependency_count: number;
  why: string;
  updated_at: string;
  approval?: {
    id: string;
    risk_level: string;
    effect: string;
    dependency_count: number;
    verified_dependency_count: number;
    binding_count: number;
  };
}

export interface AgentActivityGoal {
  goal_id: string;
  plan_id: string;
  state: string;
  step_counts: Record<string, number>;
  current_step: AgentActivityStep | null;
  created_at: string;
  updated_at: string;
  recipe?: {
    id: string;
    title: string;
    version: number;
    instance_id: string;
  };
}

export interface AgentActivityApproval {
  approval_id: string;
  goal_id: string;
  plan_id: string;
  step_position: number;
  step_count: number;
  action: string;
  integration: string | null;
  risk_level: string;
  effect: string;
  dependency_count: number;
  verified_dependency_count: number;
  binding_count: number;
  why: string;
  risk_explanation: string;
  created_at: string;
  recipe?: AgentActivityGoal["recipe"];
}

export interface AgentActivityWorkItem {
  execution_id: string | null;
  plan_id: string | null;
  step_position: number | null;
  action: string;
  effect_class: string;
  outcome?: string;
  state?: string;
  verification_state?: string;
  error_type?: string | null;
  attempt_number?: number;
  attempt_count?: number;
  why?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AgentActivityRecipeRun {
  instance_id: string;
  recipe_id: string;
  recipe_title: string;
  recipe_version: number;
  workflow_id: string;
  goal_id: string;
  plan_id: string;
  run: {
    run_id: string;
    state: string;
    stop_reason: string | null;
    steps_attempted: number;
    started_at: string;
    completed_at: string | null;
  } | null;
  created_at: string;
}

export interface AgentActivityToday {
  mode: "agent_observability_v1";
  date: string;
  content_policy: "metadata_only";
  read_only: true;
  cloud_models: false;
  counts: {
    active_goals: number;
    waiting_approvals: number;
    completed_work_today: number;
    attention_items_today: number;
    recipe_runs_today: number;
  };
  active_goal_states: Record<string, number>;
  active_goals: AgentActivityGoal[];
  waiting_approvals: AgentActivityApproval[];
  completed_work: AgentActivityWorkItem[];
  attention_items: AgentActivityWorkItem[];
  recipe_runs: AgentActivityRecipeRun[];
}

export async function fetchAgentActivity(): Promise<AgentActivityToday> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/core/observability/today`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Can't reach Alfred's Dell. Check Tailscale and try again.");
  }
  if (!response.ok) {
    throw new Error(`Could not load Agent Activity (${response.status})`);
  }
  return (await response.json()) as AgentActivityToday;
}
