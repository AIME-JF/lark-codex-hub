import type {
  CardKind,
  CardTone,
  PresentationCard
} from "../contracts/presentation.js";

export interface PresentationOptions {
  title?: string;
  kind?: CardKind;
  tone?: CardTone;
  status?: string;
  subtitle?: string;
  fields?: PresentationCard["fields"];
}

export function presentation(
  text: string,
  options: PresentationOptions = {}
): PresentationCard {
  return {
    kind: options.kind ?? "status",
    title: options.title ?? "Lark Codex Hub",
    content: text,
    tone: options.tone ?? "info",
    status: options.status ?? "信息",
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(options.fields ? { fields: options.fields } : {}),
    summary: text.replace(/\s+/g, " ").slice(0, 120)
  };
}

export function resultPresentation(
  title: string,
  content: string,
  success: boolean
): PresentationCard {
  return presentation(content, {
    title,
    kind: "action",
    tone: success ? "success" : "error",
    status: success ? "已完成" : "失败"
  });
}

export function durationText(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs} 毫秒`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
}
