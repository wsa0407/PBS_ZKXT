import { reactive, shallowRef } from "vue";

// Shared hash-router state. Lives in its own module so pages never import the entry script
// (importing main.js from a page would run the app bootstrap a second time).
export const router = reactive({ path: "", params: {}, component: shallowRef(null) });

let routes = [];

export function setRoutes(list) {
  routes = list;
}

export function resolve() {
  const path = location.hash.replace(/^#/, "") || "/projects";
  for (const [re, component, keys = []] of routes) {
    const m = path.match(re);
    if (m) {
      router.path = path;
      router.params = Object.fromEntries(keys.map((k, i) => [k, m[i + 1]]));
      router.component = component;
      return;
    }
  }
  location.hash = "#/projects";
}

export const go = (path) => (location.hash = `#${path}`);
