import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
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
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--surface)", color: "var(--on-surface)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono), ui-monospace, monospace" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--on-surface-variant)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--surface-container-low)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-container-low)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--surface-container-high) !important" },
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

export default function Editor({ path, value, theme, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const themeCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        javascript({ typescript: true, jsx: true }),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        baseTheme,
        themeCompartment.current.of(syntaxHighlighting(highlightStyleFor(theme), { fallback: true })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(syntaxHighlighting(highlightStyleFor(theme), { fallback: true })),
    });
  }, [theme]);

  return <div className="editor-host h-full min-h-0 overflow-hidden" ref={hostRef} />;
}
