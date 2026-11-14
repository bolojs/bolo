/** Built-in shim sources for the `next/*` imports compiled pages reference.
 * Served by NextDevServer at `/_bolo/shims/<name>.js` so pages run without
 * the real `next` package. These are deliberately small browser-first
 * implementations, not ports of Next internals. */

const headShim = `
// Minimal next/head: collects <title> and <meta> children into document.head
// on mount. Enough for create-next-app pages; not a full side-effect manager.
import { useEffect } from "react";
export default function Head({ children }) {
  useEffect(() => {
    const nodes = Array.isArray(children) ? children : [children];
    const applied = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const tag = node.type;
      if (typeof tag !== "string") continue;
      if (tag === "title") {
        document.title = node.props?.children ?? "";
        continue;
      }
      if (tag !== "meta" && tag !== "link") continue;
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(node.props ?? {})) {
        if (k === "children") continue;
        el.setAttribute(k, String(v));
      }
      document.head.appendChild(el);
      applied.push(el);
    }
    return () => { for (const el of applied) el.remove(); };
  }, [children]);
  return null;
}
`;

const linkShim = `
// Minimal next/link: an anchor that intercepts same-origin navigations via
// history.pushState; full route transitions happen through the dev server.
import { createElement, forwardRef } from "react";
const Link = forwardRef(function Link({ href = "", as, children, ...rest }, ref) {
  const target = as ?? href;
  return createElement("a", { href: String(target), ref, ...rest }, children);
});
export default Link;
`;

const routerShim = `
// Minimal next/router: query/params come from the bootstrap, push/replace use
// location.assign/replace. No route events in N1.
import { createElement, useMemo } from "react";
let current = { pathname: "/", query: {}, asPath: "/", params: {} };
export function setBoloRouterState(state) { current = { ...current, ...state }; }
export function useRouter() {
  return useMemo(() => ({
    pathname: current.pathname,
    query: current.query,
    asPath: current.asPath,
    params: current.params,
    isReady: true,
    push: (url) => { location.assign(String(url)); },
    replace: (url) => { location.replace(String(url)); },
    back: () => { history.back(); },
    reload: () => { location.reload(); },
    prefetch: async () => {},
    events: { on: () => {}, off: () => {} },
  }), []);
}
export const withRouter = (Component) => (props) =>
  createElement(Component, { ...props, router: { pathname: "/", query: {}, asPath: "/", push: (u) => location.assign(String(u)), replace: (u) => location.replace(String(u)), back: () => history.back(), reload: () => location.reload(), prefetch: async () => {}, events: { on: () => {}, off: () => {} } } });
`;

const dynamicShim = `
// next/dynamic: render the loaded component once resolved (no loading boundary in N1).
import { createElement, useEffect, useState } from "react";
export default function dynamic(loader, options = {}) {
  let loaded = null;
  const load = () => Promise.resolve(loader()).then((m) => (loaded = m?.default ?? m));
  function DynamicComponent(props) {
    const [Component, setComponent] = useState(loaded);
    useEffect(() => {
      if (!Component) load().then(setComponent);
    }, [Component]);
    if (!Component) return options.loading ? createElement(options.loading) : null;
    return createElement(Component, props);
  }
  DynamicComponent.preload = load;
  return DynamicComponent;
}
`;

const imageShim = `
// next/image: plain <img>; the optimizer endpoint is a documented N2 gap.
import { createElement, forwardRef } from "react";
const Image = forwardRef(function Image({ src, alt = "", ...rest }, ref) {
  return createElement("img", { src: src == null ? undefined : String(src), alt, ref, ...rest });
});
export default Image;
`;

const scriptShim = `
// next/script: plain <script> appended on mount.
import { useEffect } from "react";
export default function Script({ src, children, strategy, ...rest }) {
  useEffect(() => {
    const el = document.createElement("script");
    if (src) el.src = src;
    if (children) el.text = String(children);
    for (const [k, v] of Object.entries(rest)) el.setAttribute(k, String(v));
    document.body.appendChild(el);
    return () => el.remove();
  }, [src, children]);
  return null;
}
`;

export const NEXT_SHIMS: Record<string, string> = {
  head: headShim,
  link: linkShim,
  router: routerShim,
  dynamic: dynamicShim,
  image: imageShim,
  script: scriptShim,
};
