import type { CaptureItem } from "../types";

const STORAGE_KEY = "alfred:captures";

export function loadCaptures(): CaptureItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CaptureItem[]) : [];
  } catch {
    return [];
  }
}

export function saveCaptures(captures: CaptureItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(captures));
}
