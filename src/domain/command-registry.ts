import type { CardAction } from "../contracts/presentation.js";

export type CommandId =
  | "help"
  | "status"
  | "sessions"
  | "history"
  | "queue"
  | "cancel"
  | "new"
  | "workspace"
  | "resume"
  | "steer"
  | "tools"
  | "send"
  | "task"
  | "doc"
  | "action"
  | "confirm"
  | "reject";

export type CommandCategory = "会话与任务" | "工作目录" | "飞书扩展";

export interface CommandDefinition {
  id: CommandId;
  aliases: readonly string[];
  usage: string;
  description: string;
  category: CommandCategory;
  menuEventKey?: string;
  delegated?: boolean;
}

export interface ParsedCommand {
  definition: CommandDefinition;
  args: string;
}

export const commandDefinitions: readonly CommandDefinition[] = [
  { id: "help", aliases: ["/help", "/hub", "帮助"], usage: "/hub", description: "打开动态 Codex 控制中心", category: "会话与任务", menuEventKey: "hub_help" },
  { id: "status", aliases: ["/status"], usage: "/status", description: "查看会话、后端和运行状态", category: "会话与任务", menuEventKey: "hub_status" },
  { id: "sessions", aliases: ["/sessions"], usage: "/sessions [页码]", description: "浏览白名单目录内的全局会话", category: "会话与任务", menuEventKey: "hub_sessions" },
  { id: "history", aliases: ["/history"], usage: "/history [页码]", description: "分页查看当前会话对话", category: "会话与任务", menuEventKey: "hub_history" },
  { id: "queue", aliases: ["/queue"], usage: "/queue", description: "查看等待执行的消息", category: "会话与任务", menuEventKey: "hub_queue" },
  { id: "cancel", aliases: ["/cancel"], usage: "/cancel", description: "取消当前任务并清空排队消息", category: "会话与任务", menuEventKey: "hub_cancel" },
  { id: "new", aliases: ["/new"], usage: "/new", description: "解除当前绑定，下条消息创建新会话", category: "会话与任务", menuEventKey: "hub_new" },
  { id: "resume", aliases: ["/resume"], usage: "/resume <会话 ID 或序号>", description: "绑定 Desktop、VS Code、CLI 或 Hub 会话", category: "会话与任务" },
  { id: "steer", aliases: ["/steer"], usage: "/steer <补充指令>", description: "向正在执行的任务追加指令", category: "会话与任务" },
  { id: "workspace", aliases: ["/workspace"], usage: "/workspace [目录]", description: "查看或切换允许的工作目录", category: "工作目录", menuEventKey: "hub_workspace" },
  { id: "tools", aliases: ["/tools"], usage: "/tools", description: "查看飞书扩展工具", category: "飞书扩展" },
  { id: "send", aliases: ["/send"], usage: "/send <身份> <类型> <ID> <内容>", description: "以 bot 或 user 身份发送消息", category: "飞书扩展", delegated: true },
  { id: "task", aliases: ["/task"], usage: "/task <标题>", description: "以当前飞书用户身份创建任务", category: "飞书扩展", delegated: true },
  { id: "doc", aliases: ["/doc"], usage: "/doc <标题>\n<Markdown 正文>", description: "创建飞书文档", category: "飞书扩展", delegated: true },
  { id: "action", aliases: ["/action"], usage: "/action <JSON>", description: "执行白名单内的结构化飞书动作", category: "飞书扩展", delegated: true },
  { id: "confirm", aliases: ["/confirm"], usage: "/confirm <编号>", description: "确认待执行的高风险操作", category: "飞书扩展" },
  { id: "reject", aliases: ["/reject"], usage: "/reject <编号>", description: "拒绝待执行的高风险操作", category: "飞书扩展" }
];

const byId = new Map(commandDefinitions.map((definition) => [definition.id, definition]));
const byMenuEvent = new Map(
  commandDefinitions
    .filter((definition) => definition.menuEventKey)
    .map((definition) => [definition.menuEventKey!, definition])
);

export function commandDefinition(id: CommandId): CommandDefinition {
  return byId.get(id)!;
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && byId.has(value as CommandId);
}

export function parseRegisteredCommand(text: string): ParsedCommand | undefined {
  const normalized = text.trim();
  for (const definition of commandDefinitions) {
    for (const alias of definition.aliases) {
      if (normalized === alias) {
        return { definition, args: "" };
      }
      if (normalized.startsWith(`${alias} `) || normalized.startsWith(`${alias}\n`)) {
        return { definition, args: normalized.slice(alias.length).trim() };
      }
    }
  }
  return undefined;
}

export function looksLikeCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export function commandText(id: CommandId, args = ""): string {
  const command = commandDefinition(id).aliases[0]!;
  return args ? `${command} ${args}` : command;
}

export function commandForMenuEvent(eventKey: string): string | undefined {
  const definition = byMenuEvent.get(eventKey);
  return definition ? commandText(definition.id) : undefined;
}

export function registeredCommandAction(
  label: string,
  id: CommandId,
  args = "",
  style: CardAction["style"] = "default"
): CardAction {
  return {
    label,
    style,
    value: { command: "registered_command", id, ...(args ? { args } : {}) }
  };
}

export function commandHelp(category?: CommandCategory): string {
  const definitions = category
    ? commandDefinitions.filter((definition) => definition.category === category)
    : commandDefinitions;
  const categories: readonly CommandCategory[] = category
    ? [category]
    : ["会话与任务", "工作目录", "飞书扩展"];
  return categories
    .map((current) => {
      const lines = definitions
        .filter((definition) => definition.category === current)
        .map((definition) => `- \`${definition.usage}\`：${definition.description}`);
      return lines.length ? `**${current}**\n${lines.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
