import { createMemo } from "solid-js";
import { marked } from "marked";

/**
 * Streaming markdown renderer (Solid). Replaces React's streamdown (no Solid
 * port). Uses marked for parsing + Solid's createMemo for reactive re-parse
 * on text change.
 *
 * ponytail: marked output is injected via innerHTML WITHOUT sanitization.
 * For a production deployment handling untrusted LLM output, add DOMPurify
 * to strip script tags / event handlers; for this demo (single-user, BYOK,
 * self-induced prompt injection) it's an acceptable risk. Upgrade path is a
 * one-line `DOMPurify.sanitize(...)` wrap before assigning innerHTML.
 */
export function StreamingMarkdown(props: { text: string }) {
  const html = createMemo(() => {
    if (!props.text) return "";
    // marked.parse returns string when async:false (sync mode)
    return marked.parse(props.text, { async: false }) as string;
  });
  return <div class="prose-chat" innerHTML={html()} />;
}
