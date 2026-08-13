import type { NoteItem, ProjectItem, TaskItem } from "../types";

export const browseTasks: TaskItem[] = [
  { id: "bt1", title: "Reply to Dan re: contract draft", done: false, due: "Today", project: "Freelance" },
  { id: "bt2", title: "Book dentist appointment", done: false, due: "Today" },
  { id: "bt3", title: "Review PR for Alfred scaffold", done: false, due: "Tomorrow", project: "Alfred" },
  { id: "bt4", title: "Pay storage unit invoice", done: true, due: "Yesterday" },
  { id: "bt5", title: "Draft Q3 goals doc", done: false, due: "Fri", project: "Work" },
  { id: "bt6", title: "Order new desk mat", done: false },
];

export const browseNotes: NoteItem[] = [
  { id: "bn1", title: "Alfred v2 ideas", excerpt: "Voice capture should transcribe locally before syncing...", updatedAt: "Yesterday" },
  { id: "bn2", title: "Holiday packing list", excerpt: "Passport, adapter, the good headphones...", updatedAt: "3 days ago" },
  { id: "bn3", title: "Book recommendations from Sam", excerpt: "The Design of Everyday Things, Consider the Lobster...", updatedAt: "1 week ago" },
  { id: "bn4", title: "Standing desk settings", excerpt: "Sit 104cm, stand 118cm...", updatedAt: "2 weeks ago" },
];

export const browseProjects: ProjectItem[] = [
  { id: "bp1", name: "Alfred", status: "active", taskCount: 4 },
  { id: "bp2", name: "Freelance — Dan's site", status: "active", taskCount: 2 },
  { id: "bp3", name: "House move", status: "paused", taskCount: 7 },
  { id: "bp4", name: "2025 tax return", status: "done", taskCount: 0 },
];
