export async function fetchExport(): Promise<unknown> {
  const res = await fetch("/api/settings/export");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function wipeEverything(): Promise<void> {
  const res = await fetch("/api/settings/wipe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "delete" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
}
