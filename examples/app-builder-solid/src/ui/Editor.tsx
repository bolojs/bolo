import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type Theme = "dark" | "light";

interface Props {
  path: string;
  value: string;
  theme: Theme;
  onChange(value: string): void;
}

const baseTheme = EditorView.theme({
  "&": { height: "100%", "font-size": "13px", "background-color": "var(--surface)", color: "var(--on-surface)" },
  ".cm-scroller": { overflow: "auto", "font-family": "var(--font-mono), ui-monospace, monospace" },
  ".cm-gutters": { "background-color": "var(--surface)", color: "var(--on-surface-variant)", border: "none" },
  ".cm-activeLine": { "background-color": "var(--surface-container-low)" },
  ".cm-activeLineGutter": { "background-color": "var(--surface-container-low)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    "background-color": "var(--surface-container-high) !important",
  },
  "&.cm-focused": { outline: "none" },
});

const HIGHLIGHT_COLORS: Record<Theme, { keyword: string; string: string; comment: string; function: string; number: string }> = {
  dark: { keyword: "#ff7b93", string: "#9ece6a", comment: "#6e7172", function: "#7dcfff", number: "#e0af68" },
  light: { keyword: "#c4256c", string: "#2f7a3e", comment: "#8a8f8f", function: "#0e6ba8", number: "#a15c00" },
};

function highlightStyleFor(theme: Theme) {
  const c = HIGHLIGHT_COLORS[theme];
  return HighlightStyle.define([
    { tag: tags.keyword, color: c.keyword },
    { tag: [tags.string, tags.regexp], color: c.string },
    { tag: tags.comment, color: c.comment, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c.function },
    { tag: [tags.number, tags.bool, tags.null], color: c.number },
  ]);
}

// Inner component that owns the CodeMirror lifecycle. Recreated when `path`
// changes via the parent's keyed <Show>. Solid disposes onCleanup in
// dependency order — no `cancelled` flag, no stale-closure ref needed.
function EditorView_(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        javascript({ typescript: true, jsx: true }),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        baseTheme,
        themeCompartment.of(syntaxHighlighting(highlightStyleFor(props.theme), { fallback: true })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) props.onChange(update.state.doc.toString());
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
  });

  onCleanup(() => {
    view?.destroy();
  });

  // External value sync — skip if already matching (avoids cursor jump).
  createEffect(() => {
    const v = view;
    if (!v) return;
    const next = props.value;
    const current = v.state.doc.toString();
    if (current === next) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: next } });
  });

  // Theme reconfigure via compartment.
  createEffect(() => {
    view?.dispatch({
      effects: themeCompartment.reconfigure(syntaxHighlighting(highlightStyleFor(props.theme), { fallback: true })),
    });
  });

  return <div class="editor-host h-full min-h-0 overflow-hidden" ref={host} />;
}

export default function Editor(props: Props) {
  // Keyed Show disposes + recreates EditorView_ when path changes, mirroring
  // React's `[path]` effect dep without the ref/destroy ceremony.
  return (
    <Show when={props.path} keyed>
      <EditorView_ {...props} />
    </Show>
  );
}
