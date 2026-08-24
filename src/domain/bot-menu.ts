export const botMenuCommands = {
  hub_help: "/help",
  hub_status: "/status",
  hub_sessions: "/sessions",
  hub_cancel: "/cancel",
  hub_new: "/new",
  hub_workspace: "/workspace"
} as const;

export function commandForBotMenu(eventKey: string): string | undefined {
  return botMenuCommands[eventKey as keyof typeof botMenuCommands];
}
