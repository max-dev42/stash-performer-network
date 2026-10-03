/*
 * Minimal stand-in for Stash's PluginApi, just enough for stash-performer-network.js to load outside
 * Stash. The page itself is mounted with window.SPNMount (see index.html); route and navbar
 * registration are no-ops here.
 */
(function () {
  "use strict";
  function noop() {}
  window.PluginApi = {
    React: {
      createElement: function () { return null; },
      useRef: function () { return { current: null }; },
      useState: function (v) { return [v, noop]; },
      useEffect: noop,
      Children: { toArray: function (c) { return [].concat(c || []); } },
    },
    libraries: { ReactRouterDOM: {}, Bootstrap: { Nav: {}, Button: {} }, Intl: {}, FontAwesomeSolid: {} },
    components: {},
    register: { route: noop },
    patch: { before: noop },
  };
})();
