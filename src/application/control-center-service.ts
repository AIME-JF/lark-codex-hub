import { commandHelp, registeredCommandAction } from "../domain/command-registry.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { RunRecord, StateRepository } from "../ports/state-repository.js";
import type { PresentationOptions } from "./presentation-factory.js";
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
    const project = await this.sessions.selectedProject(scopeKey);
    const link = this.store.getConversation(scopeKey);
    const newSessionIntent = this.store.getNewSessionIntent(scopeKey);
    const queue = this.turns.snapshot(scopeKey);
    const latestRun = this.store.getLatestRun(scopeKey);
    const pending = this.store.getPendingPrompt(scopeKey, Date.now());
    const running = queue.active;
    const unclassifiedCount = (await this.sessions.snapshot()).unclassified.length;
    const actions = running || queue.pending > 0
      ? [
          registeredCommandAction("运行状态", "status", "", "primary"),
          registeredCommandAction("查看队列", "queue"),
          registeredCommandAction("停止任务", "cancel", "", "danger"),
          registeredCommandAction("当前会话", "history")
        ]
      : [
          project
            ? registeredCommandAction("项目会话", "sessions", "", "primary")
            : registeredCommandAction("选择项目", "projects", "", "primary"),
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
      content: running
        ? "Codex 正在处理任务。你可以查看进度、追加指令或停止任务。"
        : queue.pending > 0
          ? "Codex 当前有排队任务，新的普通消息会继续进入持久化队列。"
          : !project
            ? pending
              ? "有一条消息正在等待选择项目和会话，普通消息暂时不会执行。"
              : "请先选择项目，然后选择已有会话或在项目中创建新会话。"
            : link
              ? "直接发送需求即可继续当前会话，也可以切换项目或会话。"
              : newSessionIntent
                ? "已经明确选择新建会话，下一条消息会创建新的 Codex 会话。"
                : "项目已选择，请继续选择历史会话或明确新建会话。",
      options: {
        title: "Codex 控制中心",
        kind: "help",
        tone: running || queue.pending > 0 || !project ? "warning" : "info",
        status: running
          ? "执行中"
          : queue.pending > 0
            ? `排队 ${queue.pending}`
            : project
              ? "空闲"
              : "未选择项目",
        subtitle: project?.name ?? "等待选择项目",
        fields: [
          { label: "当前项目", value: project?.name ?? "未选择" },
          { label: "项目目录", value: project?.cwd ?? "—" },
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
