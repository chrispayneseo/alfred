import type { NoteItem, TaskItem } from "../types";

export const mockTasks: TaskItem[] = [
  { id: "t1", title: "Reply to Dan re: contract draft", done: false, due: "Today", project: "Freelance" },
  { id: "t2", title: "Book dentist appointment", done: false, due: "Today" },
  { id: "t3", title: "Review PR for Alfred scaffold", done: false, due: "Tomorrow", project: "Alfred" },
  { id: "t4", title: "Pay storage unit invoice", done: true, due: "Yesterday" },
];

export const mockNotes: NoteItem[] = [
  { id: "n1", title: "Alfred v2 ideas", excerpt: "Voice capture should transcribe locally before...", updatedAt: "Yesterday" },
  { id: "n2", title: "Holiday packing list", excerpt: "Passport, adapter, the good headphones...", updatedAt: "3 days ago" },
];
