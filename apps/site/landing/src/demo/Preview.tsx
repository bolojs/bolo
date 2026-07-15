/** @jsxImportSource solid-js */
interface Props {
  url: string | null;
}

export default function Preview(props: Props) {
  return (
    <div class="flex h-full min-h-0 items-center justify-center overflow-hidden">
      {props.url ? (
        <iframe title="Preview" src={props.url} class="h-full w-full border-0 bg-white" />
      ) : (
        <p class="max-w-[22ch] px-4 text-center text-[12.5px] leading-relaxed text-muted">
          This scenario doesn't run a server.
        </p>
      )}
    </div>
  );
}
