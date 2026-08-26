import type { CardAction } from "../contracts/presentation.js";

export type CommandId =
  | "help"
  | "status"
  | "projects"
  | "project"
  | "sessions"
  | "inspect"
  | "unclassified"
  | "migrate"
  | "pending"
  | "history"
  | "queue"
  | "cancel"
  | "new"
  | "resume"
  | "steer"
  | "tools"
  | "send"
  | "task"
  | "doc"
  | "action"
  | "confirm"
  | "reject";

export type CommandCategory = "会话与任务" | "项目与会话" | "飞书扩展";

export interface CommandDefinition {
  id: CommandId;
  aliases: readonly string[];
  usage: string;
  description: string;
  category: CommandCategory;
  menuEventKey?: string;
  delegated?: boolean;
  hidden?: boolean;
}

export interface ParsedCommand {
  definition: CommandDefinition;
  args: string;
}

export const commandDefinitions: readonly CommandDefinition[] = [
  { id: "help", aliases: ["/help", "/hub", "帮助"], usage: "/hub", description: "打开动态 Codex 控制中心", category: "会话与任务", menuEventKey: "hub_help" },
  { id: "status", aliases: ["/status"], usage: "/status", description: "查看会话、后端和运行状态", category: "会话与任务", menuEventKey: "hub_status" },
  { id: "projects", aliases: ["/projects", "/workspace"], usage: "/projects [页码或关键词]", description: "浏览 Desktop 风格项目中心", category: "项目与会话", menuEventKey: "hub_workspace" },
  { id: "project", aliases: ["/project"], usage: "/project <项目编号>", description: "选择项目", category: "项目与会话", hidden: true },
  { id: "sessions", aliases: ["/sessions"], usage: "/sessions [页码]", description: "浏览当前项目内的会话", category: "项目与会话", menuEventKey: "hub_sessions" },
  { id: "inspect", aliases: ["/inspect"], usage: "/inspect <会话 ID> [页码]", description: "只读查看指定会话", category: "项目与会话", hidden: true },
  { id: "unclassified", aliases: ["/unclassified"], usage: "/unclassified [页码]", description: "查看未归类会话", category: "项目与会话" },
  { id: "migrate", aliases: ["/migrate"], usage: "/migrate <会话 ID> [项目编号]", description: "将未归类会话分叉到项目", category: "项目与会话", hidden: true },
  { id: "pending", aliases: ["/pending"], usage: "/pending <run|discard>", description: "处理暂存消息", category: "项目与会话", hidden: true },
  { id: "history", aliases: ["/history"], usage: "/history [页码]", description: "分页查看当前会话对话", category: "会话与任务", menuEventKey: "hub_history" },
  { id: "queue", aliases: ["/queue"], usage: "/queue", description: "查看等待执行的消息", category: "会话与任务", menuEventKey: "hub_queue" },
  { id: "cancel", aliases: ["/cancel"], usage: "/cancel", description: "取消当前任务并清空排队消息", category: "会话与任务", menuEventKey: "hub_cancel" },
  { id: "new", aliases: ["/new"], usage: "/new", description: "在当前项目创建新会话", category: "项目与会话", menuEventKey: "hub_new" },
  { id: "resume", aliases: ["/resume"], usage: "/resume <会话 ID 或序号>", description: "绑定当前项目内的 Codex 会话", category: "项目与会话" },
  { id: "steer", aliases: ["/steer"], usage: "/steer <补充指令>", description: "向正在执行的任务追加指令", category: "会话与任务" },
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
    : ["会话与任务", "项目与会话", "飞书扩展"];
  return categories
    .map((current) => {
      const lines = definitions
        .filter((definition) => definition.category === current && !definition.hidden)
        .map((definition) => `- \`${definition.usage}\`：${definition.description}`);
      return lines.length ? `**${current}**\n${lines.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
