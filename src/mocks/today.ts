import type { CalendarEvent, NoteItem, TaskItem } from "../types";

export const mockTasks: TaskItem[] = [
  { id: "t1", title: "Reply to Dan re: contract draft", done: false, due: "Today", project: "Freelance" },
  { id: "t2", title: "Book dentist appointment", done: false, due: "Today" },
  { id: "t3", title: "Review PR for Alfred scaffold", done: false, due: "Tomorrow", project: "Alfred" },
  { id: "t4", title: "Pay storage unit invoice", done: true, due: "Yesterday" },
];

export const mockEvents: CalendarEvent[] = [
  { id: "e1", title: "Standup", start: "09:00", end: "09:15", location: "Zoom" },
  { id: "e2", title: "1:1 with Sam", start: "11:30", end: "12:00" },
  { id: "e3", title: "Dentist", start: "16:00", end: "16:45", location: "High St Practice" },
];

export const mockNotes: NoteItem[] = [
  { id: "n1", title: "Alfred v2 ideas", excerpt: "Voice capture should transcribe locally before...", updatedAt: "Yesterday" },
  { id: "n2", title: "Holiday packing list", excerpt: "Passport, adapter, the good headphones...", updatedAt: "3 days ago" },
];
