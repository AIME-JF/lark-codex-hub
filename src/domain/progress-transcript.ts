interface ProgressEntry {
  label: string;
  at: number;
}

const maxEntries = 20;
const previewLimit = 1_600;

function compactLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 180);
}

function elapsedText(startedAt: number, at: number): string {
  const seconds = Math.max(0, at - startedAt) / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}

function quoteMarkdown(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

export class ProgressTranscript {
  private readonly entries: ProgressEntry[] = [];
  private omittedEntries = 0;
  private preview = "";

  public constructor(public readonly startedAt: number) {
    this.record("开始处理", startedAt);
  }

  public record(label: string, at = Date.now()): void {
    const compact = compactLabel(label);
    if (!compact || this.entries.at(-1)?.label === compact) {
      return;
    }
    this.entries.push({ label: compact, at });
    if (this.entries.length > maxEntries) {
      this.entries.shift();
      this.omittedEntries += 1;
    }
  }

  public setPreview(text: string): void {
    const value = text.trim();
    this.preview = value.length <= previewLimit
      ? value
      : `……（仅保留末尾预览）\n\n${value.slice(-previewLimit)}`;
  }

  public markdown(): string {
    const timeline = this.entries.map(
      (entry) => `- \`+${elapsedText(this.startedAt, entry.at)}\` ${entry.label}`
    );
    if (this.omittedEntries > 0) {
      timeline.unshift(`- 已折叠 ${this.omittedEntries} 条较早记录`);
    }
    const parts = ["**执行时间线**", timeline.join("\n")];
    if (this.preview) {
      parts.push("**实时输出预览**", quoteMarkdown(this.preview));
    }
    return parts.join("\n\n");
  }
}
