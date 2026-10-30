// App only. Android's back button would otherwise close the app, because the web UI changes screens without browser
// history. Here back closes what is open on top (the menu, then Ask a question, Conversation watch or My info, using the
// same buttons a tap would), and otherwise puts the app in the background like the home button. It never moves the
// accident steps backwards and never ends the app, so the session and any listening are not lost by accident.
"use strict";
(() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App;
  if (!plugin) return;

  const click = (id) => { const el = document.getElementById(id); if (!el) return false; el.click(); return true; };

  plugin.addListener("backButton", () => {
    const menu = document.getElementById("menu");
    if (menu && !menu.hidden) { click("menu-btn"); return; }
    // `state` is app.js's own state; its overlay views are named after the menu buttons that toggle them.
    const view = typeof state !== "undefined" && state ? state.view : null;
    if (view && click(view)) return;
    plugin.minimizeApp().catch(() => {});
  });
})();
