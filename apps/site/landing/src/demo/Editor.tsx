/** @jsxImportSource solid-js */
import { onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#9333ea" },
  { tag: [tags.string, tags.special(tags.string)], color: "#dc2626" },
  { tag: [tags.variableName, tags.propertyName], color: "#2563eb" },
  { tag: tags.comment, color: "#16a34a" },
]);

interface Props {
  value: string;
  onChange(value: string): void;
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

export default function Editor(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        javascript({ typescript: true }),
        lineNumbers(),
        highlightActiveLineGutter(),
        syntaxHighlighting(lightHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
        }),
        themeCompartment.of(buildTheme(host)),
      ],
    });
    view = new EditorView({ state, parent: host });

    const observer = new MutationObserver(() => {
      view?.dispatch({ effects: themeCompartment.reconfigure(buildTheme(host)) });
    });
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    onCleanup(() => {
      observer.disconnect();
      view?.destroy();
    });
  });

  return <div class="h-full min-h-0 overflow-hidden" ref={host} />;
}
