import { useEffect, useState } from "react";
import { fetchDigestTriggerDay, setDigestTriggerDay } from "../integrations/digest/api";

const OPTIONS = [
  { value: "sunday", label: "Sunday evening" },
  { value: "monday", label: "Monday morning" },
] as const;

export function WeeklyDigestSettings() {
  const [day, setDay] = useState<"sunday" | "monday">();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchDigestTriggerDay()
      .then(setDay)
      .catch(() => setDay("sunday"));
  }, []);

  async function handleChange(value: "sunday" | "monday") {
    setDay(value);
    setSaving(true);
    try {
      await setDigestTriggerDay(value);
    } finally {
      setSaving(false);
    }
  }

  if (!day) return null;

  return (
    <div>
      <p className="mb-2 text-xs text-ink-soft dark:text-ink-soft-dark">
        When the weekly digest becomes available and pushes to ntfy.
      </p>
      <div className="flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => handleChange(option.value)}
            disabled={saving}
            className={`flex-1 rounded-full py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
              day === option.value
                ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                : "text-ink-soft dark:text-ink-soft-dark"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
