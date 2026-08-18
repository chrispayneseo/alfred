export interface NewsTopic {
  id: string;
  name: string;
  preferredDomains: string[];
}

export interface NewsFeedItem {
  id: string;
  topicName: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
  origin: "web" | "newsletter";
}

export interface NewsFeedResult {
  dateKey: string;
  items: NewsFeedItem[];
  generatedAt: string;
}

export interface PendingTopicSuggestion {
  id: string;
  suggestedName: string;
  reason: string;
}

export async function fetchNewsFeed(): Promise<NewsFeedResult> {
  const res = await fetch("/api/news-feed");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function fetchNewsTopics(): Promise<NewsTopic[]> {
  const res = await fetch("/api/news-feed/topics");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function addNewsTopic(name: string): Promise<NewsTopic> {
  const res = await fetch("/api/news-feed/topics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function removeNewsTopic(id: string): Promise<void> {
  const res = await fetch(`/api/news-feed/topics/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

/** Replaces a topic's preferred-domains list wholesale — an empty array
 * clears the restriction back to an open-web search for that topic. */
export async function setNewsTopicDomains(id: string, domains: string[]): Promise<NewsTopic> {
  const res = await fetch(`/api/news-feed/topics/${encodeURIComponent(id)}/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domains }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function checkTopicSuggestions(): Promise<PendingTopicSuggestion[]> {
  const res = await fetch("/api/news-feed/topic-suggestions");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function acceptTopicSuggestion(id: string): Promise<void> {
  const res = await fetch(`/api/news-feed/topic-suggestions/${encodeURIComponent(id)}/accept`, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export async function dismissTopicSuggestion(id: string): Promise<void> {
  const res = await fetch(`/api/news-feed/topic-suggestions/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}
