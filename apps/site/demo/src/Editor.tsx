import { onCleanup, onMount } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";

interface Props {
  value: string;
  onChange(value: string): void;
}

export default function Editor(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        javascript(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
          ".cm-content": { padding: "12px 0" },
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    onCleanup(() => view?.destroy());
  });

  return (
    <section class="editor-pane">
      <div class="editor-pane-header">index.js</div>
      <div class="editor-pane-body" ref={host} />
    </section>
  );
}
