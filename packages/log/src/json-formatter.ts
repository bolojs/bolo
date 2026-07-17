import type { LogRecord, TextFormatter } from "@logtape/logtape";

function renderMessage(message: readonly unknown[]): string {
  if (message.length === 1) return String(message[0]);
  let rendered = "";
  for (let i = 0; i < message.length; i++) {
    rendered += i % 2 === 0 ? String(message[i]) : JSON.stringify(message[i]);
  }
  return rendered;
}

/**
 * JSONL formatter with `category` kept as an array (not dot-joined), so the
 * documented agent workflow — `jq 'select(.category[1]=="sandbox")'` — works
 * against `.logs/latest.jsonl` without a string-splitting step.
 */
export const boloJsonFormatter: TextFormatter = (record: LogRecord): string => {
  return `${JSON.stringify({
    timestamp: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category,
    message: renderMessage(record.message),
    properties: record.properties,
  })}\n`;
};
