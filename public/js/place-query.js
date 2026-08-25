// Telling a CATEGORY search from a NAME search, and tagging what comes back.
//
// Two different questions reach one search box. "Chevron Oakdale CA" names a
// place and wants Autocomplete, which matches names and addresses. "gas station
// in oakdale ca" names a KIND of place and wants Text Search, which is a
// different API, billed differently, and the only one that can enumerate the
// gas stations in a town. Autocomplete answers the second question with the one
// business literally called "76 Gas Station", which is how this was reported:
// searching for a gas station in Oakdale found one result and it was the wrong
// kind of answer.
//
// Kept separate from builder.js because it is pure: no DOM, no google.maps, no
// state. test/place-query.test.ts drives window.TBQuery the same way
// twist-client.test.ts drives window.TBTwist. The detection rule is the part
// worth testing — a false positive spends a Text Search call on a query that
// wanted a name, and a false negative is the bug this file exists to fix.
(function (window) {
  "use strict";

  // A category phrase and the role a point found through it should carry.
  //
  // ROLES, not Google's place types: the rider picked "gas" and the point they
  // get should already be tagged Gas, because the alternative is finding the
  // station and then opening the row menu to say what it obviously is. The
  // roles here are from src/maps/roles.ts and every one has to exist there.
  //
  // Phrases are matched WHOLE, longest first, so "gas station" is not read as
  // "gas" plus stray words and "rest stop" is not read as "rest".
  const CATEGORIES = [
    { role: "gas", phrases: ["gas", "gas station", "gas stations", "fuel", "petrol", "gasoline", "fuel stop"] },
    {
      role: "charge",
      phrases: ["ev charger", "ev chargers", "ev charging", "charger", "chargers", "charging station", "charging stations", "supercharger"],
    },
    {
      role: "food",
      phrases: ["food", "restaurant", "restaurants", "lunch", "dinner", "breakfast", "diner", "diners", "burgers", "pizza", "tacos", "bbq", "barbecue", "somewhere to eat", "place to eat"],
    },
    { role: "coffee", phrases: ["coffee", "coffee shop", "coffee shops", "cafe", "cafes", "café", "espresso"] },
    { role: "drinks", phrases: ["bar", "bars", "drinks", "brewery", "breweries", "pub", "pubs", "beer"] },
    {
      role: "hotel",
      phrases: ["hotel", "hotels", "motel", "motels", "lodging", "inn", "inns", "somewhere to stay", "place to stay"],
    },
    { role: "camp", phrases: ["camp", "campground", "campgrounds", "camping", "campsite", "campsites", "rv park", "rv parks"] },
    { role: "grocery", phrases: ["grocery", "groceries", "grocery store", "supermarket", "supermarkets", "market"] },
    { role: "break", phrases: ["rest area", "rest areas", "rest stop", "rest stops", "restroom", "restrooms", "bathroom"] },
    { role: "view", phrases: ["viewpoint", "viewpoints", "scenic", "scenic overlook", "overlook", "overlooks", "lookout", "vista"] },
    // No role fits a tire shop, and a rider looking for one is not tagging it —
    // they want it found. `poi` is the honest answer and what these would be
    // anyway, since every created point starts as a POI.
    {
      role: "poi",
      phrases: ["mechanic", "mechanics", "motorcycle shop", "motorcycle shops", "motorcycle dealer", "bike shop", "tires", "tyres", "tire shop", "atm", "pharmacy", "hospital", "urgent care", "car wash"],
    },
  ];

  // Longest phrase first so a prefix never wins over the fuller phrase.
  const PHRASES = CATEGORIES.flatMap((c) => c.phrases.map((p) => ({ phrase: p, role: c.role }))).sort(
    (a, b) => b.phrase.length - a.phrase.length,
  );

  // The words that separate a kind from a place: "gas station IN oakdale".
  //
  // Text Search reads the whole phrase itself — the API's own documented example
  // is "Spicy Vegetarian Food in Sydney, Australia" — so this is NOT used to cut
  // the place out and geocode it separately. It is only used to find where the
  // category phrase ends, so the head can be matched against the list above.
  const SPLITTERS = [" in ", " near ", " around ", " close to ", " by "];

  // Filler that can sit in front of a category without changing it.
  //
  // LONGEST FIRST, like PHRASES above and for the same reason: stripping "find "
  // off "find me a gas station" leaves "me a gas station", which matches nothing.
  // The loop below strips repeatedly, so "find me " then "a " gets there — but
  // only if the longer leader is tried first.
  const LEADERS = ["a ", "an ", "the ", "some ", "any ", "find ", "find a ", "find me ", "show me ", "nearest ", "closest "].sort(
    (a, b) => b.length - a.length,
  );

  const clean = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();

  /**
   * Is this a category query, and if so which role?
   *
   * Returns `{ text, role }` — `text` is the query UNCHANGED, because Text
   * Search wants the whole thing including the place, and `role` is what to tag
   * a picked result with. Returns null for a name query, which is the default:
   * detection has to be conservative, because a false positive spends a billed
   * Text Search call on somebody typing a business name.
   *
   * DELIBERATELY NOT MATCHED: brand names. "Shell", "Chevron", "76" are places,
   * not kinds, even though a person would call them gas stations — so they go
   * down the Autocomplete path and resolve to the specific station meant.
   */
  function parse(input) {
    const q = clean(input);
    if (!q) return null;

    // Cut at the first splitter to find the head. No splitter means the whole
    // query is the candidate head ("coffee", "gas station").
    let head = q;
    for (const sep of SPLITTERS) {
      const at = q.indexOf(sep);
      if (at > 0) {
        head = q.slice(0, at);
        break;
      }
    }

    // Strip leading filler, once — "find me a gas station" is one strip of
    // "find me " and then "a ", so this loops until nothing more comes off.
    let changed = true;
    while (changed) {
      changed = false;
      for (const lead of LEADERS) {
        if (head.startsWith(lead)) {
          head = head.slice(lead.length);
          changed = true;
          break;
        }
      }
    }
    head = head.trim();
    if (!head) return null;

    const hit = PHRASES.find((p) => p.phrase === head);
    return hit ? { text: String(input).trim(), role: hit.role } : null;
  }

  // Google's place types to our roles, for a result the rider did not ask for
  // by category — a chip tap returns whatever the API thinks is nearby, and a
  // convenience store among the gas stations should not come back tagged Gas.
  //
  // The chip's own role wins when it has one; this is the fallback for a typed
  // query and for anything unrecognized. Unmapped is null, not `poi`: a point is
  // created as a POI anyway, so claiming a role nothing established is worse
  // than leaving it untagged.
  const TYPE_ROLE = {
    gas_station: "gas",
    electric_vehicle_charging_station: "charge",
    restaurant: "food",
    fast_food_restaurant: "food",
    meal_takeaway: "food",
    hamburger_restaurant: "food",
    pizza_restaurant: "food",
    mexican_restaurant: "food",
    barbecue_restaurant: "food",
    breakfast_restaurant: "food",
    diner: "food",
    cafe: "coffee",
    coffee_shop: "coffee",
    bar: "drinks",
    pub: "drinks",
    brewery: "drinks",
    hotel: "hotel",
    motel: "hotel",
    lodging: "hotel",
    inn: "hotel",
    resort_hotel: "hotel",
    campground: "camp",
    rv_park: "camp",
    camping_cabin: "camp",
    supermarket: "grocery",
    grocery_store: "grocery",
    rest_stop: "break",
    scenic_lookout: "view",
    observation_deck: "view",
  };

  const roleForType = (type) => TYPE_ROLE[String(type || "").toLowerCase()] || null;

  window.TBQuery = { parse, roleForType, CATEGORIES };
})(window);
