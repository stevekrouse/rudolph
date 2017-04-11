import { repeat, withEffects } from "@funkia/jabz";
import {
  Behavior,
  empty,
  Now,
  performStream,
  performStreamOrdered,
  placeholderStream,
  sink,
  snapshotWith,
  Stream
} from "@funkia/hareactive";

export type ParamBehavior = Behavior<Record<string, string>>;

const supportHistory = "history" in window && "pushState" in window.history;
const supportHash = "onhashchange" in window;

function fst<A>(arr: A[]): A;
function fst(arr: string): string;
function fst<A>(arr: A[] | string): A | string {
  return arr[0];
}

function takeUntilRight(stop: string, str: string): string {
  return str.substr(str.indexOf(stop) + 1);
}

type RouterConfig = {
  useHash: boolean
};

export type Router = {
  prefixPath: string,
  path: Behavior<string>,
  config: RouterConfig
};

/**
 * Takes a configuration Object describing how to handle the routing.
 * @param config An Object containing the router basic router configurations.
 */
export function createRouter(config: RouterConfig): Router {
  if (config.useHash && !supportHash) {
    throw new Error("No support for hash-routing.");
  } else if (!supportHistory) {
    throw new Error("No support for history API.");
  }
  return {
    prefixPath: "",
    path: config.useHash ? locationHashB : locationB,
    config
  };
}

// locationHashB: Behavior<string> - string of location.hash
export const locationHashB = sink(takeUntilRight("#", window.location.hash) || "/");
window.addEventListener("hashchange", (evt) => locationHashB.push(takeUntilRight("#", evt.newURL)), false);

// locationB
export const locationB = sink(window.location.pathname);
window.addEventListener("popstate", (evt) => locationB.push((<Window>evt.target).location.pathname));

const navigateHashIO = withEffects((path: string) => window.location.hash = path);
const navigateIO = withEffects((path: string) => {
  locationB.push(path);
  return window.history.pushState({}, "", path);
});

/**
 * Takes a stream of Paths. Whenever the stream has an occurrence it is
 * navigated to.
 * @param pathStream A stream of paths.
 */
export function navigate(router: Router, pathStream: Stream<string>): Now<Stream<any>> {
  const newUrl = pathStream.map(path => router.prefixPath + path);
  const navigateFn: any = router.config.useHash ? navigateHashIO : navigateIO;
  return performStreamOrdered(newUrl.map(navigateFn));
}

function readParams(pattern: string, path: string): Record<string, string> {
  const patternParts = pattern.split("/");
  let paramRecord: Record<string, number> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (fst(part) === ":") {
      paramRecord[part.substr(1)] = i;
    }
  }

  const pathParts = path.split("/");
  let params: Record<string, string> = {};
  for (const param of Object.keys(paramRecord)) {
    params[param] = pathParts[paramRecord[param]];
  }
  return params;
}

/**
 * Takes a URL pattern, a behavior of the current location and returns a
 * behavior with the result of parsing the location according to the pattern.
 * @param pattern An URL pattern of the form `foo/:param/bar`
 * @param locationBehavior A behavior describing the current location.
 */
export function parsePathParams(pattern: string, locationBehavior: Behavior<string>): Behavior<Record<string, string>> {
  return locationBehavior.map((location) => readParams(pattern, location));
}

type PathHandler<A> = (subrouter: Router, params: Record<string, string>) => A;

type ParsedPathPattern<A> = {
  path: string[];
  params: Record<string, number>;
  length: number;
  handler: PathHandler<A>
};

function parsePathPattern<A>(pattern: string, handler: PathHandler<A>): ParsedPathPattern<A> {
  const patternParts = pattern.split("/");
  let p: ParsedPathPattern<A> = {
    path: [],
    params: {},
    length: patternParts.length,
    handler
  };
  if (pattern === "*") {
    return p;
  }
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (fst(part) === ":") {
      p.params[part.substr(1)] = i;
    } else {
      p.path[i] = part;
    }
  }
  return p;
}

type Handler<A> = (router: Router, params: Record<string, string>) => A;
export type Routes<A> = Record<string, Handler<A>>;

/**
 * Takes a description of the routes, a behavior of the current location and returns a
 * behavior with the result of parsing the location according to the pattern.
 * @param routes A description of the routes, in the form {"/route/:urlParam"; (restUrl, params) => result}
 * @param locationBehavior A behavior describing the current location.
 */

export function routePath<A>(routes: Routes<A>, router: Router): Behavior<A> {
  const parsedRoutes = Object.keys(routes).map((path) => parsePathPattern(path, routes[path]));

  return router.path.map((location) => {
    const locationParts = location.split("/");
    const match = parsedRoutes.find(({ path }: ParsedPathPattern<A>) => path.every((part, index) => {
      return part === locationParts[index];
    }));

    const rest = "/" + locationParts.slice(match.length).join("/");
    const matchedPath = locationParts.slice(0, match.length).join("/");
    const newRouter: Router = {
      prefixPath: router.prefixPath + matchedPath,
      path: Behavior.of(rest),
      config: router.config
    };
    let params: Record<string, string> = {};
    for (const key of Object.keys(match.params)) {
      params[key] = locationParts[match.params[key]];
    }
    return match.handler(newRouter, params);
  });
}

export const beforeUnload = empty<WindowEventMap["beforeunload"]>();
window.addEventListener("beforeunload", (e) => { beforeUnload.push(e); });

const preventNavigationIO = withEffects((event: WindowEventMap["beforeunload"], shouldWarn: boolean) => {
  if (shouldWarn) {
    event.returnValue = "\o/";
    return "\o/";
  }
});

/**
 * Takes a behavior of a boolean, if true the user will have to confirm before unloading page.
 * @param shouldWarnB A behavior of a boolean
 */
export function warnNavigation(shouldWarnB: Behavior<boolean>): Now<Stream<string>> {
  const a = snapshotWith(preventNavigationIO, shouldWarnB, beforeUnload);
  return performStream(a);
}

type Tree<A> = {
  params: Record<string, string>;
  subtree: Record<string, Tree<A>>;
  index: number;
  handler?: Handler<A>;
};

// This is dirty... I know
function addPath<A>(tree: Tree<A>, path: string, handler: Handler<A>): Tree<A> {
  const nodes = path.split("/");
  let parent = tree;
  nodes.forEach((node, index) => {
    if (fst(node) === ":") {
      parent.params[index] = node.slice(1);
    } else {
      if (!(node in parent.subtree)) {
        const subtree: Tree<A> = {
          params: {},
          subtree: {},
          index
        };
        parent.subtree[node] = subtree;
      }
      parent = parent.subtree[node];
    }
  });
  parent.handler = handler;
  return tree;
}

function buildTree<A>(routes: Routes<A>): Tree<A> {
  const initial: Tree<A> = {
    params: {},
    subtree: {},
    index: 0
  };
  return Object.keys(routes).reduce((tree, route) => addPath(tree, route, routes[route]), initial);
}