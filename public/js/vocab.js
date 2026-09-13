// What the app calls things, in the browser (#321).
//
// A second implementation of wordsFor() in src/views/vocab.ts, deliberately,
// the twist.js arrangement: the server resolves the words for everything it
// renders, and the client needs them for everything IT renders — the builder's
// panel, the tips, the paddock — and needs to re-resolve when the ride's
// vehicle is changed in the builder without a round trip. The two are pinned
// together by test/vocab-client.test.ts over every preset and a custom word.
//
// THE DATA ARRIVES ON `window.TBVocabData`, emitted by page() in layout.tsx:
// the term table (id, axis, the preset words, the regional options), the
// rider's profile (preset and Custom words) and the ride's own pair when the
// page is about one ride. Every reader goes through w()/many()/off() so no
// caller holds a word across a change; `setRide()` and `forget()` drop the
// cache.
window.TBVocab = (function () {
  "use strict";

  const VEHICLES = ["motorcycle", "car", "bicycle"];
  const POWERS = ["gas", "electric", "pedal"];

  function toVehicle(v) {
    return VEHICLES.includes(v) ? v : "motorcycle";
  }

  function toPower(p, vehicle) {
    const raw = POWERS.includes(p) ? p : "gas";
    if (vehicle === "bicycle") return raw === "gas" ? "pedal" : raw;
    return raw === "pedal" ? "gas" : raw;
  }

  function customWord(s) {
    const i = s.indexOf("/");
    if (i > 0) {
      const one = s.slice(0, i).trim();
      return { one, many: s.slice(i + 1).trim() || one };
    }
    return { one: s, many: s + "s" };
  }

  // Mirrors wordsFor() exactly; see that function for the precedence.
  function resolve(terms, profile, ride) {
    const vehicle = ride && ride.vehicle ? toVehicle(ride.vehicle) : toVehicle(profile.vehicle);
    const power = toPower(ride && ride.power != null ? ride.power : profile.power, vehicle);
    const out = { vehicle_: vehicle, power_: power };
    const jargon = profile.jargon || {};
    for (const t of terms) {
      const custom = jargon[t.id];
      if (t.axis === "power" && power === "pedal") out[t.id] = null;
      else if (custom) out[t.id] = customWord(custom);
      else if (t.axis === "vehicle") out[t.id] = t.by[vehicle] || null;
      else if (t.axis === "power") out[t.id] = t.by[power] || null;
      else out[t.id] = (t.options && t.options[0]) || null;
    }
    return out;
  }

  let words = null;
  let ride = null;

  function data() {
    return (
      window.TBVocabData || { terms: [], profile: { vehicle: "motorcycle", power: "gas", jargon: {} }, ride: null }
    );
  }

  function current() {
    if (!words) {
      const d = data();
      words = resolve(d.terms, d.profile, ride === null ? d.ride : ride);
    }
    return words;
  }

  /** The word, singular; the id itself if the table does not know it, so a
   *  typo reads as a bare key rather than "undefined". */
  function w(id) {
    const x = current()[id];
    return x ? x.one : id;
  }

  function many(id) {
    const x = current()[id];
    return x ? x.many : id + "s";
  }

  /** Whether a term is blank on this ride — every power term under pedal. */
  function off(id) {
    const c = current();
    return id in c && c[id] === null;
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** The builder calls this when the ride's own pair changes. `null` clears
   *  the override back to what the page loaded with. */
  function setRide(r) {
    ride = r;
    words = null;
  }

  /** A jargon save on the account page rewrote `TBVocabData.profile`; drop
   *  the cache so the next read sees it. */
  function forget() {
    words = null;
  }

  return { w, many, off, cap, setRide, forget, resolve, customWord, toVehicle, toPower };
})();
