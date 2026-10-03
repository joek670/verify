// Applies a saved light or dark choice before the first paint. This is a classic script
// loaded from <head> because the CSP forbids inline scripts, and a module or deferred
// script would run after the page has already been drawn in the wrong theme.
// With nothing saved, the page follows the system setting through CSS color-scheme.
(() => {
  const KEY = "verify-theme";
  const root = document.documentElement;

  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Storage can be blocked; the page still follows the system setting.
  }
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  function choose(value) {
    try {
      if (value === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {
      // The choice still applies for this visit.
    }
    if (value === "system") delete root.dataset.theme;
    else root.dataset.theme = value;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const current = root.dataset.theme ?? "system";
    for (const input of document.querySelectorAll('input[name="theme"]')) {
      input.checked = input.value === current;
      input.addEventListener("change", () => {
        if (input.checked) choose(input.value);
      });
    }
  });
})();
