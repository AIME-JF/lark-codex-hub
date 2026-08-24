const DEFAULT_LIMIT = 8_000;

interface FenceState {
  marker: string;
  openingLine: string;
}

function fenceAfter(line: string, state: FenceState | undefined): FenceState | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return state;
  }
  const marker = match[1]!;
  if (!state) {
    return { marker, openingLine: line };
  }
  return marker[0] === state.marker[0] && marker.length >= state.marker.length
    ? undefined
    : state;
}

function appendClosedFence(value: string, state: FenceState | undefined): string {
  return state ? `${value}\n${state.marker}` : value;
}

export function splitMarkdown(value: string, limit = DEFAULT_LIMIT): string[] {
  const text = value.trim() || "（无文本结果）";
  if (text.length <= limit) {
    return [text];
  }

  const safeLimit = Math.max(256, limit - 32);
  const chunks: string[] = [];
  let current = "";
  let fence: FenceState | undefined;

  for (const line of text.split("\n")) {
    const separator = current ? "\n" : "";
    if (current && current.length + separator.length + line.length > safeLimit) {
      chunks.push(appendClosedFence(current, fence));
      current = fence ? `${fence.openingLine}\n${line}` : line;
    } else {
      current = `${current}${separator}${line}`;
    }

    while (current.length > safeLimit) {
      const prefix = current.slice(0, safeLimit);
      chunks.push(appendClosedFence(prefix, fence));
      const remainder = current.slice(safeLimit);
      current = fence ? `${fence.openingLine}\n${remainder}` : remainder;
    }
    fence = fenceAfter(line, fence);
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}
