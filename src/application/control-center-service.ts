import { basename } from "node:path";
import {
  commandHelp,
  registeredCommandAction,
  sessionConflictActions
} from "../domain/command-registry.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { RunRecord, StateRepository } from "../ports/state-repository.js";
import type { PresentationOptions } from "./presentation-factory.js";
import type { CodexProject } from "./project-catalog-service.js";
import type { SessionCatalogService } from "./session-catalog-service.js";

export interface ControlCenterView {
  content: string;
  options: PresentationOptions;
}

function runLabel(run: RunRecord | undefined): string {
  if (!run) {
    return "暂无记录";
  }
  const labels: Record<RunRecord["state"], string> = {
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断"
  };
  return `${labels[run.state]} · ${new Date(run.startedAt).toLocaleString("zh-CN")}`;
}

export class ControlCenterService {
  public constructor(
    private readonly store: StateRepository,
    private readonly turns: TurnControl,
    private readonly sessions: SessionCatalogService,
    private readonly codexEntryStatus: () => string = () => "Codex CLI / App Server"
  ) {}

  public async home(scopeKey: string): Promise<ControlCenterView> {
    const conflict = this.store.getOpenSessionConflict(scopeKey);
    const link = this.store.getConversation(scopeKey);
    const persistedCwd = this.store.getProject(scopeKey) ?? link?.cwd;
    let project: CodexProject | undefined;
    let projectLookupFailed = false;
    if (!conflict) {
      try {
        project = await this.sessions.selectedProject(scopeKey);
      } catch {
        projectLookupFailed = true;
      }
    }
    const newSessionIntent = this.store.getNewSessionIntent(scopeKey);
    const queue = this.turns.snapshot(scopeKey);
    const latestRun = this.store.getLatestRun(scopeKey);
    const pending = this.store.getPendingPrompt(scopeKey, Date.now());
    const running = queue.active;
    // A conflict card is backed entirely by durable state. Do not make its
    // refresh depend on an App Server/catalog call that may be unavailable
    // precisely while another Codex entry owns the session.
    let unclassifiedCount = 0;
    if (!conflict && !projectLookupFailed) {
      try {
        unclassifiedCount = (await this.sessions.snapshot()).unclassified.length;
      } catch {
        // The project/session controls remain usable even when catalog
        // discovery is temporarily unavailable.
        unclassifiedCount = 0;
      }
    }
    const actions = conflict
      ? sessionConflictActions(conflict)
      : running || queue.pending > 0
      ? [
          registeredCommandAction("运行状态", "status", "", "primary"),
          registeredCommandAction("查看队列", "queue"),
          registeredCommandAction("停止任务", "cancel", "", "danger"),
          registeredCommandAction("当前会话", "history")
        ]
      : [
          project
            ? registeredCommandAction("项目会话", "sessions", "", "primary")
            : registeredCommandAction(
                persistedCwd ? "刷新项目" : "选择项目",
                "projects",
                "",
                "primary"
              ),
          registeredCommandAction("项目中心", "projects"),
          ...(unclassifiedCount
            ? [registeredCommandAction(`未归类 ${unclassifiedCount}`, "unclassified")]
            : []),
          registeredCommandAction("最近对话", "history"),
          registeredCommandAction("新建会话", "new"),
          registeredCommandAction("运行状态", "status"),
          registeredCommandAction("飞书工具", "tools")
        ];
    return {
      content: conflict
        ? "上一条消息遇到外部 Codex 会话占用。请选择 A 等待原会话释放，或选择 B 在同一项目创建空白独立会话。"
        : running
        ? "Codex 正在处理任务。你可以查看进度、追加指令或停止任务。"
        : queue.pending > 0
          ? "Codex 当前有排队任务，新的普通消息会继续进入持久化队列。"
          : !project
            ? pending
              ? "有一条消息正在等待选择项目和会话，普通消息暂时不会执行。"
              : projectLookupFailed && persistedCwd
                ? "项目目录已记录，但暂时无法读取 Codex 项目索引，请刷新项目列表后重试。"
                : "请先选择项目，然后选择已有会话或在项目中创建新会话。"
            : link
              ? "直接发送需求即可继续当前会话，也可以切换项目或会话。"
              : newSessionIntent
                ? "已经明确选择新建会话，下一条消息会创建新的 Codex 会话。"
                : "项目已选择，请继续选择历史会话或明确新建会话。",
      options: {
        title: "Codex 控制中心",
        kind: "help",
        tone: conflict || running || queue.pending > 0 || !project ? "warning" : "info",
        status: conflict
          ? "等待占用选择"
          : running
          ? "执行中"
          : queue.pending > 0
            ? `排队 ${queue.pending}`
            : project
              ? "空闲"
              : projectLookupFailed && persistedCwd
                ? "目录索引不可用"
                : "未选择项目",
        subtitle: project?.name ??
          (persistedCwd ? basename(persistedCwd) || persistedCwd : "等待选择项目"),
        fields: [
          {
            label: "当前项目",
            value: project?.name ?? (persistedCwd ? "已记录（目录索引未加载）" : "未选择")
          },
          { label: "项目目录", value: project?.cwd ?? persistedCwd ?? "—" },
          {
            label: "当前会话",
            value: link?.sessionId
              ? `${link.sessionId.slice(0, 8)}…`
              : newSessionIntent
                ? "等待新建"
                : project
                  ? "尚未选择"
                  : "—"
          },
          { label: "暂存消息", value: pending ? "等待确认" : "无" },
          { label: "最近运行", value: runLabel(latestRun) },
          { label: "排队消息", value: String(queue.pending) },
          ...(conflict
            ? [
                {
                  label: "占用目标",
                  value: `${conflict.target.sessionId.slice(0, 12)}… · ${Math.max(1, Math.ceil((conflict.expiresAt - Date.now()) / 60_000))} 分钟内有效`
                }
              ]
            : []),
          { label: "执行入口", value: this.codexEntryStatus() }
        ],
        actions
      }
    };
  }

  public tools(): ControlCenterView {
    return {
      content: `${commandHelp("飞书扩展")}\n\n高风险动作仍需要当前操作者在原卡片中确认。`,
      options: {
        title: "飞书工具",
        kind: "help",
        tone: "info",
        status: "扩展能力",
        actions: [registeredCommandAction("返回控制中心", "help", "", "primary")]
      }
    };
  }
}
