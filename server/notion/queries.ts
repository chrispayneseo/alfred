import type { Client } from "@notionhq/client";
import type { Classification } from "./classify.js";
import type { NotionEnv } from "./env.js";
import { INBOX_PROPS, INBOX_STATUS, NOTES_PROPS, PROJECTS_PROPS, TASKS_PROPS, TASK_STATUS, TITLE_PROP, UNSORTED_PROJECT } from "./schema.js";

// The API returns a deep discriminated-union PageObjectResponse per property
// type; these helpers pull out plain values without fighting that union for
// server-only code that isn't on the app's type-checked critical path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

function getTitle(page: AnyPage): string {
  return (page.properties?.[TITLE_PROP]?.title ?? []).map((t: AnyPage) => t.plain_text).join("");
}
function getSelect(page: AnyPage, prop: string): string | undefined {
  return page.properties?.[prop]?.select?.name;
}
function getDate(page: AnyPage, prop: string): string | undefined {
  return page.properties?.[prop]?.date?.start;
}
function getRelationIds(page: AnyPage, prop: string): string[] {
  return (page.properties?.[prop]?.relation ?? []).map((r: AnyPage) => r.id);
}
function getRichText(page: AnyPage, prop: string): string {
  return (page.properties?.[prop]?.rich_text ?? []).map((t: AnyPage) => t.plain_text).join("");
}

const richText = (content: string) => [{ type: "text" as const, text: { content } }];

export interface InboxRecord {
  id: string;
  text: string;
  status: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  projectId?: string;
  projectName?: string;
  client?: string;
  locationTrigger?: string;
}

export interface NoteRecord {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  updatedAt: string;
  client?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  status: string;
}

export class NotionRepo {
  constructor(
    private notion: Client,
    private env: NotionEnv
  ) {}

  async listProjects(): Promise<ProjectRecord[]> {
    const res = await this.notion.dataSources.query({ data_source_id: this.env.projectsDbId } as never);
    return (res.results as AnyPage[]).map((page) => ({
      id: page.id,
      name: getTitle(page),
      status: getSelect(page, PROJECTS_PROPS.status) ?? "Active",
    }));
  }

  private async findProjectIdByName(name: string): Promise<string | undefined> {
    const projects = await this.listProjects();
    return projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id;
  }

  /** Creates a new Project — used when the user accepts an auto-suggested
   * project grouping. Never called without that explicit confirmation. */
  async createProject(name: string): Promise<{ id: string }> {
    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.projectsDbId },
      properties: {
        [TITLE_PROP]: { title: richText(name) },
        [PROJECTS_PROPS.status]: { select: { name: "Active" } },
      },
    } as never);
    return { id: page.id };
  }

  /** Creates a Task directly, bypassing the Inbox/classification pipeline —
   * used by recurring-task detection, where the "task" being created is a
   * generated next-instance rather than something the user just typed. */
  async createTask(title: string, opts: { due?: string; projectId?: string } = {}): Promise<{ id: string }> {
    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.tasksDbId },
      properties: {
        [TITLE_PROP]: { title: richText(title) },
        [TASKS_PROPS.status]: { select: { name: TASK_STATUS.OPEN } },
        ...(opts.due ? { [TASKS_PROPS.dueDate]: { date: { start: opts.due } } } : {}),
        ...(opts.projectId ? { [TASKS_PROPS.project]: { relation: [{ id: opts.projectId }] } } : {}),
      },
    } as never);
    return { id: page.id };
  }

  async createInboxPage(
    text: string,
    capturedVia: "manual" | "share-target" | "email",
    sourceUrl?: string
  ): Promise<InboxRecord> {
    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.inboxDbId },
      properties: {
        [TITLE_PROP]: { title: richText(text) },
        [INBOX_PROPS.status]: { select: { name: INBOX_STATUS.UNTRIAGED } },
        [INBOX_PROPS.capturedVia]: { select: { name: capturedVia } },
        ...(sourceUrl ? { [INBOX_PROPS.emailLink]: { url: sourceUrl } } : {}),
      },
    } as never);
    return { id: page.id, text, status: INBOX_STATUS.UNTRIAGED };
  }

  /** Files an already-classified Inbox item into Tasks or Notes with a Project relation,
   * marks Inbox as triaged, and — for email-derived captures — links back to the thread. */
  async fileClassifiedItem(
    inboxId: string,
    text: string,
    classification: Classification,
    sourceUrl?: string,
    locationTrigger?: string
  ): Promise<{ kind: "task" | "note"; id: string; project: string }> {
    const { type, project } = classification;
    const projectId = await this.findProjectIdByName(project);
    const projectRelation = projectId ? [{ id: projectId }] : [];
    const emailLinkProp = sourceUrl ? { url: sourceUrl } : undefined;

    if (type === "task") {
      const page = await this.notion.pages.create({
        parent: { type: "data_source_id", data_source_id: this.env.tasksDbId },
        properties: {
          [TITLE_PROP]: { title: richText(text) },
          [TASKS_PROPS.status]: { select: { name: TASK_STATUS.OPEN } },
          [TASKS_PROPS.project]: { relation: projectRelation },
          [TASKS_PROPS.fromInbox]: { relation: [{ id: inboxId }] },
          ...(emailLinkProp ? { [TASKS_PROPS.emailLink]: emailLinkProp } : {}),
          ...(locationTrigger
            ? { [TASKS_PROPS.locationTrigger]: { rich_text: richText(locationTrigger) }, [TASKS_PROPS.locationTriggered]: { checkbox: false } }
            : {}),
        },
      } as never);
      await this.markInboxTriaged(inboxId);
      return { kind: "task", id: page.id, project };
    }

    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.notesDbId },
      properties: {
        [TITLE_PROP]: { title: richText(text) },
        [NOTES_PROPS.project]: { relation: projectRelation },
        [NOTES_PROPS.fromInbox]: { relation: [{ id: inboxId }] },
        ...(emailLinkProp ? { [NOTES_PROPS.emailLink]: emailLinkProp } : {}),
      },
    } as never);
    await this.markInboxTriaged(inboxId);
    return { kind: "note", id: page.id, project };
  }

  /** Creates a location-triggered reminder Task directly (no Inbox page) —
   * used by Chat's propose-then-confirm flow, which never went through
   * Capture's Inbox pipeline in the first place. */
  async createLocationReminderTask(text: string, project: string, locationTrigger: string): Promise<{ id: string }> {
    const projectId = await this.findProjectIdByName(project);
    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.tasksDbId },
      properties: {
        [TITLE_PROP]: { title: richText(text) },
        [TASKS_PROPS.status]: { select: { name: TASK_STATUS.OPEN } },
        [TASKS_PROPS.project]: { relation: projectId ? [{ id: projectId }] : [] },
        [TASKS_PROPS.locationTrigger]: { rich_text: richText(locationTrigger) },
        [TASKS_PROPS.locationTriggered]: { checkbox: false },
      },
    } as never);
    return { id: page.id };
  }

  /** Every open, not-yet-fired location reminder — the webhook route
   * matches these against the location name Tasker sends, case-insensitively,
   * itself (rather than relying on Notion's rich_text filter, which is an
   * exact/contains match, not case-insensitive). */
  async listOpenLocationReminders(): Promise<{ id: string; title: string; locationTrigger: string }[]> {
    const res = await this.notion.dataSources.query({
      data_source_id: this.env.tasksDbId,
      filter: {
        and: [
          { property: TASKS_PROPS.status, select: { equals: TASK_STATUS.OPEN } },
          { property: TASKS_PROPS.locationTriggered, checkbox: { equals: false } },
          { property: TASKS_PROPS.locationTrigger, rich_text: { is_not_empty: true } },
        ],
      },
    } as never);
    return (res.results as AnyPage[]).map((page) => ({
      id: page.id,
      title: getTitle(page),
      locationTrigger: getRichText(page, TASKS_PROPS.locationTrigger),
    }));
  }

  /** One-shot: flips "Location Triggered" so this reminder won't fire again
   * on the next geofence event for the same place. Never a hard delete —
   * the Task itself stays, same archive-not-delete philosophy as
   * everywhere else in this app. */
  async markLocationReminderTriggered(taskId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: taskId,
      properties: { [TASKS_PROPS.locationTriggered]: { checkbox: true } },
    } as never);
  }

  private async markInboxTriaged(inboxId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: inboxId,
      properties: {
        [INBOX_PROPS.status]: { select: { name: INBOX_STATUS.TRIAGED } },
      },
    } as never);
  }

  async listTasks(projectId?: string, client?: string): Promise<TaskRecord[]> {
    const filters = [
      projectId ? { property: TASKS_PROPS.project, relation: { contains: projectId } } : undefined,
      client ? { property: TASKS_PROPS.client, select: { equals: client } } : undefined,
    ].filter((f): f is NonNullable<typeof f> => Boolean(f));
    const filter = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { and: filters };

    const res = await this.notion.dataSources.query({
      data_source_id: this.env.tasksDbId,
      filter,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    } as never);

    const projects = await this.listProjects();
    const projectById = new Map(projects.map((p) => [p.id, p.name]));

    return (res.results as AnyPage[]).map((page) => {
      const [projId] = getRelationIds(page, TASKS_PROPS.project);
      return {
        id: page.id,
        title: getTitle(page),
        done: getSelect(page, TASKS_PROPS.status) === TASK_STATUS.DONE,
        due: getDate(page, TASKS_PROPS.dueDate),
        projectId: projId,
        projectName: projId ? projectById.get(projId) : undefined,
        client: getSelect(page, TASKS_PROPS.client),
        locationTrigger: getRichText(page, TASKS_PROPS.locationTrigger) || undefined,
      };
    });
  }

  async listNotes(projectId?: string, client?: string): Promise<NoteRecord[]> {
    const filters = [
      projectId ? { property: NOTES_PROPS.project, relation: { contains: projectId } } : undefined,
      client ? { property: NOTES_PROPS.client, select: { equals: client } } : undefined,
    ].filter((f): f is NonNullable<typeof f> => Boolean(f));
    const filter = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { and: filters };

    const res = await this.notion.dataSources.query({
      data_source_id: this.env.notesDbId,
      filter,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    } as never);

    const projects = await this.listProjects();
    const projectById = new Map(projects.map((p) => [p.id, p.name]));

    return (res.results as AnyPage[]).map((page) => {
      const [projId] = getRelationIds(page, NOTES_PROPS.project);
      return {
        id: page.id,
        title: getTitle(page),
        projectId: projId,
        projectName: projId ? projectById.get(projId) : undefined,
        updatedAt: page.last_edited_time,
        client: getSelect(page, NOTES_PROPS.client),
      };
    });
  }

  /** Title search across Tasks and Notes, for Q&A retrieval (Step 5). ANDs a
   * `contains` condition per word rather than matching the whole derived
   * phrase as one literal substring — a single-string match breaks the
   * moment word order differs from the title ("guide for Steadfast
   * Collective" vs. title "Steadfast Collective ... Guide") or a leftover
   * non-stopword sneaks into the derived query, even though every
   * significant term is genuinely present in the title. */
  async searchTasksAndNotes(query: string, limit = 5): Promise<{ tasks: TaskRecord[]; notes: NoteRecord[] }> {
    const words = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length === 0) return { tasks: [], notes: [] };

    const filter =
      words.length === 1
        ? { property: TITLE_PROP, title: { contains: words[0] } }
        : { and: words.map((w) => ({ property: TITLE_PROP, title: { contains: w } })) };
    const [taskRes, noteRes, projects] = await Promise.all([
      this.notion.dataSources.query({ data_source_id: this.env.tasksDbId, filter, page_size: limit } as never),
      this.notion.dataSources.query({ data_source_id: this.env.notesDbId, filter, page_size: limit } as never),
      this.listProjects(),
    ]);
    const projectById = new Map(projects.map((p) => [p.id, p.name]));

    const tasks = (taskRes.results as AnyPage[]).map((page) => {
      const [projId] = getRelationIds(page, TASKS_PROPS.project);
      return {
        id: page.id,
        title: getTitle(page),
        done: getSelect(page, TASKS_PROPS.status) === TASK_STATUS.DONE,
        due: getDate(page, TASKS_PROPS.dueDate),
        projectId: projId,
        projectName: projId ? projectById.get(projId) : undefined,
      };
    });

    const notes = (noteRes.results as AnyPage[]).map((page) => {
      const [projId] = getRelationIds(page, NOTES_PROPS.project);
      return {
        id: page.id,
        title: getTitle(page),
        projectId: projId,
        projectName: projId ? projectById.get(projId) : undefined,
        updatedAt: page.last_edited_time,
      };
    });

    return { tasks, notes };
  }

  /** Plain text of a Note's page body (paragraph blocks only — the shape
   * every Note in this app is written with, whether via Capture's inbox
   * pipeline or the folder-scan script). Paginates since Notion caps each
   * list call at 100 blocks; a long scanned document can span several
   * pages' worth. Returns everything — the caller decides how much of it
   * is worth including in a given context window. */
  async getNoteBody(noteId: string): Promise<string> {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.notion.blocks.children.list({ block_id: noteId, start_cursor: cursor, page_size: 100 } as never);
      for (const block of res.results as AnyPage[]) {
        if (block.type === "paragraph") {
          const text = (block.paragraph?.rich_text ?? []).map((t: AnyPage) => t.plain_text).join("");
          if (text) lines.push(text);
        }
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return lines.join("\n");
  }

  /** Open Tasks with a due date before today — always re-derived live from
   * Notion's current status, nothing about "already nudged" is stored here
   * (see server/nudges/nudgeStore.ts for the separate push-throttle state). */
  async listOverdueTasks(): Promise<TaskRecord[]> {
    const todayIso = new Date().toISOString().slice(0, 10);
    const filter = {
      and: [
        { property: TASKS_PROPS.status, select: { equals: TASK_STATUS.OPEN } },
        { property: TASKS_PROPS.dueDate, date: { before: todayIso } },
      ],
    };
    const res = await this.notion.dataSources.query({
      data_source_id: this.env.tasksDbId,
      filter,
      sorts: [{ property: TASKS_PROPS.dueDate, direction: "ascending" }],
    } as never);

    const projects = await this.listProjects();
    const projectById = new Map(projects.map((p) => [p.id, p.name]));

    return (res.results as AnyPage[]).map((page) => {
      const [projId] = getRelationIds(page, TASKS_PROPS.project);
      return {
        id: page.id,
        title: getTitle(page),
        done: false,
        due: getDate(page, TASKS_PROPS.dueDate),
        projectId: projId,
        projectName: projId ? projectById.get(projId) : undefined,
      };
    });
  }

  async updateTaskStatus(taskId: string, done: boolean): Promise<void> {
    await this.notion.pages.update({
      page_id: taskId,
      properties: {
        [TASKS_PROPS.status]: { select: { name: done ? TASK_STATUS.DONE : TASK_STATUS.OPEN } },
      },
    } as never);
  }

  async setTaskProject(taskId: string, projectId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: taskId,
      properties: { [TASKS_PROPS.project]: { relation: [{ id: projectId }] } },
    } as never);
  }

  /** Archives the Notion page — Notion's own trash, recoverable there for 30
   * days, not a permanent delete. */
  async archiveTask(taskId: string): Promise<void> {
    await this.notion.pages.update({ page_id: taskId, archived: true } as never);
  }

  /** Counts Tasks/Notes created in the last 7 days — feeds the weekly
   * digest's "what got captured/filed" line. Uses Notion's own created_time
   * filter rather than fetching everything and filtering locally. */
  async countRecentlyCaptured(): Promise<{ tasks: number; notes: number }> {
    const filter = { timestamp: "created_time" as const, created_time: { past_week: {} } };
    const [taskRes, noteRes] = await Promise.all([
      this.notion.dataSources.query({ data_source_id: this.env.tasksDbId, filter } as never),
      this.notion.dataSources.query({ data_source_id: this.env.notesDbId, filter } as never),
    ]);
    return { tasks: taskRes.results.length, notes: noteRes.results.length };
  }

  async setNoteProject(noteId: string, projectId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: noteId,
      properties: { [NOTES_PROPS.project]: { relation: [{ id: projectId }] } },
    } as never);
  }

  /** Archives the Notion page — Notion's own trash, recoverable there for 30
   * days, not a permanent delete. Same mechanism as archiveTask. */
  async archiveNote(noteId: string): Promise<void> {
    await this.notion.pages.update({ page_id: noteId, archived: true } as never);
  }

  /** Deletes a Project: re-tags every Task/Note currently under it to
   * Unsorted (so nothing is left pointing at an archived page), then
   * archives the Project itself. Never called without the user's explicit
   * confirmation in the UI — this is a structural change, not a single-item
   * removal. Refuses to delete Unsorted itself, since it's the fallback
   * every other project (including this one) reassigns into. */
  async deleteProject(projectId: string): Promise<{ reassigned: number }> {
    const unsortedId = await this.findProjectIdByName(UNSORTED_PROJECT);
    if (!unsortedId) throw new Error("Unsorted project not found");
    if (projectId === unsortedId) throw new Error("Can't delete the Unsorted project");

    const [tasks, notes] = await Promise.all([this.listTasks(projectId), this.listNotes(projectId)]);
    await Promise.all([
      ...tasks.map((t) => this.setTaskProject(t.id, unsortedId)),
      ...notes.map((n) => this.setNoteProject(n.id, unsortedId)),
    ]);
    await this.notion.pages.update({ page_id: projectId, archived: true } as never);
    return { reassigned: tasks.length + notes.length };
  }
}
