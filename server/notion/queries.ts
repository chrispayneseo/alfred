import type { Client } from "@notionhq/client";
import type { Classification } from "./classify";
import type { NotionEnv } from "./env";
import { INBOX_PROPS, INBOX_STATUS, NOTES_PROPS, PROJECTS_PROPS, TASKS_PROPS, TASK_STATUS, TITLE_PROP } from "./schema";

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
}

export interface NoteRecord {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  updatedAt: string;
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

  async createInboxPage(text: string, capturedVia: "manual" | "share-target"): Promise<InboxRecord> {
    const page = await this.notion.pages.create({
      parent: { type: "data_source_id", data_source_id: this.env.inboxDbId },
      properties: {
        [TITLE_PROP]: { title: richText(text) },
        [INBOX_PROPS.status]: { select: { name: INBOX_STATUS.UNTRIAGED } },
        [INBOX_PROPS.capturedVia]: { select: { name: capturedVia } },
      },
    } as never);
    return { id: page.id, text, status: INBOX_STATUS.UNTRIAGED };
  }

  /** Files an already-classified Inbox item into Tasks or Notes with a Project relation, and marks Inbox as triaged. */
  async fileClassifiedItem(
    inboxId: string,
    text: string,
    classification: Classification
  ): Promise<{ kind: "task" | "note"; id: string; project: string }> {
    const { type, project } = classification;
    const projectId = await this.findProjectIdByName(project);
    const projectRelation = projectId ? [{ id: projectId }] : [];

    if (type === "task") {
      const page = await this.notion.pages.create({
        parent: { type: "data_source_id", data_source_id: this.env.tasksDbId },
        properties: {
          [TITLE_PROP]: { title: richText(text) },
          [TASKS_PROPS.status]: { select: { name: TASK_STATUS.OPEN } },
          [TASKS_PROPS.project]: { relation: projectRelation },
          [TASKS_PROPS.fromInbox]: { relation: [{ id: inboxId }] },
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

  async listTasks(projectId?: string): Promise<TaskRecord[]> {
    const filter = projectId
      ? { property: TASKS_PROPS.project, relation: { contains: projectId } }
      : undefined;
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
      };
    });
  }

  async listNotes(projectId?: string): Promise<NoteRecord[]> {
    const filter = projectId
      ? { property: NOTES_PROPS.project, relation: { contains: projectId } }
      : undefined;
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

  async setNoteProject(noteId: string, projectId: string): Promise<void> {
    await this.notion.pages.update({
      page_id: noteId,
      properties: { [NOTES_PROPS.project]: { relation: [{ id: projectId }] } },
    } as never);
  }
}
