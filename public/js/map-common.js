// Shared Google Maps helpers for the routeloop viewer and builder.
// Ports the hard-won behavior of the legacy Google Maps viewer (main.js):
// per-route colored tracks with direction arrows, role-icon markers tinted via
// currentColor, and the waypoint tooltip with its mileage columns.
//
// Expects window.TB = { gmapsKey, mapId, roles, ... } injected by the page shell
// and the Maps bootstrap loader (which defines google.maps.importLibrary) to
// have run. Exposes window.TBMap.
//
// This file is the ONLY one that touches google.maps. The viewer and the builder
// go through the handles returned here — that boundary is what made replacing
// Mapbox a rewrite of one file instead of three.
(function () {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  // --- Coordinate order -----------------------------------------------------

  // Every TBMap entry point speaks [lng, lat] — GeoJSON order, which is what
  // route_legs.geometry stores and what /api/route returns. google.maps speaks
  // {lat, lng}. These two functions are the ONLY place that conversion happens.
  // Reversed pairs still render, just in the wrong hemisphere, so confining the
  // swap to one place is the whole defense. Same reasoning as toGoogleWaypoint
  // in src/routes/routing.ts — keep it that way.
  const toLatLng = (lngLat) => ({ lat: lngLat[1], lng: lngLat[0] });

  function fromLatLng(p) {
    if (!p) return null;
    // A marker's position comes back as LatLng (accessors) or LatLngLiteral
    // (plain numbers) depending on how it was set.
    const lat = typeof p.lat === "function" ? p.lat() : p.lat;
    const lng = typeof p.lng === "function" ? p.lng() : p.lng;
    return [lng, lat];
  }

  // --- Library handles ------------------------------------------------------

  // Populated by initMap. Held here so the rest of the file reads like the
  // Mapbox original instead of awaiting an import in every function.
  let Maps = null; // google.maps.importLibrary("maps")
  let Core = null; // ... ("core")
  let Marker = null; // ... ("marker")

  function requireInit(what) {
    if (!Maps) throw new Error("TBMap: " + what + " called before initMap()");
  }

  // --- Map init -------------------------------------------------------------

  const DEFAULT_CENTER = { lat: 37.3, lng: -119.5 };
  const DEFAULT_ZOOM = 6;

  // fitBounds has no maxZoom, unlike the Mapbox call this replaces. A ride with
  // one stop would otherwise land at building zoom.
  const MAX_FIT_ZOOM = 14;

  // --- Basemap --------------------------------------------------------------

  // The four Google basemaps, as an allow-list. Written as strings rather than
  // MapTypeId.* on purpose: the enum lives in the "maps" library and would have
  // to be read off the handle after the await, while the literals are what the
  // API documents and accepts either way.
  //
  // Order is the order they appear in the control, and it is deliberate: the two
  // drawn maps first, then the two photographic ones.
  const MAP_TYPES = ["terrain", "roadmap", "satellite", "hybrid"];

  // Terrain, not roadmap, and this is the point of the whole block. A rider is
  // choosing roads to ride, and relief is the single most useful thing a basemap
  // can say about a road that a line on white cannot — a pass, a canyon, the
  // reason a road bends. Roadmap is still one click away for anyone navigating
  // by town rather than by terrain.
  //
  // Worth knowing before styling: terrain is raster imagery with vector data on
  // top, so the cloud styling attached to GMAPS_MAP_ID applies only to the
  // labels and roads drawn over it, not to the ground. Whatever is styled in the
  // Map ID will look like it partly stopped working here. It did not.
  const DEFAULT_MAP_TYPE = "terrain";

  // Per rider, per browser. Not on the ride: the basemap is how one person likes
  // to read a map, not a property of the route, and putting it on the record
  // would mean a shared link overrides the reader's own preference.
  const MAP_TYPE_KEY = "routeloop.mapType";

  // Private-mode Safari throws on localStorage access. Same guard as site.js and
  // builder-history.js — a failure has to degrade to "no preference" rather than
  // taking the map down, which on these two pages is the whole page.
  function storedMapType() {
    let v = null;
    try {
      v = window.localStorage.getItem(MAP_TYPE_KEY);
    } catch (e) {
      return DEFAULT_MAP_TYPE;
    }
    // Validated against the allow-list rather than trusted. The value survives
    // deploys, so a type we stop offering — or anything else that ends up under
    // this key — has to fall back rather than reach Maps.Map as a bad option.
    return MAP_TYPES.indexOf(v) === -1 ? DEFAULT_MAP_TYPE : v;
  }

  function rememberMapType(map) {
    map.addListener("maptypeid_changed", () => {
      const v = map.getMapTypeId();
      if (MAP_TYPES.indexOf(v) === -1) return;
      try {
        window.localStorage.setItem(MAP_TYPE_KEY, v);
      } catch (e) {
        /* nothing to do — the choice simply lasts as long as the page does */
      }
    });
  }

  async function initMap(container, opts) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) throw new Error("TBMap: no map container");

    [Core, Maps, Marker] = await Promise.all([
      google.maps.importLibrary("core"),
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("marker"),
    ]);

    const map = new Maps.Map(
      el,
      Object.assign(
        {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          // Advanced Markers render nothing at all without a Map ID — no error,
          // no marker, which reads as a data bug rather than a config one.
          mapId: window.TB.mapId,
          // Google's own POI pins open their own info windows and would fight
          // the builder's click-to-add-a-stop.
          clickableIcons: false,
          mapTypeId: storedMapType(),
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: MAP_TYPES,
            // TOP_CENTER, and every other edge is taken. The site header floats
            // over the map rather than sitting above it, so TOP_LEFT is under
            // the wordmark and TOP_RIGHT is under the nav hamburger — that
            // second collision was real and visible, not theorized. The left
            // edge below that is the builder's panel (fitTo pads 380px for it),
            // RIGHT_BOTTOM is the zoom control, and the bottom edge carries
            // Google's own logo and attribution, which may not be covered.
            position: Core.ControlPosition.TOP_CENTER,
          },
          // mapTypeControlStyle is deliberately unset. The default adapts to the
          // available width, collapsing to a dropdown on a narrow viewport,
          // which is the behavior wanted on a phone and is not worth
          // reimplementing by pinning a style and adding a breakpoint.
          streetViewControl: false,
          fullscreenControl: false,
          // The map is the page; scroll should zoom it without a modifier, which
          // is how the Mapbox engine behaved.
          gestureHandling: "greedy",
          zoomControl: true,
          zoomControlOptions: { position: Core.ControlPosition.RIGHT_BOTTOM },
        },
        opts || {},
      ),
    );
    rememberMapType(map);
    return map;
  }

  function fitTo(map, lngLats, padding) {
    requireInit("fitTo");
    if (!lngLats.length) return;
    const bounds = new Core.LatLngBounds();
    lngLats.forEach((p) => bounds.extend(toLatLng(p)));
    // Even padding. It was `left: 380` while #map spanned the whole viewport and
    // the panel floated over its left 380px — the fit had to push the route clear
    // of a panel drawn on top of it. The drawer takes its own column now and the
    // map is sized to what is left, so every edge of the map is visible and an
    // asymmetric pad would just shove the route to the right.
    map.fitBounds(bounds, padding ?? { top: 60, bottom: 60, left: 60, right: 60 });
    Core.event.addListenerOnce(map, "idle", () => {
      if (map.getZoom() > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
    });
  }

  function onMapClick(map, fn) {
    requireInit("onMapClick");
    return map.addListener("click", (e) => {
      if (e.latLng) fn(fromLatLng(e.latLng));
    });
  }

  function panTo(map, lngLat, minZoom) {
    map.panTo(toLatLng(lngLat));
    if (minZoom != null && map.getZoom() < minZoom) map.setZoom(minZoom);
  }

  function mapBounds(map) {
    const b = map.getBounds();
    if (!b) return null;
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    return { north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() };
  }

  /**
   * What the rider can actually see, as a circle: `{ near, radiusM }`, or null
   * before the map has settled.
   *
   * THE SEARCH ANCHOR. Every "near" search used to anchor on the day's LAST
   * POINT, which is a place the rider can neither see nor move — so panning the
   * map changed nothing and a search for coffee while looking at Redding
   * answered around a hotel three hundred miles away. The viewport is the one
   * anchor they control.
   *
   * Radius is HALF THE DIAGONAL, so the circle covers the corners rather than
   * only the middle of the screen, clamped to the 500m–50km the Places proxy
   * accepts. A bias is not a filter — Text Search still returns things outside
   * it — so this steers the ranking rather than drawing a boundary.
   */
  function viewportCircle(map) {
    const b = mapBounds(map);
    if (!b) return null;
    const diag = haversineM([b.west, b.south], [b.east, b.north]);
    return {
      near: [(b.west + b.east) / 2, (b.south + b.north) / 2],
      radiusM: Math.max(500, Math.min(50000, Math.round(diag / 2))),
    };
  }

  function haversineM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }

  // Where the map is looking, as [lng, lat], or null before it has settled.
  //
  // Here rather than in builder.js because this file is the only one that names
  // a vendor API. The caller is the category search, which needs somewhere to
  // anchor "coffee" when the rider has typed no place and the day has no points
  // to work from.
  function mapCenter(map) {
    const c = map && map.getCenter && map.getCenter();
    return c ? fromLatLng(c) : null;
  }

  // --- Track + arrow layers -------------------------------------------------

  const TRACK_OPACITY = 0.8;
  const DIM_OPACITY = 0.25;
  // A LOSING ALTERNATE. Between the other two on purpose: a ghost is quieter
  // than the road you are riding and louder than a day you simply are not
  // looking at right now, because it is still a real option rather than
  // something out of focus.
  const GHOST_OPACITY = 0.35;

  // Mapbox has no line symbol, so the engine this replaces drew a triangle to a
  // canvas and registered it as an image (ensureArrowImage). Polyline.icons does
  // it natively, so that whole function is gone.
  function arrowIcons(color, dim) {
    return [
      {
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 2.4,
          strokeColor: color,
          strokeOpacity: dim ? DIM_OPACITY : 1,
          strokeWeight: 1.5,
          fillColor: color,
          fillOpacity: dim ? DIM_OPACITY : 1,
        },
        offset: "0%",
        repeat: "120px",
      },
    ];
  }

  // A ghost gets dashes instead of arrows, and that is the substance of the
  // treatment rather than decoration.
  //
  // Opacity alone cannot say "alternate". It already means "not focused" — see
  // DIM_OPACITY and applyFocus()/paintFocus() — so a third opacity would be a
  // third shade of the same statement, and a rider looking at a faded line has
  // no way to tell "you are not hovering this" from "you decided against this".
  // A dashed line is a different KIND of line, which is the difference being
  // drawn. It is also the long-standing convention for a proposed or optional
  // path on a map, so it needs no legend.
  //
  // Arrows are dropped with it. Direction only matters on a road you are going
  // to ride, and at 120px they compete with the dashes for the same pixels.
  //
  // Polyline.icons with a dash symbol is how Google draws a dashed line: the
  // stroke itself is set transparent by paint() and the dashes ARE the icons.
  function dashIcons(color) {
    return [
      {
        icon: {
          path: "M 0,-1 0,1",
          strokeColor: color,
          strokeOpacity: GHOST_OPACITY,
          strokeWeight: 4,
          scale: 3,
        },
        offset: "0",
        repeat: "16px",
      },
    ];
  }

  // Mapbox addressed layers by string id against the style; a Polyline is a
  // plain object we have to hold onto ourselves. Keyed off the map so two maps
  // on one page could never collide.
  const routeLayers = new WeakMap(); // map -> Map<id, entry>

  function layersOf(map) {
    let m = routeLayers.get(map);
    if (!m) routeLayers.set(map, (m = new Map()));
    return m;
  }

  // GHOST BEATS DIM, in all three properties. A losing alternate that happens
  // to be the focused day is still a losing alternate — the rider clicked into
  // it to edit it, which is exactly when they most need to see that it is the
  // one that does not count. Reading `dim` first would un-ghost it on focus.
  //
  // The dashed stroke is drawn entirely by the icons, so the line's own stroke
  // goes fully transparent: leaving it painted underneath produces a solid line
  // with dashes on top of it, which reads as neither.
  function paint(entry) {
    const ghost = Boolean(entry.ghost);
    entry.line.setOptions({
      strokeColor: entry.color,
      strokeOpacity: ghost ? 0 : entry.dim ? DIM_OPACITY : TRACK_OPACITY,
      // Below both, so an alternate never draws over the road being ridden
      // where the two share tarmac — which, being alternates, they usually do
      // at both ends.
      zIndex: ghost ? 0 : entry.dim ? 1 : 2,
      icons: !entry.visible
        ? []
        : ghost
          ? dashIcons(entry.color)
          : entry.arrowsOn
            ? arrowIcons(entry.color, entry.dim)
            : [],
    });
    entry.line.setVisible(entry.visible);
  }

  // Adds (or replaces) the line + arrows for one route's track.
  //
  // `opts.shapeable` makes the line grabbable for drag-to-shape. It is opt-in
  // per call, and only the builder passes it: the viewer draws through this
  // same function, and a route line that swallows clicks there would break
  // click-through to the map and offer an edit affordance on a page with
  // nothing to edit.
  //
  // It lives on the entry rather than only on the Polyline because
  // addRouteLayers destroys and rebuilds the line — rebuildLayers() runs on
  // every day add, delete, reorder and recolor — so a flag set once at
  // construction would quietly vanish. paint() never touches clickable, so
  // once it is on the entry it survives every repaint.
  function addRouteLayers(map, id, track, color, opts) {
    requireInit("addRouteLayers");
    removeRouteLayers(map, id);
    const shapeable = Boolean(opts && opts.shapeable);
    const entry = {
      line: new Maps.Polyline({
        map,
        path: track.map(toLatLng),
        strokeWeight: 4,
        clickable: shapeable,
      }),
      color,
      visible: true,
      arrowsOn: true,
      dim: false,
      // On the entry rather than the Polyline for the same reason `shapeable`
      // is, and it is worth restating because it has bitten before:
      // rebuildLayers() destroys and recreates every line on every day add,
      // delete, reorder and recolor, so a flag set on the Polyline alone would
      // vanish the next time a rider touched anything. A ghost that silently
      // becomes a solid line is a ride whose mileage and map disagree.
      ghost: false,
      shapeable,
      id,
    };
    paint(entry);
    layersOf(map).set(id, entry);
    // Re-arm: this line is brand new, and rebuildLayers() runs often enough
    // that a gesture wired only at onRouteShapeDrag() time would stop working
    // the first time a day was added.
    const drag = shapeDrags.get(map);
    if (shapeable && drag && drag.arm) drag.arm(entry);
  }

  // The leg highlight is a slice of a route's path, so anything that removes a
  // route, repaths one, or hides one leaves it pointing at something that is no
  // longer there. Dropping it here and letting the caller re-apply is the safe
  // direction: a highlight that briefly disappears is a far smaller lie than
  // one drawn over the wrong stretch of road. Both consumers re-apply on the
  // same pass that triggers these.
  function removeRouteLayers(map, id) {
    const layers = layersOf(map);
    const entry = layers.get(id);
    if (!entry) return;
    entry.line.setMap(null);
    layers.delete(id);
    clearLegHighlight(map);
  }

  function updateRouteTrack(map, id, track) {
    const entry = layersOf(map).get(id);
    if (entry) entry.line.setPath(track.map(toLatLng));
    clearLegHighlight(map);
  }

  function setRouteVisible(map, id, visible, arrowsOn) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.arrowsOn = arrowsOn;
    paint(entry);
    if (!visible) clearLegHighlight(map);
  }

  function setRouteDim(map, id, dim) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.dim = dim;
    paint(entry);
  }

  // Separate from setRouteDim rather than an argument to it, because the two
  // answer different questions and are owned by different code. `dim` is
  // transient — focus, legend hover, the timeline — and both clients rewrite it
  // constantly. `ghost` is a fact about the ride: this day is an alternate that
  // lost. Folding them into one flag means whichever ran last wins, and the
  // symptom is an alternate that turns solid the moment you click it.
  function setRouteGhost(map, id, ghost) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.ghost = ghost;
    paint(entry);
  }

  // --- Leg highlight --------------------------------------------------------

  // One spare Polyline per map, moved onto whichever leg is active and hidden
  // when none is. Deliberately an overlay rather than a Polyline per leg: the
  // layer ids here are route indices, and both consumers plus the export and
  // navigation work depend on that shape. Splitting a route into per-leg lines
  // to draw a highlight would change the contract for every caller of
  // addRouteLayers / updateRouteTrack / setRouteVisible / setRouteDim.
  //
  // Its path is sliced from the route's own Polyline, so there is no second
  // copy of the track to keep in step with updateRouteTrack.
  const legHighlights = new WeakMap(); // map -> Polyline

  function highlightOf(map) {
    let line = legHighlights.get(map);
    if (!line) {
      line = new Maps.Polyline({
        map,
        strokeWeight: 7,
        strokeOpacity: 1,
        zIndex: 3, // above both painted states in paint()
        clickable: false,
        visible: false,
      });
      legHighlights.set(map, line);
    }
    return line;
  }

  // Draws the span [startIndex, endIndex] of route `id`'s track at full
  // strength. Indices come from ride.json's per-leg spans and are clamped
  // rather than trusted: an imported ride's leg count and its track can drift
  // apart, and a bad slice would otherwise throw inside the renderer.
  function setLegHighlight(map, id, startIndex, endIndex) {
    const line = highlightOf(map);
    const entry = layersOf(map).get(id);
    if (!entry || !entry.visible || startIndex == null || endIndex == null) {
      line.setVisible(false);
      return;
    }
    const path = entry.line.getPath().getArray();
    const from = Math.max(0, Math.min(startIndex, path.length - 1));
    const to = Math.max(from, Math.min(endIndex, path.length - 1));
    const slice = path.slice(from, to + 1);
    // A single point is not a line — a degenerate leg highlights nothing rather
    // than drawing a dot the rider cannot interpret.
    if (slice.length < 2) {
      line.setVisible(false);
      return;
    }
    line.setOptions({ strokeColor: entry.color, icons: entry.arrowsOn ? arrowIcons(entry.color, false) : [] });
    line.setPath(slice);
    line.setVisible(true);
  }

  // --- The scrubbed moment --------------------------------------------------

  // WHERE THE RIDER WOULD BE, HOW MUCH FUEL IS LEFT, AND WHERE IT RUNS OUT.
  //
  // Three overlays that move together and are therefore one function: a dot on
  // the road at the scrubbed moment, a ring around it whose radius is the fuel
  // still in the tank, and a marker where that fuel runs out on the road.
  // Splitting them into three setters would let a caller leave one behind — a
  // ring around a dot that has moved on is a claim about nowhere.
  //
  // THE RADIUS IS COMPUTED BY THE CALLER and passed in meters. This file draws;
  // range-circle.js decides. That split is what keeps the arithmetic testable,
  // and it is the same arrangement route-shape.js has with the drag handles.
  //
  // A google.maps.Circle rather than a styled marker, because the radius is in
  // METERS and has to stay in meters: a fixed-pixel ring would grow and shrink
  // with the zoom and mean nothing at any of them. It is also what makes the
  // ring shrink at all — the radius IS the remaining fuel, so the drawing needs
  // no animation and no idea of how fast it should go.

  // A google.maps overlay takes a real color string, not a var() — the API
  // resolves nothing — so the tokens are read out of the compiled stylesheet
  // the same way dashboard.js reads its chart colors. Read lazily rather than
  // at load, because the theme can change under a page that is already open.
  //
  // The ring is the app's own blue: it is a quantity rather than a verdict, and
  // a red or green ring would read as one. The dry marker carries $warning in
  // CSS instead, matching .row-dist-dry.
  const cssVar = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const RING = () => cssVar("--brand", "#1565c0");

  // Small round dots rather than dashes: the ring is the quietest thing on the
  // map and a dashed edge reads as a route, which is what every other dashed
  // line here means — see dashIcons() and the ghosted-day treatment.
  function ringDots(color) {
    return [
      {
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 1.3,
          fillColor: color,
          fillOpacity: 0.85,
          strokeOpacity: 0,
        },
        offset: "0",
        repeat: "5px",
      },
    ];
  }
  // $stop, the palette's stop-sign red. NOT $signal, which is the blue of a go
  // light here — see the note on .tb-moment-target in style/_map.scss.
  const WALL = () => cssVar("--stop", "#cc0000");

  // The unrideable stretch, dashed. A dash already means "not the road you are
  // riding" here — dashIcons() ghosts a losing alternate with one — and that is
  // the right family for a stretch the fuel does not reach. The two do not
  // collide: a ghost is day-colored and faded to GHOST_OPACITY, this is $stop
  // red at full strength.
  //
  // Solid was the first version and read as a route somebody had chosen.
  function dryDashes(color) {
    return [
      {
        icon: {
          path: "M 0,-1 0,1",
          strokeColor: color,
          strokeOpacity: 1,
          strokeWeight: 6,
          scale: 3,
        },
        offset: "0",
        repeat: "18px",
      },
    ];
  }

  const moments = new WeakMap(); // map -> { dot, circle, ringLine, targets, stretch }

  function momentOf(map) {
    let m = moments.get(map);
    if (!m) {
      const dot = document.createElement("div");
      dot.className = "tb-moment-dot";
      m = {
        dot: new Marker.AdvancedMarkerElement({ map, content: dot, zIndex: 6 }),
        // THE FILL ONLY, and a Polygon rather than a Circle. Circle cannot draw
        // a dashed or dotted edge — it has strokeWeight, strokeColor and
        // strokeOpacity and nothing else — so the edge is the polyline below,
        // which carries repeating icons the way a ghosted day does. Once the
        // edge is a path, the fill may as well take the same one: two overlays
        // built from one array cannot disagree about where the ring is.
        //
        // Below the route lines, so a ring drawn over a day never obscures the
        // road it is a statement about.
        circle: new Maps.Polygon({
          map,
          zIndex: 1,
          clickable: false,
          visible: false,
          strokeWeight: 0,
          strokeOpacity: 0,
          fillOpacity: 0.05,
        }),
        // The ring's edge, drawn as dots. Same zIndex as the fill: they are one
        // object and nothing should ever come between them.
        ringLine: new Maps.Polyline({
          map,
          zIndex: 1,
          clickable: false,
          visible: false,
          // The stroke itself is transparent and the DOTS are the icons — the
          // same mechanism dashIcons() uses. See ringDots().
          strokeOpacity: 0,
        }),
        // A POOL, not one marker. There is a wall for every tankful the day
        // needs (#220), so a 700-mile day with no pumps draws six or seven.
        // Grown on demand by wallMarkers() and never shrunk — the spares are
        // detached rather than destroyed, because a rider scrubbing back and
        // forth would otherwise rebuild them on every frame.
        targets: [],
        // THE STRETCH THE RIDER CANNOT MAKE, from the wall to the next pump.
        //
        // 3.5 is deliberate and not a mistake. The leg highlight is 3 and the
        // drag preview is 4, and this has to sit between them: above the
        // highlight, because a rider who scrubs INTO the dry stretch would
        // otherwise have the bright day-colored highlight paint over the one
        // thing on screen telling them they cannot ride it; and below the drag
        // preview, which is the line following their pointer and must never be
        // obscured while they are holding it.
        stretch: new Maps.Polyline({
          map,
          // The stroke itself is transparent and the DASHES are the icons —
          // see dryDashes(), and dashIcons() for the same mechanism on a
          // ghosted day.
          strokeOpacity: 0,
          zIndex: 3.5,
          clickable: false,
          visible: false,
        }),
      };
      m.dot.map = null;
      moments.set(map, m);
    }
    return m;
  }

  // A NO-ENTRY SIGN at the point the tank runs out: a red disc with a white bar
  // across it, which is the actual sign for "you cannot proceed".
  //
  // IT DOES NOT ROTATE, and that is the whole reason it replaced a bar laid
  // perpendicular to the road. The bar's angle was correct and still looked
  // wrong: a route heading broadly north runs genuinely east-west for a mile
  // here and there, so a wall landing on one of those stretches stood vertical
  // against a northbound ride. Smoothing the heading over a wider chord was
  // measured and trades one wrongness for another — on day 2 of ride 32 a
  // five-mile window fixed the wall at mile 291 and broke the ones at 181 and
  // 621, where the bar would then visibly not be square to the road in front of
  // it. A sign is meant to be read upright, so it has no angle to get wrong.
  //
  // The `<i>` is the white bar, a child rather than a border so the two can be
  // sized independently.
  /** The i-th wall marker, created on first use. */
  function wallMarker(m, map, i) {
    if (!m.targets[i]) {
      m.targets[i] = new Marker.AdvancedMarkerElement({ map, content: targetEl(), zIndex: 5 });
    }
    return m.targets[i];
  }

  /** Detach every wall marker from `from` onward. */
  function hideWalls(m, from) {
    for (let i = from; i < m.targets.length; i++) m.targets[i].map = null;
  }

  function targetEl() {
    const el = document.createElement("div");
    el.className = "tb-moment-target";
    el.appendChild(document.createElement("i"));
    return el;
  }

  /**
   * Draw the moment, or clear it with a null `at`.
   *
   * `at` is [lng, lat]; `dryWalls` is one [lng, lat] per point the tank runs
   * out, in order; `ringPath` is the fuel ring's own closed path;
   * `dryPath` is the stretch from the first wall to the next pump. All of it is
   * computed by the caller — this file draws and decides nothing, which is why
   * the ring arrives as a path rather than as a radius.
   *
   * THREE THINGS THAT MOVE TOGETHER, which is why they are one function rather
   * than three setters: a ring left behind around a dot that has moved on is a
   * claim about nowhere.
   *
   * A NULL RADIUS STILL DRAWS THE DOT. Where the rider would be does not depend
   * on whether anything is known about their tank, and a bike with no range on
   * file is the common case rather than the edge one. A radius of ZERO also
   * draws no ring, and it is a different fact — the tank is empty rather than
   * unmeasured — which is why range-circle.js keeps the two apart.
   */
  function setMomentOverlay(map, at, dryWalls, ringPath, dryPath) {
    const m = momentOf(map);
    if (!at) {
      m.dot.map = null;
      hideWalls(m, 0);
      m.circle.setVisible(false);
      m.ringLine.setVisible(false);
      m.stretch.setVisible(false);
      return;
    }
    m.dot.position = toLatLng(at);
    m.dot.map = map;

    if (ringPath && ringPath.length > 2) {
      const path = ringPath.map(toLatLng);
      m.circle.setOptions({ fillColor: RING() });
      m.circle.setPath(path);
      m.circle.setVisible(true);
      m.ringLine.setOptions({ icons: ringDots(RING()) });
      m.ringLine.setPath(path);
      m.ringLine.setVisible(true);
    } else {
      m.circle.setVisible(false);
      m.ringLine.setVisible(false);
    }

    // Independent of the ring, and drawn whenever the day holds one. The ring
    // is how much fuel is left as the crow flies; this is where that runs out
    // on the road the rider is actually on, and the gap between them is the
    // cost of the bends.
    // ONE SIGN PER WALL, and no angle to compute — see targetEl().
    const walls = dryWalls || [];
    walls.forEach((w, i) => {
      const marker = wallMarker(m, map, i);
      marker.position = toLatLng(w);
      marker.map = map;
    });
    hideWalls(m, walls.length);

    // Drawn on the same condition as the wall and in the same red, because they
    // are one statement: the bar is where the fuel runs out and this is what it
    // runs out ACROSS.
    if (dryPath && dryPath.length > 1) {
      m.stretch.setOptions({ icons: dryDashes(WALL()) });
      m.stretch.setPath(dryPath.map(toLatLng));
      m.stretch.setVisible(true);
    } else {
      m.stretch.setVisible(false);
    }
  }

  // --- Drag to shape --------------------------------------------------------

  // Pulling the route line onto the road the rider actually meant.
  //
  // Google's own `editable: true` is the obvious answer and the wrong one: a
  // routed leg is thousands of shape points, so it would hand back thousands of
  // drag handles, and dragging one edits geometry that the next re-route throws
  // away. What a rider wants is to grab the line anywhere and leave ONE shaping
  // point behind. So the gesture is built by hand.
  //
  // The drag is tracked on the map rather than the polyline because the pointer
  // leaves the line the instant it moves — that is the whole point of the
  // gesture.
  const shapeDrags = new WeakMap(); // map -> { preview, handler, active }

  function previewOf(map, state) {
    if (!state.preview) {
      state.preview = new Maps.Polyline({
        map,
        strokeWeight: 4,
        strokeOpacity: 0.9,
        zIndex: 4, // above the leg highlight, which may be showing at the time
        clickable: false,
        visible: false,
        // Deliberately not the route color: this is a proposal, not the route.
        strokeColor: "#222222",
      });
    }
    return state.preview;
  }

  // handler({ id, vertexIndex, edgeForward, lngLat }) fires once, on drop.
  //
  // `edgeForward` says the rider grabbed the segment leaving the nearest vertex
  // rather than the one arriving at it. Consecutive legs share their joint
  // vertex, so on a joint that flag is the only thing that says which leg was
  // meant.
  function onRouteShapeDrag(map, handler) {
    requireInit("onRouteShapeDrag");
    const state = shapeDrags.get(map) || {};
    state.handler = handler;
    shapeDrags.set(map, state);
    if (state.wired) return;
    state.wired = true;

    const finish = (commit, lngLat) => {
      const a = state.active;
      state.active = null;
      if (!a) return;
      if (state.preview) state.preview.setVisible(false);
      map.setOptions({ draggable: true });
      if (moveL) Core.event.removeListener(moveL);
      if (upL) Core.event.removeListener(upL);
      moveL = upL = null;
      if (commit && state.handler) {
        state.handler({ id: a.id, vertexIndex: a.vertexIndex, edgeForward: a.edgeForward, lngLat });
      }
      // The click that follows a mouseup would otherwise reach onMapClick and
      // drop a stop where the rider was only bending the line.
      if (commit) state.swallowClick = true;
    };

    let moveL = null;
    let upL = null;

    // Polylines are destroyed and rebuilt on every rebuildLayers(), so arming
    // is a function the creation path calls rather than a one-time pass.
    state.arm = (entry) => {
      entry.line.addListener("mousedown", (e) => {
        if (!entry.shapeable || !entry.visible) return;
        const path = entry.line.getPath().getArray();
        if (path.length < 2) return;
        const here = fromLatLng(e.latLng);
        let best = 0;
        let bestD = Infinity;
        const k = Math.cos((here[1] * Math.PI) / 180);
        for (let i = 0; i < path.length; i++) {
          const p = fromLatLng(path[i]);
          const dx = (p[0] - here[0]) * k;
          const dy = p[1] - here[1];
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        // Which side of the nearest vertex did the grab land on? Compare
        // against the neighbors: closer to the next vertex means the rider
        // took the segment leaving `best`.
        let edgeForward = true;
        if (best > 0 && best < path.length - 1) {
          const prev = fromLatLng(path[best - 1]);
          const next = fromLatLng(path[best + 1]);
          const dp = Math.hypot((prev[0] - here[0]) * k, prev[1] - here[1]);
          const dn = Math.hypot((next[0] - here[0]) * k, next[1] - here[1]);
          edgeForward = dn <= dp;
        } else if (best === path.length - 1) {
          edgeForward = false;
        }

        state.active = { id: entry.id, vertexIndex: best, edgeForward, from: path[best] };
        // Or the map pans out from under the gesture.
        map.setOptions({ draggable: false });

        const preview = previewOf(map, state);
        preview.setPath([path[best], e.latLng]);
        preview.setVisible(true);

        moveL = map.addListener("mousemove", (ev) => {
          if (!state.active) return;
          preview.setPath([state.active.from, ev.latLng]);
        });
        upL = map.addListener("mouseup", (ev) => finish(true, fromLatLng(ev.latLng)));
      });
    };

    // Arm what is already drawn; addRouteLayers arms everything drawn later.
    for (const entry of layersOf(map).values()) if (entry.shapeable) state.arm(entry);
  }

  // True once per drop, so the caller can ignore the click that follows.
  function consumeShapeClick(map) {
    const state = shapeDrags.get(map);
    if (!state || !state.swallowClick) return false;
    state.swallowClick = false;
    return true;
  }

  function clearLegHighlight(map) {
    const line = legHighlights.get(map);
    if (line) line.setVisible(false);
  }

  // --- Markers --------------------------------------------------------------

  // The Mapbox engine left marker construction to the callers, so viewer.js and
  // builder.js both reached for `new mapboxgl.Marker` directly and both had to
  // change when the engine did. They go through these four functions now.

  function addMarker(map, lngLat, element, opts) {
    requireInit("addMarker");
    const o = opts || {};
    return new Marker.AdvancedMarkerElement({
      map,
      position: toLatLng(lngLat),
      content: element,
      gmpDraggable: !!o.draggable,
      title: o.title || "",
    });
  }

  function removeMarker(marker) {
    marker.map = null;
  }

  function onMarkerDragEnd(marker, fn) {
    marker.addListener("dragend", () => fn(fromLatLng(marker.position)));
  }

  // --- Place search ---------------------------------------------------------

  // Replaces Mapbox Geocoding v6 forward search. The move was not optional once
  // the map became Google: each provider's terms tie their search results to
  // their own basemap, so a Mapbox geocode rendered on a Google map breaks the
  // one and Google Places on a Mapbox map breaks the other.
  let Places = null;

  // Autocomplete keystrokes and the details lookup that resolves the pick are
  // billed as one session when they share a token. The token is retired after
  // each resolved pick — reusing it would merge unrelated searches.
  let sessionToken = null;

  async function placesLib() {
    if (!Places) Places = await google.maps.importLibrary("places");
    return Places;
  }

  /**
   * RESTRICTED TO WHAT IS ON SCREEN. Ziad's call, 2026-08-31.
   *
   * It was a bias until then, on the recorded reasoning that "a rider planning
   * from home still wants to find the far end of the ride" — which is true and
   * is not what a bias delivers. A bias only reorders: the list still fills
   * with a Shell in Ohio while the rider is looking at Oregon, and by a long
   * way the common act is adding a point to the stretch of road on screen.
   *
   * A FALLBACK TO THE BIASED SEARCH WAS TRIED AND REMOVED THE SAME HOUR, and it
   * is recorded because it reads as obviously kind and is not. Retrying
   * unrestricted whenever the viewport had nothing turned "no matches here"
   * into a list from three states away: zoomed into the Bay Area, "shell"
   * returned Shelley ID, Shell Lake WI and Shell Knob MO. It served a specific
   * name like "Dunsmuir Lodge" well and a generic word terribly, and telling
   * those apart needs a guess about what the rider meant.
   *
   * So the rule is plain and the empty case SAYS SO rather than being papered
   * over — the caller names the viewport in its no-matches line, which makes
   * zooming out the obvious next move. That is how the far end of the ride
   * stays reachable: one gesture, and the rider is the one who chose it.
   */
  async function searchPlaces(map, input) {
    const { AutocompleteSuggestion, AutocompleteSessionToken } = await placesLib();
    if (!sessionToken) sessionToken = new AutocompleteSessionToken();

    const request = { input, sessionToken };
    // Null before the map has settled, and an unrestricted search is the right
    // behavior then: there is no viewport yet to be outside of.
    const bounds = mapBounds(map);
    if (bounds) request.locationRestriction = bounds;

    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
    return suggestions
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((prediction) => ({
        name: prediction.mainText ? prediction.mainText.toString() : prediction.text.toString(),
        context: prediction.secondaryText ? prediction.secondaryText.toString() : "",
        // Deferred so coordinates are only fetched for the one result actually
        // chosen — Place Details is billed per call, autocomplete is not.
        resolve: async () => {
          const place = prediction.toPlace();
          await place.fetchFields({ fields: ["displayName", "location"] });
          sessionToken = null;
          if (!place.location) return null;
          return { lngLat: fromLatLng(place.location), name: place.displayName || "" };
        },
      }));
  }

  // --- Role icons + marker DOM ----------------------------------------------

  const svgCache = {}; // icon file -> Promise<svg text>
  function iconSvg(iconFile) {
    if (!svgCache[iconFile]) {
      svgCache[iconFile] = fetch("/img/icons/" + iconFile)
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
    }
    return svgCache[iconFile];
  }

  // Legacy grid offsets (px) for 1–4 stacked role icons.
  const GRID_OFFSETS = [
    [[0, 0]],
    [
      [-13, 0],
      [13, 0],
    ],
    [
      [-13, 13],
      [13, 13],
      [0, -13],
    ],
    [
      [-13, -13],
      [13, -13],
      [-13, 13],
      [13, 13],
    ],
  ];

  // Builds the marker DOM element for a point. Role icons are inlined SVGs
  // tinted through CSS currentColor — no data-URI recoloring, which is what the
  // legacy viewer did and why it needed a two-entry cache per color. Role-less
  // points render as the legacy white circle with a colored stroke.
  //
  // .tb-marker is a zero-size positioning context (see _map.scss), so an
  // AdvancedMarkerElement's bottom-center anchor lands exactly on the point and
  // the offsets below stay measured from the center.
  function markerElement(point, color, kind) {
    const el = document.createElement("div");
    el.className = "tb-marker tb-marker-" + (kind || "stop");
    el.style.color = color;
    const roles = point.roles || [];
    if (roles.length === 0) {
      const dot = document.createElement("div");
      dot.className = "tb-marker-dot";
      const label = (point.name || "").trim();
      if (/^\d{1,3}$/.test(label)) {
        dot.textContent = label;
        dot.classList.add("tb-marker-dot-num");
      }
      el.appendChild(dot);
      return el;
    }
    const offsets = GRID_OFFSETS[Math.min(roles.length, 4) - 1];
    roles.slice(0, 4).forEach((role, idx) => {
      const meta = window.TB.roles[role];
      if (!meta) return;
      const wrap = document.createElement("div");
      wrap.className = "tb-marker-icon";
      wrap.style.transform = "translate(" + offsets[idx][0] + "px," + offsets[idx][1] + "px)";
      iconSvg(meta.icon).then((svg) => {
        if (svg) wrap.innerHTML = svg;
      });
      el.appendChild(wrap);
    });
    return el;
  }

  // --- Waypoint tooltip (ported markup — same classes as main.scss) ---------

  function roleTitle(roles) {
    if (!roles || roles.length === 0) return "Waypoint";
    return roles.map((r) => (window.TB.roles[r] ? window.TB.roles[r].title : r)).join(" / ");
  }

  function iconImgHtml(roles, color) {
    const first = roles && roles[0] && window.TB.roles[roles[0]];
    if (!first) return "";
    return (
      '<span class="waypoint-tooltip-icon tb-inline-icon" style="color:' +
      esc(color) +
      '" data-icon="' +
      esc(first.icon) +
      '"></span>'
    );
  }

  function numRow(label, value) {
    return (
      "<div class='waypoint-tooltip-num'><span class='waypoint-tooltip-label'>" +
      label +
      ":</span> <span class='waypoint-tooltip-value'>" +
      value +
      "</span></div>"
    );
  }

  // mileage: { fromStartMi, fromGasMi, fromChargeMi (null to hide), durationMin }
  function popupHtml(point, color, mileage) {
    const m = mileage || {};
    const fmt = (v) => (v == null ? "-" : v.toFixed(1) + " mi");
    let rows = "";
    if (m.fromStartMi !== undefined) rows += numRow("From Start", fmt(m.fromStartMi));
    if (m.fromGasMi !== undefined) rows += numRow("From Gas", fmt(m.fromGasMi));
    if (m.fromChargeMi !== undefined && m.showCharge) rows += numRow("From Charge", fmt(m.fromChargeMi));
    if (point.durationMin != null) rows += numRow("Stop", point.durationMin + " min");
    return (
      "<div class='waypoint-tooltip-toprow'>" +
      "<div class='waypoint-tooltip-title' style='color:" +
      esc(color) +
      ";display:flex;align-items:center;gap:6px'>" +
      iconImgHtml(point.roles, color) +
      "<span>" +
      esc(roleTitle(point.roles)) +
      "</span></div>" +
      rows +
      "</div>" +
      "<div class='waypoint-tooltip-name'>" +
      esc(point.name || "") +
      "</div>" +
      (point.description ? "<div class='waypoint-tooltip-desc'>" + esc(point.description) + "</div>" : "") +
      detailsBlock(point.details)
    );
  }

  // The private half of a stop, in the popup.
  //
  // `point.details` is present ONLY when the server decided the viewer is the
  // ride's owner — ride.json omits the key entirely for everyone else, so there
  // is no client-side permission check here and there must not be one. A viewer
  // that had the data and chose not to draw it would still have shipped it.
  //
  // Every value goes through esc(), links included, and the URL was already
  // constrained to http(s) at save time by fields.external_url — an href is the
  // one place esc() alone is not enough.
  function detailsBlock(d) {
    if (!d) return "";
    let rows = "";
    if (d.confirmation) rows += numRow("Confirmation", esc(d.confirmation));
    if (d.checkInAt) rows += numRow("Check in", esc(fmtStamp(d.checkInAt)));
    if (d.checkOutAt) rows += numRow("Check out", esc(fmtStamp(d.checkOutAt)));
    if (d.phone) rows += numRow("Phone", "<a href='tel:" + esc(d.phone) + "'>" + esc(d.phone) + "</a>");
    if (d.address) rows += numRow("Address", esc(d.address));
    const links = (d.links || [])
      .filter((l) => l.url)
      .map(
        (l) =>
          "<a class='waypoint-tooltip-link' href='" +
          esc(l.url) +
          "' target='_blank' rel='noopener'>" +
          esc(l.label || l.url) +
          "</a>",
      )
      .join("");
    if (!rows && !links && !d.notes) return "";
    return (
      "<div class='waypoint-tooltip-private'>" +
      "<div class='waypoint-tooltip-private-head'>Only you can see this</div>" +
      rows +
      (d.notes ? "<div class='waypoint-tooltip-desc'>" + esc(d.notes) + "</div>" : "") +
      (links ? "<div class='waypoint-tooltip-links'>" + links + "</div>" : "") +
      "</div>"
    );
  }

  // The stored value is the wall clock where the stop is, carried as UTC — see
  // the header of public/js/day-clock.js. So UTC is what reads it back, and the
  // rider sees the digits they typed wherever they are standing.
  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
  }

  // Inline the tooltip's icon (same currentColor trick as the markers).
  function hydratePopupIcons(popupEl) {
    popupEl.querySelectorAll(".tb-inline-icon[data-icon]").forEach((span) => {
      iconSvg(span.getAttribute("data-icon")).then((svg) => {
        if (svg) span.innerHTML = svg;
      });
    });
  }

  // Attaches hover-open / click-pin popup behavior (legacy wasClicked port).
  //
  // The listeners go on the marker's own DOM content rather than through
  // gmp-click, because the content is a real element in the overlay and the
  // hover half of this behavior has no marker-level equivalent.
  function attachPopup(map, marker, html) {
    requireInit("attachPopup");

    // A DOM element rather than an HTML string: the icons can then be inlined
    // before the window ever opens, instead of racing the domready event.
    const content = document.createElement("div");
    content.className = "waypoint-tooltip";
    content.innerHTML = html;
    hydratePopupIcons(content);

    const popup = new Maps.InfoWindow({
      content,
      disableAutoPan: true,
      // Suppresses the close button and header. _map.scss also hides
      // .gm-ui-hover-effect, which is what covered this before the option
      // existed; between them the tooltip stays chrome-free either way.
      headerDisabled: true,
    });

    let open = false;
    let pinned = false;
    const el = marker.content;

    function show() {
      if (open) return;
      popup.open({ map, anchor: marker });
      open = true;
    }
    function hide() {
      if (!open) return;
      popup.close();
      open = false;
    }

    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", () => {
      if (!pinned) hide();
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned) show();
      else hide();
    });
    Core.event.addListener(popup, "closeclick", () => {
      pinned = false;
      open = false;
    });
    return popup;
  }

  // --- Mileage columns (ported gas/charge semantics) ------------------------

  // First stop counts as gas but never charge; the charge column shows only
  // when a later stop actually has the charge role.
  function stopMileages(stops) {
    const hasCharge = stops.some((s, i) => i > 0 && (s.roles || []).includes("charge"));
    let lastGas = 0;
    let lastCharge = null;
    return stops.map((s, i) => {
      const d = s.distFromStartMi;
      const out = {
        fromStartMi: d,
        fromGasMi: d == null || lastGas == null ? null : d - lastGas,
        fromChargeMi: d == null || lastCharge == null ? null : d - lastCharge,
        showCharge: hasCharge,
      };
      if (d != null) {
        if (i === 0 || (s.roles || []).includes("gas")) lastGas = d;
        if (i > 0 && (s.roles || []).includes("charge")) lastCharge = d;
      }
      return out;
    });
  }

  // --- Panel collapse (ported from the legacy DOMContentLoaded block) -------

  // `getMap` is an optional accessor, not a map, and it is a function on
  // purpose: both pages bind this toggle at load and create their map inside an
  // await several hundred milliseconds later. Taking the map itself here would
  // capture null forever. A caller that passes nothing still gets a working
  // toggle, just without the re-center.
  function initPanelToggle(getMap) {
    const panel = document.getElementById("info-panel");
    const toggle = panel && panel.querySelector(".collapse-toggle");
    if (!panel || !toggle) return;
    const rail = panel.querySelector(".drawer-rail");
    toggle.addEventListener("click", () => {
      const map = typeof getMap === "function" ? getMap() : null;
      // THE CENTER IS CAPTURED BEFORE THE WIDTH CHANGES. #map is sized to the
      // space beside the drawer now rather than to the whole viewport, so
      // collapsing hands it 324 more pixels — and Google keeps the map's
      // top-left fixed through a resize, which slides the route sideways by
      // half that. Reinstating the center afterwards keeps whatever the rider
      // was looking at in the middle of what they can see.
      const center = map && map.getCenter && map.getCenter();

      panel.classList.toggle("collapsed");
      const collapsed = panel.classList.contains("collapsed");
      // The button carries aria-expanded, so it has to be kept true. The markup
      // ships it as "true" and this is the only thing that flips it — a stale
      // attribute is worse than none, because it states the opposite of what a
      // screen reader user is looking at.
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
      // The rail's controls duplicate the day scrubber, so they are hidden from
      // assistive tech while the scrubber itself is on screen and exposed only
      // once it is not. The markup ships aria-hidden="true" to match the
      // expanded state it also ships in.
      if (rail) rail.setAttribute("aria-hidden", String(!collapsed));
      // No src to swap any more: .collapse-icon is a masked span and the mask
      // is selected by the aria-expanded set two lines up. That attribute was
      // always the real state — driving the artwork from it as well removes the
      // second thing to keep in step, and there is nothing to do here.

      if (!center) return;
      // Re-centered on transitionend rather than immediately: the width animates
      // over 0.28s and a setCenter against the old width is undone by the very
      // next frame. The timeout is the fallback for a browser that never fires
      // the event — prefers-reduced-motion kills the transition entirely, and
      // transitionend does not fire for a transition that did not run.
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        map.setCenter(center);
      };
      panel.addEventListener("transitionend", settle, { once: true });
      setTimeout(settle, 350);
    });
  }

  window.TBMap = {
    esc,
    initMap,
    fitTo,
    onMapClick,
    panTo,
    addRouteLayers,
    removeRouteLayers,
    updateRouteTrack,
    setRouteVisible,
    setRouteDim,
    setRouteGhost,
    setLegHighlight,
    clearLegHighlight,
    onRouteShapeDrag,
    consumeShapeClick,
    addMarker,
    removeMarker,
    onMarkerDragEnd,
    searchPlaces,
    mapCenter,
    viewportCircle,
    markerElement,
    popupHtml,
    attachPopup,
    stopMileages,
    setMomentOverlay,
    iconSvg,
    initPanelToggle,
  };
})();
