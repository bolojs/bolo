/** @jsxImportSource solid-js */
interface Props {
  url: string | null;
}

export default function Preview(props: Props) {
  return (
    <div data-panel="preview" class="flex h-full min-h-0 items-center justify-center overflow-hidden">
      {props.url ? (
        <iframe title="Preview" data-preview src={props.url} class="h-full w-full border-0 bg-white" />
      ) : (
        <p class="max-w-[26ch] px-4 text-center text-[12.5px] leading-relaxed text-muted">
          No server yet. Run one from the terminal to see it here.
        </p>
      )}
    </div>
  );
}
