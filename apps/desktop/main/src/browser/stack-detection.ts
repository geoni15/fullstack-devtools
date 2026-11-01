export const FRONTEND_FRAMEWORK_SCRIPT = String.raw`
(() => {
  try {
    const global = globalThis;
    const doc = document;
    if (doc.querySelector('astro-island')) return 'Astro';
    if (global.__remixContext || global.__remixRouteModules) return 'Remix';
    if (global.__NEXT_DATA__ || doc.getElementById('__next')) return 'Next.js';
    if (global.__NUXT__ || doc.getElementById('__nuxt')) return 'Nuxt';
    const body = doc.body;
    let react = false;
    let vue = false;
    if (body) {
      const nodes = [body];
      const all = body.getElementsByTagName('*');
      const limit = Math.min(all.length, 160);
      for (let index = 0; index < limit; index += 1) {
        const node = all[index];
        if (node) nodes.push(node);
      }
      for (const node of nodes) {
        let keys = [];
        try { keys = Object.getOwnPropertyNames(node); } catch (error) { keys = []; }
        for (const key of keys) {
          if (
            key.indexOf('__reactFiber$') === 0 ||
            key.indexOf('__reactProps$') === 0 ||
            key.indexOf('__reactEventHandlers$') === 0
          ) {
            react = true;
          } else if (
            key === '__vue__' ||
            key === '__vnode' ||
            key.indexOf('__vueParentComponent') === 0
          ) {
            vue = true;
          }
        }
        if (react || vue) break;
      }
    }
    if (react) return 'React';
    if (vue) return 'Vue';
    if (doc.querySelector('[data-v-app]')) return 'Vue';
    if (global.React) return 'React';
    if (global.Vue || global.__VUE__) return 'Vue';
    if (doc.querySelector('[ng-version]') || global.ng) return 'Angular';
    if (doc.querySelector('[class*="svelte-"]') || global.__svelte) return 'Svelte';
    if (doc.querySelector('[data-hk]') || global._$HY) return 'Solid';
    return null;
  } catch (error) {
    return null;
  }
})()
`;
