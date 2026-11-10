// Apply the saved theme before first paint. Light unless dark was chosen: never the system setting.
// Loaded as a blocking <script src> in <head> so the page never flashes the wrong theme.
// Wrapped in an IIFE so pref doesn't become a global.
(function () {
  var pref = "light";
  try {
    pref = localStorage.getItem("mem-sync-theme");
    // No choice yet (or the old "system"): store light, so app.js's toggle starts from light rather than the OS setting.
    if (pref !== "dark" && pref !== "light") localStorage.setItem("mem-sync-theme", (pref = "light"));
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", pref === "dark" ? "dark" : "light");
})();
