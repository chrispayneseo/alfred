export interface ReviewItem {
  id: string;
  kind: "single" | "recurring" | "unclear";
  title: string;
  date: string | null;
  endDate: string | null;
  time: string | null;
  weekday?: string;
  dates?: string[];
  duplicate: boolean;
  duplicateOf?: string;
  unclearReason?: string;
}

export interface ExtractResult {
  monthYear: string;
  items: ReviewItem[];
}

export interface CreateResultItem {
  title: string;
  date: string;
  ok: boolean;
  error?: string;
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export function extractCalendarPhoto(imageBase64: string, mimeType: string): Promise<ExtractResult> {
  return request("/api/calendar/photo-scan/extract", { imageBase64, mimeType });
}

export interface ApprovedItem {
  kind: "single" | "recurring";
  title: string;
  date: string;
  endDate: string | null;
  time: string | null;
  person?: string;
  recurrence?: "weekly" | "monthly" | "yearly";
  dates?: string[];
}

export function createCalendarPhotoEvents(items: ApprovedItem[]): Promise<{ results: CreateResultItem[] }> {
  return request("/api/calendar/photo-scan/create", { items });
}
