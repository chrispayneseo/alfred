// A small, deliberately generic club-colors badge (navy, gold trim, white)
// for the Tickets section header — not the club's actual crest, which is a
// registered trademark. Just a shield outline with "LUFC" text, sized to
// sit inline with a section heading.
export function LeedsBadge({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path
        d="M12 2 L20 5 V11 C20 16.2 16.6 20.2 12 22 C7.4 20.2 4 16.2 4 11 V5 Z"
        fill="#16233F"
        stroke="#D4AF37"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <text x="12" y="13.5" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#FFFFFF" fontFamily="system-ui, sans-serif">
        LUFC
      </text>
    </svg>
  );
}
