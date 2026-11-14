/** getStaticProps execution for Pages Router data fetching (N1).
 * Props are computed at request time inside the container page context via
 * the injected module loader. */

export interface GetStaticPropsContext {
  readonly params: Record<string, string | string[]>;
}

export interface GetStaticPropsResult {
  readonly props: Record<string, unknown>;
  readonly revalidate?: number | boolean;
}

export const runGetStaticProps = async (
  mod: Record<string, unknown>,
  context: GetStaticPropsContext,
): Promise<GetStaticPropsResult> => {
  const fn = mod.getStaticProps;
  if (typeof fn !== "function") {
    return { props: {} };
  }
  const result = (await fn(context)) as
    | { props?: Record<string, unknown>; revalidate?: number | boolean }
    | undefined;
  if (!result || typeof result !== "object" || !("props" in result)) {
    throw new Error("getStaticProps must return an object with a `props` key");
  }
  return { props: result.props ?? {}, revalidate: result.revalidate };
};
