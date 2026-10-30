// Checks android-app/native/native-back.js against a fake Android App plugin. Run by tests/test_android_app.py.
"use strict";
const path = require("path");
const failures = [];
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };

const clicks = [];
const elements = {};
for (const id of ["menu-btn", "ask", "watch", "profile"]) elements[id] = { click: () => clicks.push(id) };
elements.menu = { hidden: true };

let onBack = null;
let minimized = 0;
const plugin = {
  addListener: (name, fn) => { if (name === "backButton") onBack = fn; return Promise.resolve({ remove() {} }); },
  minimizeApp: async () => { minimized += 1; },
};
global.window = { Capacitor: { isNativePlatform: () => true, Plugins: { App: plugin } } };
global.document = { getElementById: (id) => elements[id] || null };
global.state = { view: null };   // app.js's state, shared by name between the page's scripts
require(path.join(__dirname, "..", "android-app", "native", "native-back.js"));
eq("listens for the back button", typeof onBack, "function");

// 1) an open menu is closed with its own button
elements.menu.hidden = false;
onBack();
eq("menu closed", clicks, ["menu-btn"]);
elements.menu.hidden = true;

// 2) an overlay screen is closed with the menu button that toggles it
for (const view of ["ask", "watch", "profile"]) {
  clicks.length = 0;
  global.state.view = view;
  onBack();
  eq(`${view} closed`, clicks, [view]);
}
eq("never minimized while something was open", minimized, 0);

// 3) on an accident step: the app goes to the background, nothing is clicked, the steps do not move back
clicks.length = 0;
global.state.view = null;
onBack();
eq("nothing clicked on a step", clicks, []);
eq("minimized instead of closed", minimized, 1);

if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("native back checks passed");
