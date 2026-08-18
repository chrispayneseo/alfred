// The narrow set of terms that scope Evie (the school-email monitor) to
// school-related mail only — matched against the already-synced gmail_emails
// cache (see store.ts), not a live Gmail search. Deliberately narrow (an
// explicit requirement, not an oversight): a sender-domain match AND at
// least one keyword match, rather than a general inbox scan.
export const EVIE_SENDER_FILTER = "halterworth";

export const EVIE_KEYWORD_TERMS = [
  "Evie Payne-Hewitt",
  "Payne-Hewitt",
  "Pearson",
  "Class Australia",
  "Year 3",
  "Choir Club",
  "Cooking Club",
];
