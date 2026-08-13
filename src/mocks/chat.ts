const generalReplies = [
  "Got it — I've noted that down. Anything else on your mind?",
  "Makes sense. Want me to pull related notes from Notion once that's wired up?",
  "Noted. I'll surface this in tomorrow's briefing.",
  "Understood — flagging that as something to keep an eye on.",
];

const codeReplies = [
  "Looking at this like a debugging problem: what's the exact error message you're seeing?",
  "That sounds like a scoping issue — mind sharing the function around it?",
  "I'd start by adding a log right before the failure to narrow down where it breaks.",
  "Once the Anthropic API is wired in, I'll be able to actually run this against real code.",
];

let generalIndex = 0;
let codeIndex = 0;

export function nextMockReply(isCodeRelated: boolean): string {
  if (isCodeRelated) {
    const reply = codeReplies[codeIndex % codeReplies.length];
    codeIndex += 1;
    return reply;
  }
  const reply = generalReplies[generalIndex % generalReplies.length];
  generalIndex += 1;
  return reply;
}
