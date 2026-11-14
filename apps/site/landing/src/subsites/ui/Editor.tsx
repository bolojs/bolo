/** @jsxImportSource solid-js */
import { createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#9333ea" },
  { tag: [tags.string, tags.special(tags.string)], color: "#dc2626" },
  { tag: [tags.variableName, tags.propertyName], color: "#2563eb" },
  { tag: tags.comment, color: "#16a34a" },
]);

export interface EditorDocument {
  path: string;
  contents: string;
}

interface Props {
  documents: EditorDocument[];
  activePath: string | null;
  onSelect(path: string): void;
  onClose(path: string): void;
  onChange(path: string, contents: string): void;
}

const buildTheme = (host: HTMLElement) => {
  const style = getComputedStyle(host);
  const fg = style.getPropertyValue("--fg").trim();
  const muted = style.getPropertyValue("--muted").trim();
  const accent = style.getPropertyValue("--accent").trim();
  const accentDim = style.getPropertyValue("--accent-dim").trim();

  return EditorView.theme({
    "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: fg },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
    ".cm-content": { padding: "14px" },
    ".cm-gutters": { backgroundColor: "transparent", color: muted, border: "none" },
    ".cm-activeLine": { backgroundColor: accentDim, opacity: 0.15 },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-cursor": { borderLeftColor: accent },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: `${accentDim} !important` },
    "&.cm-focused": { outline: "none" },
    ".cm-line": { caretColor: accent },
  });
};

const tabBase =
  "rounded-lg px-3 py-1 text-[12px] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

export default function Editor(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();

  const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

  const buildState = (contents: string) =>
    EditorState.create({
      doc: contents,
      extensions: [
        javascript({ typescript: true }),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(highlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && props.activePath) {
            props.onChange(props.activePath, update.state.doc.toString());
          }
        }),
        themeCompartment.of(buildTheme(host)),
      ],
    });

  // One EditorState per open tab so history and cursor survive tab switches.
  const states = new Map<string, EditorState>();
  let loadedPath: string | null = null;

  onMount(() => {
    const active = props.activePath;
    if (active) {
      states.set(
        active,
        buildState(props.documents.find((d) => d.path === active)?.contents ?? ""),
      );
      loadedPath = active;
    }
    view = new EditorView({ state: states.get(props.activePath ?? "") ?? buildState(""), parent: host });

    const observer = new MutationObserver(() => {
      view?.dispatch({ effects: themeCompartment.reconfigure(buildTheme(host)) });
    });
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    onCleanup(() => {
      observer.disconnect();
      view?.destroy();
    });
  });

  createEffect(() => {
    const active = props.activePath;
    const doc = props.documents.find((d) => d.path === active);
    if (!view || !active || active === loadedPath) return;
    if (!states.has(active)) {
      states.set(active, buildState(doc?.contents ?? ""));
    }
    loadedPath = active;
    view.setState(states.get(active)!);
    view.focus();
  });

  return (
    <div data-panel="editor" class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] px-1.5 py-1">
        {props.documents.map((doc) => (
          <span class="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => props.onSelect(doc.path)}
              class={`${tabBase} ${doc.path === props.activePath ? "bg-[var(--surface-2)] font-medium text-fg shadow-sm" : "text-muted hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]"}`}
            >
              {fileName(doc.path)}
            </button>
            <button
              type="button"
              aria-label={`Close ${fileName(doc.path)}`}
              onClick={() => props.onClose(doc.path)}
              class="rounded px-1 text-[11px] text-muted hover:text-fg"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div class="min-h-0 flex-1 overflow-hidden" ref={host} />
    </div>
  );
}
