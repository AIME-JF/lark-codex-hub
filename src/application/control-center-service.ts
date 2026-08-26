import { basename } from "node:path";
import type { HubConfig } from "../contracts/config.js";
import {
  commandHelp,
  registeredCommandAction
} from "../domain/command-registry.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { RunRecord, StateRepository } from "../ports/state-repository.js";
import type { PresentationOptions } from "./presentation-factory.js";

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
    private readonly config: HubConfig,
    private readonly store: StateRepository,
    private readonly turns: TurnControl
  ) {}

  public home(scopeKey: string): ControlCenterView {
    const link = this.store.getConversation(scopeKey);
    const cwd = this.store.getWorkspace(scopeKey) ?? link?.cwd ?? this.config.workspace.defaultRoot;
    const queue = this.turns.snapshot(scopeKey);
    const latestRun = this.store.getLatestRun(scopeKey);
    const running = queue.active;
    const actions = running || queue.pending > 0
      ? [
          registeredCommandAction("运行状态", "status", "", "primary"),
          registeredCommandAction("查看队列", "queue"),
          registeredCommandAction("停止任务", "cancel", "", "danger"),
          registeredCommandAction("历史会话", "sessions"),
          registeredCommandAction("最近对话", "history")
        ]
      : [
          registeredCommandAction("历史会话", "sessions", "", "primary"),
          registeredCommandAction("最近对话", "history"),
          registeredCommandAction("新建会话", "new"),
          registeredCommandAction("切换项目", "workspace"),
          registeredCommandAction("运行状态", "status"),
          registeredCommandAction("飞书工具", "tools")
        ];
    return {
      content: running
        ? "Codex 正在处理任务。你可以查看进度、追加指令或停止任务。"
        : queue.pending > 0
          ? "Codex 当前有排队任务，新的普通消息会继续进入持久化队列。"
          : "直接发送需求即可继续当前会话；也可以从下面选择会话、项目或工具。",
      options: {
        title: "Codex 控制中心",
        kind: "help",
        tone: running || queue.pending > 0 ? "warning" : "info",
        status: running ? "执行中" : queue.pending > 0 ? `排队 ${queue.pending}` : "空闲",
        subtitle: basename(cwd) || cwd,
        fields: [
          { label: "当前项目", value: basename(cwd) || cwd },
          { label: "工作目录", value: cwd },
          { label: "当前会话", value: link?.sessionId ? `${link.sessionId.slice(0, 8)}…` : "下条消息新建" },
          { label: "最近运行", value: runLabel(latestRun) },
          { label: "排队消息", value: String(queue.pending) }
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
