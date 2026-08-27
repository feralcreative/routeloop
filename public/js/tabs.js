// The tab strip, for any surface that wants one.
//
// TWO SURFACES USE THIS AND THAT IS WHY IT EXISTS. The builder's panel got tabs
// on 2026-08-26 and the dashboard's ride lists got them the same day; the
// keyboard behavior is identical on both, and two copies of a roving tabindex is
// two things to get subtly different. The CSS is NOT shared — a 380px drawer and
// a page-width strip want different metrics — but the behavior is.
//
// A ROVING TABINDEX, which is what the tab pattern actually is: exactly one tab
// is in the page's tab order at a time and the arrow keys move between them.
// Every tab reachable by Tab would put the content below N presses further away
// for a keyboard rider, on every visit.
//
// AUTOMATIC ACTIVATION — moving focus moves the selection. That is the right
// half of the pattern here because showing a panel costs nothing: everything is
// already in the DOM, and the one surface that fetches (the builder's Riders
// tab) caches its own answer. Manual activation is for tabs whose panels are
// expensive, which neither of these is.
//
// `hidden` does the hiding, not a class and not `display: none` in CSS. It is
// what assistive tech and find-in-page both read — and a panel hidden only by a
// class is still focusable, so Tab walks into content nobody can see.
(() => {
  "use strict";

  // The panel a tab controls, by aria-controls. Not a naming convention on ids,
  // because the attribute is required for the pattern anyway and inventing a
  // second link between the two is a second thing that can disagree.
  function panelOf(tab) {
    const id = tab.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }

  function tabsIn(strip) {
    return Array.from(strip.querySelectorAll('[role="tab"]'));
  }

  /**
   * Wire one strip.
   *
   * `onSelect` is called with the newly selected tab element AFTER the panels
   * have been switched, for a surface that has to do something on open — the
   * builder's Riders tab fetches its roster there. Optional, and called for a
   * click or a key but never for the initial state, which the server rendered.
   */
  function init(strip, onSelect) {
    if (!strip || strip.dataset.tabsWired === "1") return;
    strip.dataset.tabsWired = "1";
    const tabs = tabsIn(strip);
    if (tabs.length === 0) return;

    function select(tab) {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.classList.toggle("is-active", on);
        // The roving half: only the selected tab is tabbable.
        if (on) t.removeAttribute("tabindex");
        else t.setAttribute("tabindex", "-1");
        const panel = panelOf(t);
        if (panel) {
          panel.hidden = !on;
          panel.classList.toggle("is-active", on);
        }
      }
      if (onSelect) onSelect(tab);
    }

    strip.addEventListener("click", (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab && tabs.includes(tab)) select(tab);
    });

    strip.addEventListener("keydown", (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (!tab) return;
      const i = tabs.indexOf(tab);
      if (i < 0) return;
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      // Or Left and Right scroll the strip and Home jumps to the top of the
      // page, both of which happen underneath the selection change.
      e.preventDefault();
      select(next);
      next.focus();
    });

    return select;
  }

  // Anything marked `data-tabs` wires itself on load. A surface that needs an
  // onSelect hook calls init() directly instead and leaves the attribute off —
  // which is what the builder does.
  function autoInit() {
    document.querySelectorAll("[data-tabs]").forEach((strip) => init(strip));
  }

  window.TBTabs = { init: init };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoInit);
  else autoInit();
})();
