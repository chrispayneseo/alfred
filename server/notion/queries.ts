import type { Client } from "@notionhq/client";
import type { Classification } from "./classify.js";
import type { NotionEnv } from "./env.js";
import { INBOX_PROPS, INBOX_STATUS, NOTES_PROPS, PROJECTS_PROPS, TASKS_PROPS, TASK_STATUS, TITLE_PROP } from "./schema.js";

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
    sourceUrl?: string
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

  /** Title-contains search across Tasks and Notes, for Q&A retrieval (Step 5). */
  async searchTasksAndNotes(query: string, limit = 5): Promise<{ tasks: TaskRecord[]; notes: NoteRecord[] }> {
    const trimmed = query.trim();
    if (!trimmed) return { tasks: [], notes: [] };

    const filter = { property: TITLE_PROP, title: { contains: trimmed } };
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

  async setNoteProject(noteId: string, projectId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: noteId,
      properties: { [NOTES_PROPS.project]: { relation: [{ id: projectId }] } },
    } as never);
  }
}
