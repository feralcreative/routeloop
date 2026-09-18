// The color a route is DRAWN in on a dark map, from the color it is STORED as.
// Ziad's call, 2026-09-17: the route palette (src/maps/palette.ts) was
// authored for light tiles — a navy, a plum, a forest green, a maroon — and on
// dark tiles those lines were nearly the tiles. The stored color is data: it
// is what the rider chose, it is in every export's KML styling, and it is what
// a light map draws. What a DARK map draws is that color lifted, hue and
// saturation kept, lightness raised to a floor a line can be read at over
// near-black — so a rider's plum stays plum and their navy stays blue, and
// both exist.
//
// Pure, DOM-free, and eval'd by test/route-ink.test.ts. map-common.js is the
// caller and decides WHEN — it knows what the tiles are — this only knows how.
(function (window) {
  "use strict";

  // The lightness a line on dark tiles is raised to. Two notches: a route at
  // L*40 (the default blue) lands at the same L as its own light-map legend
  // reads at, and the near-black entries in the palette (the forest green at
  // L 10, the maroon at 17) become a green and a red rather than nothing.
  var DARK_FLOOR = 58;

  // A hex, short or long, or the `rgb(r, g, b)` a style object reads a hex
  // back as — which is what a marker's color arrives as by the time
  // map-common.js asks. Anything else is null and passes through untouched.
  function parseHex(hex) {
    var str = String(hex || "").trim();
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var f = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(str);
    if (f) return [Number(f[1]), Number(f[2]), Number(f[3])];
    return null;
  }

  function toHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (v) {
          var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
          return s.length === 1 ? "0" + s : s;
        })
        .join("")
    );
  }

  // HSL, in the 0–360 / 0–100 / 0–100 ranges. Not OKLCH: the palette is eleven
  // authored hexes, the lift is one dial, and a rider reads "the same color,
  // brighter" by hue — which HSL keeps exactly.
  function toHsl(rgb) {
    var r = rgb[0] / 255,
      g = rgb[1] / 255,
      b = rgb[2] / 255;
    var max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s * 100, l * 100];
  }

  function fromHsl(hsl) {
    var h = hsl[0] / 360,
      s = hsl[1] / 100,
      l = hsl[2] / 100;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  /**
   * The stored color, lifted for dark tiles: lightness raised to DARK_FLOOR
   * and left alone above it. Anything that is not a hex comes back as it
   * came — a CSS variable, a named color, an empty string — because the
   * caller's fallback is the right answer for those, not a guess.
   */
  function liftForDark(hex) {
    var rgb = parseHex(hex);
    if (!rgb) return hex;
    var hsl = toHsl(rgb);
    if (hsl[2] >= DARK_FLOOR) return toHex(rgb);
    return toHex(fromHsl([hsl[0], hsl[1], DARK_FLOOR]));
  }

  window.TBRouteInk = {
    DARK_FLOOR: DARK_FLOOR,
    liftForDark: liftForDark,
    toHsl: toHsl,
    parseHex: parseHex,
  };
})(typeof window !== "undefined" ? window : this);
