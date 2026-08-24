import type {
  CardAction,
  CardKind,
  CardTone,
  PresentationCard
} from "../../contracts/presentation.js";
import { splitMarkdown } from "../../domain/markdown-chunks.js";

export interface RenderedCardPart {
  card: object;
  fallbackText: string;
}

const toneStyle: Record<
  CardTone,
  { template: string; color: string; background: string; tagColor: string }
> = {
  info: { template: "blue", color: "blue", background: "blue-50", tagColor: "blue" },
  success: {
    template: "green",
    color: "green",
    background: "green-50",
    tagColor: "green"
  },
  warning: {
    template: "orange",
    color: "orange",
    background: "orange-50",
    tagColor: "orange"
  },
  error: { template: "red", color: "red", background: "red-50", tagColor: "red" },
  neutral: {
    template: "grey",
    color: "grey-600",
    background: "grey-50",
    tagColor: "neutral"
  }
};

const iconForKind: Record<CardKind, string> = {
  answer: "chat_outlined",
  help: "info_outlined",
  status: "time_outlined",
  notification: "bell_outlined",
  action: "done_outlined",
  confirmation: "approval_outlined"
};

function escapeInline(value: string): string {
  return value
    .replaceAll("&", "&#38;")
    .replaceAll("<", "&#60;")
    .replaceAll(">", "&#62;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("`", "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;");
}

function actionButton(action: CardAction): object {
  const type =
    action.style === "primary"
      ? "primary_filled"
      : action.style === "danger"
        ? "danger"
        : "default";
  return {
    tag: "button",
    text: { tag: "plain_text", content: action.label },
    type,
    size: "medium",
    behaviors: [{ type: "callback", value: action.value }]
  };
}

function statusBlock(input: PresentationCard, index: number, total: number): object {
  const style = toneStyle[input.tone];
  const status = total > 1 ? `${input.status ?? "内容"} · 第 ${index + 1}/${total} 段` : input.status;
  const lines = [
    status ? `**<font color='${style.color}'>${escapeInline(status)}</font>**` : undefined,
    ...(index === 0
      ? (input.fields ?? []).map(
          (field) => `**${escapeInline(field.label)}**：${escapeInline(field.value)}`
        )
      : [])
  ].filter((line): line is string => Boolean(line));

  return {
    tag: "column_set",
    flex_mode: "none",
    margin: "0px 0px 12px 0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        background_style: style.background,
        padding: "12px",
        vertical_spacing: "4px",
        elements: [
          {
            tag: "markdown",
            content: lines.join("\n"),
            text_size: "caption"
          }
        ]
      }
    ]
  };
}

function fallbackText(
  input: PresentationCard,
  content: string,
  index: number,
  total: number
): string {
  const title = total > 1 ? `${input.title}（${index + 1}/${total}）` : input.title;
  const fields =
    index === 0
      ? (input.fields ?? []).map((field) => `${field.label}：${field.value}`).join("\n")
      : "";
  const actions =
    index === total - 1 && input.actions?.length
      ? `\n\n可用操作：${input.actions.map((action) => action.label).join(" / ")}`
      : "";
  return [title, input.subtitle, fields, content]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .concat(actions);
}

export function renderCardParts(input: PresentationCard): RenderedCardPart[] {
  const chunks = splitMarkdown(input.content);
  const style = toneStyle[input.tone];
  return chunks.map((content, index) => {
    const total = chunks.length;
    const title = total > 1 ? `${input.title}（${index + 1}/${total}）` : input.title;
    const elements: object[] = [
      statusBlock(input, index, total),
      { tag: "markdown", content, text_size: "body" }
    ];
    if (index === total - 1) {
      elements.push(...(input.actions ?? []).map(actionButton));
    }
    return {
      card: {
        schema: "2.0",
        config: {
          update_multi: true,
          width_mode: "default",
          summary: { content: input.summary ?? title },
          style: {
            text_size: {
              body: { default: "normal", pc: "normal", mobile: "normal" },
              caption: { default: "notation", pc: "notation", mobile: "notation" }
            }
          }
        },
        header: {
          title: { tag: "plain_text", content: title },
          ...(input.subtitle && index === 0
            ? { subtitle: { tag: "plain_text", content: input.subtitle } }
            : {}),
          template: style.template,
          icon: {
            tag: "standard_icon",
            token: iconForKind[input.kind],
            color: style.color
          },
          ...(input.status
            ? {
                text_tag_list: [
                  {
                    tag: "text_tag",
                    text: { tag: "plain_text", content: input.status },
                    color: style.tagColor
                  }
                ]
              }
            : {})
        },
        body: {
          direction: "vertical",
          padding: "12px 12px 20px 12px",
          vertical_spacing: "8px",
          elements
        }
      },
      fallbackText: fallbackText(input, content, index, total)
    };
  });
}
