-- Alfred Core owns this data. Models and integrations only receive scoped,
-- retrieved context; they do not write these tables directly.

create table if not exists alfred_users (
  id uuid primary key,
  display_name text not null,
  trust_level text not null check (trust_level in ('owner', 'trusted', 'untrusted', 'service')),
  created_at timestamptz not null default now()
);

create table if not exists alfred_requests (
  id uuid primary key,
  user_id uuid references alfred_users(id),
  channel text not null,
  conversation_id text not null,
  message text not null,
  policy_level text not null,
  policy_decision text not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists alfred_memories (
  id uuid primary key,
  owner_id uuid not null references alfred_users(id),
  kind text not null check (kind in ('profile', 'project', 'episodic', 'knowledge')),
  scope text not null default 'global',
  content text not null,
  confidence numeric(3,2) not null default 1 check (confidence >= 0 and confidence <= 1),
  source text not null,
  source_reference text,
  status text not null default 'active' check (status in ('proposed', 'active', 'superseded', 'deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_document tsvector generated always as (to_tsvector('english', content)) stored
);

create index if not exists alfred_memories_owner_scope_idx on alfred_memories(owner_id, scope, kind, status);
create index if not exists alfred_memories_search_idx on alfred_memories using gin(search_document);

create table if not exists alfred_plans (
  id uuid primary key,
  request_id uuid references alfred_requests(id),
  owner_id uuid not null references alfred_users(id),
  goal text not null,
  state text not null check (state in ('draft', 'awaiting_approval', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists alfred_approvals (
  id uuid primary key,
  plan_id uuid references alfred_plans(id),
  request_id uuid references alfred_requests(id),
  action_summary text not null,
  risk_level text not null,
  state text not null check (state in ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references alfred_users(id)
);

create table if not exists alfred_audit_events (
  id uuid primary key,
  occurred_at timestamptz not null,
  event_type text not null,
  request_id uuid,
  conversation_id text,
  data jsonb not null default '{}'::jsonb
);

create index if not exists alfred_audit_events_request_idx on alfred_audit_events(request_id, occurred_at desc);
