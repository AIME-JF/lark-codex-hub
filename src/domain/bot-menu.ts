import { commandDefinitions, commandForMenuEvent } from "./command-registry.js";

export const botMenuCommands = Object.fromEntries(
  commandDefinitions
    .filter((definition) => definition.menuEventKey)
    .map((definition) => [definition.menuEventKey!, definition.aliases[0]!])
) as Readonly<Record<string, string>>;

export function commandForBotMenu(eventKey: string): string | undefined {
  return commandForMenuEvent(eventKey);
}
