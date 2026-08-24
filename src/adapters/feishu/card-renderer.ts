function markdownEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

export function confirmationCard(input: {
  id: string;
  action: string;
  risk: string;
  params: unknown;
}): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: "需要确认飞书操作" },
      template: "orange"
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**动作**：${markdownEscape(input.action)}`,
            `**风险**：${markdownEscape(input.risk)}`,
            `**编号**：\`${input.id}\``,
            `**参数**：\`${markdownEscape(JSON.stringify(input.params))}\``
          ].join("\n")
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "确认执行" },
              type: "primary",
              value: { command: "confirm", id: input.id }
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "拒绝" },
              type: "default",
              value: { command: "reject", id: input.id }
            }
          ]
        }
      ]
    }
  };
}

export function resultCard(title: string, content: string, success: boolean): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: success ? "green" : "red"
    },
    body: {
      elements: [{ tag: "markdown", content: markdownEscape(content) }]
    }
  };
}
