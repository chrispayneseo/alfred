export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const res = await fetch("/api/capture/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: audioBase64, mimeType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Transcription failed (${res.status})`);
  }
  const { text } = (await res.json()) as { text: string };
  return text;
}
