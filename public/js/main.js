// HTML-escape helper for user-derived strings injected via innerHTML (stored-XSS defense).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

window.mapInitialized = window.mapInitialized || false;

window.showDirectionArrows = true;
window.initMap = async function () {
  // Guard against multiple initializations
  if (window.mapInitialized) {
    return;
  }
  window.mapInitialized = true;
  // Inject CSS to hide the close (X) button on Google Maps InfoWindows
  const style = document.createElement("style");
  style.innerHTML = ".gm-ui-hover-effect { display: none !important; }";
  document.head.appendChild(style);

  const mapDiv = document.getElementById("map");
  const center = { lat: 37.665817, lng: -121.949321 };
  const map = new google.maps.Map(mapDiv, {
    center,
    zoom: 10,
    mapTypeId: "terrain",
    mapId: "a14091e53ca43382",
  });

  // Declare variables before any references to them
  let routes = [];
  // 12 visually distinct, contrasting colors spaced around the color wheel
  // Dark, high-contrast, visually distinct route colors
  const colors = [
    "#0000cc", // Blue
    "#cc0000", // Red
    "#8800DD", // Violet
    "#FF6F00", // Orange
    "#DD00DD", // Magenta
    "#006064", // Teal
    "#4A148C", // Purple
    "#4E342E", // Brown
    "#00aaaa", // Cyan
    "#0D1335", // Dark Blue
    "#A0740B", // Mustard
    "#003300", // Dark Green
    "#550000", // Burgundy
  ];
  window.routePolylines = [];

  // --- FETCH ROUTES FIRST ---
  try {
    const resp = await fetch(window.MOTO.metadataUrl);
    if (!resp.ok) {
      throw new Error("[initMap] Failed to fetch routes.json: " + resp.statusText);
    }
    routes = await resp.json();
    if (!Array.isArray(routes)) {
      console.error("[initMap] routes is not an array:", routes);
    } else if (routes.length === 0) {
    }

    // Process the routes after successful fetch
    try {
      await loadAllKmlRoutes(routes);
    } catch (e) {
      console.error("[initMap] loadAllKmlRoutes ERROR", e);
    }
    try {
      await addRouteDownloadButtons(routes);
    } catch (e) {
      console.error("[initMap] addRouteDownloadButtons ERROR", e);
    }
  } catch (err) {
    console.error("[initMap] Error fetching or parsing routes.json:", err);
    return;
  }

  // Define all helper functions first

  // --- Define loadAllKmlRoutes function ---
  async function loadAllKmlRoutes(routes) {
    if (!routes || !Array.isArray(routes)) {
      console.error("[loadAllKmlRoutes] No valid routes array provided");
      return;
    }

    const promises = [];
    let allPoints = [];

    routes.forEach((route, i) => {
      if (!route.kmlUrl) {
        return;
      }

      const color = route.color || colors[i % colors.length];
      const kmlUrl = route.kmlUrl;

      promises.push(
        fetch(kmlUrl)
          .then((res) => {
            if (!res.ok) {
              console.error(`[loadAllKmlRoutes] Failed to fetch KML file (${kmlUrl}):`, res.statusText);
              throw new Error(`KML fetch error ${res.status}`);
            }
            return res.text();
          })
          .then((kmlText) => {
            const xmlIdx = kmlText.indexOf("<?xml");
            const cleanText = xmlIdx >= 0 ? kmlText.slice(xmlIdx) : kmlText;
            const parser = new DOMParser();
            const kmlDoc = parser.parseFromString(cleanText, "application/xml");
            const ns = kmlDoc.documentElement.namespaceURI;
            let coordsEls = kmlDoc.getElementsByTagNameNS(ns, "coordinates");
            if (!coordsEls || coordsEls.length === 0) coordsEls = kmlDoc.getElementsByTagNameNS("*", "coordinates");
            if (!coordsEls || coordsEls.length === 0) coordsEls = kmlDoc.getElementsByTagName("coordinates");
            if (!coordsEls || coordsEls.length === 0) {
              console.error(`[${kmlUrl}] No <coordinates> elements found in KML`, kmlDoc);
              return;
            }
            let maxCount = 0;
            let coordEl = coordsEls[0];
            Array.from(coordsEls).forEach((el, idx) => {
              const count = el.textContent.trim().split(/\s+/).length;
              if (count > maxCount) {
                maxCount = count;
                coordEl = el;
              }
            });
            const coordText = coordEl.textContent.trim();
            const path = coordText
              .split(/\s+/)
              .map((pair) => {
                const [lng, lat] = pair.split(",").map(Number);
                return { lat, lng };
              })
              .filter((pt) => !isNaN(pt.lat) && !isNaN(pt.lng));
            allPoints = allPoints.concat(path);
            return loadKmlRoute(kmlUrl, color, false, i, kmlText);
          })
      );
    });

    await Promise.all(promises);
    // Fit map to all collected points
    if (allPoints.length) {
      const bounds = new google.maps.LatLngBounds();
      allPoints.forEach((pt) => bounds.extend(pt));
      map.fitBounds(bounds);
    }
  }

  // --- Define loadKmlRoute function ---
  function loadKmlRoute(kmlUrl, polylineColor, fitBounds = false, routeIndex, preKml) {
    // Flag to track if any charging point exists in this route (not counting the starting point)
    let hasChargingPoint = false;
    if (!kmlUrl) {
      console.error("[loadKmlRoute] No kmlUrl provided!", kmlUrl);
      return;
    }
    return new Promise((resolve, reject) => {
      // Keep track of current route index
      const currentRouteIndex = routeIndex;

      Promise.resolve(preKml || null)
        .then((pre) => {
          if (pre) return pre;
          return fetch(kmlUrl).then((res) => {
            if (!res.ok) {
              console.error(`[loadKmlRoute] Failed to fetch KML file (${kmlUrl}):`, res.statusText);
              throw new Error(`KML fetch error ${res.status}`);
            }
            return res.text();
          });
        })
        .then((kmlText) => {
          const xmlIdx = kmlText.indexOf("<?xml");
          const cleanText = xmlIdx >= 0 ? kmlText.slice(xmlIdx) : kmlText;
          const parser = new DOMParser();
          const kmlDoc = parser.parseFromString(cleanText, "application/xml");
          const ns = kmlDoc.documentElement.namespaceURI;
          let coordsEls = kmlDoc.getElementsByTagNameNS(ns, "coordinates");
          if (!coordsEls || coordsEls.length === 0) coordsEls = kmlDoc.getElementsByTagNameNS("*", "coordinates");
          if (!coordsEls || coordsEls.length === 0) coordsEls = kmlDoc.getElementsByTagName("coordinates");
          if (!coordsEls || coordsEls.length === 0) {
            console.error(`[${kmlUrl}] No <coordinates> elements found in KML`, kmlDoc);
            return;
          }
          let maxCount = 0;
          let coordEl = coordsEls[0];
          Array.from(coordsEls).forEach((el, idx) => {
            const count = el.textContent.trim().split(/\s+/).length;
            if (count > maxCount) {
              maxCount = count;
              coordEl = el;
            }
          });
          const coordText = coordEl.textContent.trim();
          const path = coordText
            .split(/\s+/)
            .map((pair) => {
              const [lng, lat] = pair.split(",").map(Number);
              return { lat, lng };
            })
            .filter((pt) => !isNaN(pt.lat) && !isNaN(pt.lng));
          if (!path.length) {
            console.error(`[${kmlUrl}] No valid path points parsed!`, coordText);
            reject(new Error("No valid path points"));
            return;
          }
          // Draw polyline for this route
          const routePolyline = new google.maps.Polyline({
            path,
            strokeColor: polylineColor,
            strokeOpacity: 0.8,
            strokeWeight: 2,
            map,
            zIndex: 2,
            icons:
              window.showDirectionArrows !== false
                ? [
                    {
                      icon: {
                        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
                        scale: 1.5, // Adjust size if needed
                        strokeColor: polylineColor,
                        strokeWeight: 2,
                      },
                      offset: "0%",
                      repeat: "50px", // Arrow every 50px along the line
                    },
                  ]
                : [],
          });
          // --- Calculate total mileage for this route ---
          let totalMeters = 0;
          for (let i = 1; i < path.length; i++) {
            const prev = path[i - 1];
            const curr = path[i];
            totalMeters += google.maps.geometry.spherical.computeDistanceBetween(
              new google.maps.LatLng(prev.lat, prev.lng),
              new google.maps.LatLng(curr.lat, curr.lng)
            );
          }
          const totalMiles = totalMeters / 1609.344;
          routePolyline.__mileageMiles = totalMiles;
          // Store polylines and markers in global arrays for table interaction
          if (!window.routePolylines) window.routePolylines = [];
          if (!window.routeMarkers) window.routeMarkers = [];
          if (!window.routeMarkers[currentRouteIndex]) window.routeMarkers[currentRouteIndex] = [];
          window.routePolylines[currentRouteIndex] = routePolyline;
          resolve(totalMiles);
          // window.routeMarkers[currentRouteIndex] is initialized above if needed
          if (fitBounds) {
            const bounds = new google.maps.LatLngBounds();
            path.forEach((point) => bounds.extend(point));
            map.fitBounds(bounds);
          }
          // Add KML waypoints as markers
          const placemarks = kmlDoc.getElementsByTagNameNS(ns, "Placemark");
          const allPMs = Array.from(placemarks);
          const pointPMs = allPMs.filter((pm) => pm.getElementsByTagNameNS(ns, "Point").length > 0);
          // Precompute cumulative miles for each waypoint
          let waypointCumulativeMiles = [];
          let waypointMilesSinceLastGas = [];
          let lastGasIdx = 0;
          let lastGasMiles = 0;
          let waypointMilesSinceLastCharge = [];
          let lastChargeIdx = 0;
          let lastChargeMiles = 0;
          let cumulativeMeters = 0;
          for (let i = 0; i < pointPMs.length; i++) {
            // Find the index of this waypoint in the path array
            const pointEl = pointPMs[i].getElementsByTagNameNS(ns, "Point")[0];
            if (!pointEl) {
              waypointCumulativeMiles.push(null);
              waypointMilesSinceLastGas.push(null);
              waypointMilesSinceLastCharge.push(null);
              continue;
            }
            const coordsEl = pointEl.getElementsByTagNameNS(ns, "coordinates")[0];
            if (!coordsEl) {
              waypointCumulativeMiles.push(null);
              waypointMilesSinceLastGas.push(null);
              waypointMilesSinceLastCharge.push(null);
              continue;
            }
            const [lng, lat] = coordsEl.textContent.trim().split(",").map(Number);
            // Find the closest point in the path
            let minIdx = 0,
              minDist = Infinity;
            for (let j = 0; j < path.length; j++) {
              const d = Math.abs(path[j].lat - lat) + Math.abs(path[j].lng - lng);
              if (d < minDist) {
                minDist = d;
                minIdx = j;
              }
            }
            // Sum meters up to this point
            let meters = 0;
            for (let j = 1; j <= minIdx; j++) {
              meters += google.maps.geometry.spherical.computeDistanceBetween(
                new google.maps.LatLng(path[j - 1].lat, path[j - 1].lng),
                new google.maps.LatLng(path[j].lat, path[j].lng)
              );
            }
            const miles = meters / 1609.344;
            waypointCumulativeMiles.push(miles);
            // Detect if this is a GAS stop (or treat first as GAS)
            let nameEl = pointPMs[i].getElementsByTagNameNS(ns, "name")[0];
            let name = nameEl ? nameEl.textContent : "";
            let isGas = false;
            let isCharge = false;
            if (i === 0) {
              isGas = true;
              // Don't automatically mark first point as charging
              // isCharge = true;
            } else {
              // Check for prefix format: "GAS - Station Name"
              const prefixMatch = name.match(
                /^(MEET|SPLIT|CAMP|GAS|CHARGE|FOOD|HOTEL|DRINKS|COFFEE|POI|VIEW|GROCERY|START|FINISH|HOME|BREAK|WTF)\s+-\s+(.*)$/i
              );
              if (prefixMatch && prefixMatch[1].toUpperCase() === "GAS") {
                isGas = true;
              } else {
                // Check for slash-delimited format: "GAS/BREAK/CHARGE - Station Name"
                const slashMatch = name.match(/^([^-]+)\s+-\s+(.*)$/i);
                if (slashMatch) {
                  const types = slashMatch[1].split("/").map((s) => s.trim().toUpperCase());
                  if (types.includes("GAS") || types.includes("FUEL")) {
                    isGas = true;
                  }
                  if (types.includes("CHARGE")) {
                    isCharge = true;
                  }
                }
              }
            }
            if (isGas) {
              lastGasIdx = i;
              lastGasMiles = miles;
              waypointMilesSinceLastGas.push(0);
            } else {
              waypointMilesSinceLastGas.push(miles - lastGasMiles);
            }
            if (isCharge) {
              lastChargeIdx = i;
              lastChargeMiles = miles;
              waypointMilesSinceLastCharge.push(0);
              // Set flag when a charging point is found (not the starting point)
              if (i > 0) {
                hasChargingPoint = true;
              }
            } else {
              waypointMilesSinceLastCharge.push(miles - lastChargeMiles);
            }
          }

          pointPMs.forEach((pm, i) => {
            const pointEl = pm.getElementsByTagNameNS(ns, "Point")[0];
            if (!pointEl) return;
            const coordsEl = pointEl.getElementsByTagNameNS(ns, "coordinates")[0];
            if (!coordsEl) return;
            const [lng, lat] = coordsEl.textContent.trim().split(",").map(Number);
            const nameEl = pm.getElementsByTagNameNS(ns, "name")[0];
            const name = nameEl ? nameEl.textContent : "";
            const descEl = pm.getElementsByTagNameNS(ns, "description")[0];
            const desc = descEl ? descEl.textContent : "";
            // --- Custom SVG marker logic ---
            const roleIconMap = {
              MEET: "/img/icons/icon-meet.svg",
              SPLIT: "/img/icons/icon-split.svg",
              CAMP: "/img/icons/icon-camp.svg",
              GAS: "/img/icons/icon-gas.svg",
              CHARGE: "/img/icons/icon-charge.svg",
              FOOD: "/img/icons/icon-food.svg",
              HOTEL: "/img/icons/icon-hotel.svg",
              DRINKS: "/img/icons/icon-drinks.svg",
              COFFEE: "/img/icons/icon-coffee.svg",
              POI: "/img/icons/icon-poi.svg",
              VIEW: "/img/icons/icon-view.svg",
              GROCERY: "/img/icons/icon-grocery.svg",
              START: "/img/icons/icon-start.svg",
              FINISH: "/img/icons/icon-finish.svg",
              HOME: "/img/icons/icon-home.svg",
              BREAK: "/img/icons/icon-break.svg",
              WTF: "/img/icons/icon-wtf.svg",
            };
            // --- Waypoint Title Mapping ---
            function getWaypointTitle(role) {
              switch ((role || "").toUpperCase()) {
                case "MEET":
                  return "Meet";
                case "SPLIT":
                  return "Split";
                case "GAS":
                  return "Gas";
                case "CAMP":
                  return "Campground";
                case "HOTEL":
                  return "Lodging";
                case "CHARGE":
                  return "EV Charger";
                case "FOOD":
                  return "Food";
                case "POI":
                  return "Point of Interest";
                case "VIEW":
                  return "Scenic Viewpoint";
                case "COFFEE":
                  return "Coffee";
                case "DRINKS":
                  return "Drinks";
                case "GROCERY":
                  return "Groceries";
                case "START":
                  return "Ride Start";
                case "FINISH":
                  return "Ride End";
                case "HOME":
                  return "Home";
                case "BREAK":
                  return "Rest Break";
                case "WTF":
                  return "Weird Random Shit";
                default:
                  return "Waypoint";
              }
            }
            // --- SVG Icon Cache ---
            window.svgIconCache = window.svgIconCache || {};
            async function getColoredSvgIcon(iconPath, color, opacity = 1.0) {
              const resp = await fetch(iconPath);
              let svg = await resp.text();
              svg = svg.replace(/fill="(currentColor|#000|#fff)"/gi, `fill="${color}"`);
              svg = svg.replace(/fill:none/gi, `fill:${color}`);
              svg = svg.replace(/<svg /, `<svg opacity=\"${opacity}\" `);
              const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
              return `data:image/svg+xml;charset=UTF-8,${encoded}`;
            }
            // Canonical roles and their alternate terms (copied from route label logic)
            const roleTerms = {
              MEET: ["MEET", "MEETUP", "MEETING", "CONVERGE", "JOIN"],
              SPLIT: ["SPLIT", "DEPART", "DIVERGE", "LEAVE"],
              CAMP: ["CAMP", "CAMPGROUND", "CAMPING"],
              GAS: ["GAS", "FUEL"],
              CHARGE: ["CHARGE"],
              FOOD: ["FOOD", "LUNCH", "DINNER", "BREAKFAST"],
              HOTEL: ["HOTEL", "LODGING", "MOTEL", "AIRBNB"],
              DRINKS: ["DRINKS", "BAR", "COCKTAILS", "BEER"],
              COFFEE: ["COFFEE", "CAFE"],
              POI: ["POI", "STOP"],
              VIEW: ["VIEW", "SCENIC", "LOOKOUT", "VIEWPOINT"],
              GROCERY: ["GROCERY", "GROCERIES"],
              START: ["START", "BEGIN"],
              FINISH: ["FINISH", "END"],
              HOME: ["HOME", "HOUSE"],
              BREAK: ["BREAK", "REST"],
              WTF: ["WEIRD", "RANDOM"],
            };
            // Split marker types by '/' (up to 4) and canonicalize
            let markerTypes = name
              .split("/")
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 4)
              .map((type) => {
                for (const [canonical, terms] of Object.entries(roleTerms)) {
                  if (terms.some((t) => t.toUpperCase() === type.toUpperCase())) {
                    return canonical;
                  }
                }
                return type; // fallback to original if not found
              });
            if (markerTypes.length === 0) markerTypes = [name];
            // Layout offsets for up to 4 markers (px): [x, y] (increased for padding)
            const gridOffsets = [
              [[0, 0]], // 1 icon
              [
                [-13, 0],
                [13, 0],
              ], // 2 icons (approx 13px apart)
              [
                [-13, 13],
                [13, 13],
                [0, -13],
              ], // 3 icons (triangle, ~13px apart)
              [
                [-13, -13],
                [13, -13],
                [-13, 13],
                [13, 13],
              ], // 4 icons (2x2, ~12px apart)
            ];
            const offsets = gridOffsets[markerTypes.length - 1] || [[0, 0]];
            const allTerms = Object.values(roleTerms).flat();
            const roleRegex = new RegExp(`^(${allTerms.join("|")})\\b\\s*-\\s*(.*)$`, "i");
            // Refactored: create standard markers first, then custom markers for reliable stacking
            const standardRoles = Object.keys(roleIconMap);
            const standardTypes = markerTypes.filter((type) => standardRoles.includes(type));
            const customTypes = markerTypes.filter((type) => !standardRoles.includes(type));
            const orderedTypes = [...standardTypes, ...customTypes];
            orderedTypes.forEach((type, idx) => {
              let role = null;
              let displayName = type;
              const prefixMatch = type.match(roleRegex);
              if (prefixMatch) {
                // Find canonical role for this alias
                const matchedAlias = prefixMatch[1].toUpperCase();
                displayName = prefixMatch[2] || matchedAlias;
                for (const [canonical, terms] of Object.entries(roleTerms)) {
                  if (terms.map((t) => t.toUpperCase()).includes(matchedAlias)) {
                    role = canonical;
                    break;
                  }
                }
                if (!role) role = matchedAlias; // fallback, shouldn't happen
              } else {
                // No prefix, fallback to canonicalization logic
                for (const [canonical, terms] of Object.entries(roleTerms)) {
                  if (terms.map((t) => t.toUpperCase()).includes(type.toUpperCase())) {
                    role = canonical;
                    break;
                  }
                }
                if (!role) role = type.toUpperCase();
                displayName = type;
              }
              const iconPath = roleIconMap[role] || null;
              let markerIcon = null;
              if (iconPath) {
                if (!window.svgIconCache[iconPath]) window.svgIconCache[iconPath] = {};
                // Use cached SVG if available, else fetch and cache
                const cache = window.svgIconCache[iconPath][polylineColor];
                const setMarker = (svgFull) => {
                  markerIcon = {
                    url: svgFull,
                    scaledSize: new google.maps.Size(25, 25),
                    anchor: new google.maps.Point(15 - offsets[idx][0], 15 - offsets[idx][1]),
                  };
                  // Custom icons are those that are in the roleIconMap (like GAS, MEET, etc.)
                  const isCustomIcon = Object.keys(roleIconMap).includes(role);
                  const marker = new google.maps.Marker({
                    position: { lat, lng },
                    map,
                    title: displayName,
                    icon: markerIcon,
                    optimized: false,
                    zIndex: isCustomIcon ? 10 : 1,
                  });
                  marker._svgIconPaths = { iconPath, polylineColor };
                  marker._isCustomIcon = isCustomIcon;
                  if (window.routeMarkers && Array.isArray(window.routeMarkers[currentRouteIndex])) {
                    window.routeMarkers[currentRouteIndex].push(marker);
                  }
                  // Create a small icon element for the tooltip with proper coloring
                  let iconHtml = "";
                  if (iconPath) {
                    // Initially use the original icon path
                    iconHtml = `<img src="${iconPath}" class="waypoint-tooltip-icon" style="width: 20px; height: 20px; margin-right: 8px; vertical-align: middle;" />`;
                  }

                  const infowindow = new google.maps.InfoWindow({
                    content: `<div class='waypoint-tooltip-toprow'>
                      <div class='waypoint-tooltip-title' style="color: ${polylineColor}; display: flex; align-items: center;">
                        ${iconHtml}
                        <span>${getWaypointTitle(role)}</span>
                      </div>
                      <div class='waypoint-tooltip-num'>
                        <span class='waypoint-tooltip-label'>From Start:</span>
                        <span class='waypoint-tooltip-value'>${
                          waypointCumulativeMiles[i] !== null ? waypointCumulativeMiles[i].toFixed(1) + " mi" : "-"
                        }</span>
                      </div>
                      <div class='waypoint-tooltip-num'>
                        <span class='waypoint-tooltip-label'>From Gas:</span>
                        <span class='waypoint-tooltip-value'>${
                          waypointMilesSinceLastGas[i] !== null ? waypointMilesSinceLastGas[i].toFixed(1) + " mi" : "-"
                        }</span>
                      </div>
                      ${
                        hasChargingPoint
                          ? `<div class='waypoint-tooltip-num'>
                        <span class='waypoint-tooltip-label'>From Charge:</span>
                        <span class='waypoint-tooltip-value'>${
                          waypointMilesSinceLastCharge[i] !== null
                            ? waypointMilesSinceLastCharge[i].toFixed(1) + " mi"
                            : "-"
                        }</span>
                      </div>`
                          : ""
                      }
                    </div>
                    <div class='waypoint-tooltip-name'>${esc(displayName)}</div>
                    ${desc ? `<div class='waypoint-tooltip-desc'>${esc(desc)}</div>` : ""}`,

                    disableAutoPan: false,
                    shouldFocus: false,
                  });
                  // Update the icon with the colored version after infowindow is created
                  if (iconPath) {
                    getColoredSvgIcon(iconPath, polylineColor, 1.0).then((coloredIcon) => {
                      const content = infowindow.getContent();
                      if (typeof content === "string") {
                        // If content is a string, we need to create a DOM element to manipulate it
                        const tempDiv = document.createElement("div");
                        tempDiv.innerHTML = content;
                        const imgElement = tempDiv.querySelector(".waypoint-tooltip-icon");
                        if (imgElement) {
                          imgElement.src = coloredIcon;
                          infowindow.setContent(tempDiv.innerHTML);
                        }
                      } else {
                        // If content is already a DOM element
                        const imgElement = content.querySelector(".waypoint-tooltip-icon");
                        if (imgElement) {
                          imgElement.src = coloredIcon;
                        }
                      }
                    });
                  }

                  // Open on mouseover, but don't close on mouseout if it was clicked
                  let wasClicked = false;
                  marker.addListener("mouseover", () => {
                    if (!wasClicked) {
                      infowindow.open({ map, anchor: marker });
                    }
                  });
                  marker.addListener("mouseout", () => {
                    if (!wasClicked) {
                      infowindow.close();
                    }
                  });
                  marker.addListener("click", () => {
                    wasClicked = !wasClicked;
                    if (wasClicked) {
                      infowindow.open({ map, anchor: marker });
                    } else {
                      infowindow.close();
                    }
                  });
                };
                if (cache && cache.full && cache.dim) {
                  setMarker(cache.full);
                } else {
                  Promise.all([
                    getColoredSvgIcon(iconPath, polylineColor, 1.0),
                    getColoredSvgIcon(iconPath, polylineColor, 0.3),
                  ]).then(([svgFull, svgDim]) => {
                    window.svgIconCache[iconPath][polylineColor] = { full: svgFull, dim: svgDim };
                    setMarker(svgFull);
                  });
                }
              } else {
                // fallback: colored circle
                let isNumberOnly = /^\d+$/.test(type.trim());
                let iconOpts = {
                  path: google.maps.SymbolPath.CIRCLE,
                  fillColor: "#fff",
                  fillOpacity: 1,
                  strokeColor: polylineColor,
                  strokeWeight: 4,
                  scale: isNumberOnly ? (i === 0 ? 3 : 2) : i === 0 ? 6 : 4,
                  anchor: new google.maps.Point(0 - offsets[idx][0], 0 - offsets[idx][1]),
                };
                // Custom icons are those that are in the roleIconMap (like GAS, MEET, etc.)
                const isCustomIcon = Object.keys(roleIconMap).includes(role);
                const marker = new google.maps.Marker({
                  position: { lat, lng },
                  map,
                  title: displayName,
                  icon: iconOpts,
                  optimized: false,
                  zIndex: isCustomIcon ? 10 : 1,
                });
                marker._isCircle = true;
                marker._isCustomIcon = isCustomIcon;
                if (window.routeMarkers && Array.isArray(window.routeMarkers[currentRouteIndex])) {
                  window.routeMarkers[currentRouteIndex].push(marker);
                }
                // Marker created
                // Create a small icon element for the tooltip with proper coloring
                let iconHtml = "";
                if (iconPath) {
                  // Initially use the original icon path
                  iconHtml = `<img src="${iconPath}" class="waypoint-tooltip-icon" style="width: 20px; height: 20px; margin-right: 8px; vertical-align: middle;" />`;
                }

                const infowindow = new google.maps.InfoWindow({
                  content: `<div class='waypoint-tooltip-toprow'>
                    <div class='waypoint-tooltip-title' style="color: ${polylineColor}; display: flex; align-items: center;">
                      ${iconHtml}
                      <span>${getWaypointTitle(role)}</span>
                    </div>
                    <div class='waypoint-tooltip-num'>
                      <span class='waypoint-tooltip-label'>From Start:</span>
                      <span class='waypoint-tooltip-value'>${
                        waypointCumulativeMiles[i] !== null ? waypointCumulativeMiles[i].toFixed(1) + " mi" : "-"
                      }</span>
                    </div>
                    <div class='waypoint-tooltip-num'>
                      <span class='waypoint-tooltip-label'>From Gas:</span>
                      <span class='waypoint-tooltip-value'>${
                        waypointMilesSinceLastGas[i] !== null ? waypointMilesSinceLastGas[i].toFixed(1) + " mi" : "-"
                      }</span>
                    </div>
                    ${
                      hasChargingPoint
                        ? `<div class='waypoint-tooltip-num'>
                      <span class='waypoint-tooltip-label'>From Charge:</span>
                      <span class='waypoint-tooltip-value'>${
                        waypointMilesSinceLastCharge[i] !== null
                          ? waypointMilesSinceLastCharge[i].toFixed(1) + " mi"
                          : "-"
                      }</span>
                    </div>`
                        : ""
                    }
                  </div>
                  <div class='waypoint-tooltip-name'>${esc(displayName)}</div>
                  ${desc ? `<div class='waypoint-tooltip-desc'>${esc(desc)}</div>` : ""}`,
                  disableAutoPan: false,
                  shouldFocus: false,
                });
                // Update the icon with the colored version after infowindow is created
                if (iconPath) {
                  getColoredSvgIcon(iconPath, polylineColor, 1.0).then((coloredIcon) => {
                    const content = infowindow.getContent();
                    if (typeof content === "string") {
                      // If content is a string, we need to create a DOM element to manipulate it
                      const tempDiv = document.createElement("div");
                      tempDiv.innerHTML = content;
                      const imgElement = tempDiv.querySelector(".waypoint-tooltip-icon");
                      if (imgElement) {
                        imgElement.src = coloredIcon;
                        infowindow.setContent(tempDiv.innerHTML);
                      }
                    } else {
                      // If content is already a DOM element
                      const imgElement = content.querySelector(".waypoint-tooltip-icon");
                      if (imgElement) {
                        imgElement.src = coloredIcon;
                      }
                    }
                  });
                }

                // Open on mouseover, but don't close on mouseout if it was clicked
                let wasClicked = false;
                marker.addListener("mouseover", () => {
                  if (!wasClicked) {
                    infowindow.open({ map, anchor: marker });
                  }
                });
                marker.addListener("mouseout", () => {
                  if (!wasClicked) {
                    infowindow.close();
                  }
                });
                marker.addListener("click", () => {
                  wasClicked = !wasClicked;
                  if (wasClicked) {
                    infowindow.open({ map, anchor: marker });
                  } else {
                    infowindow.close();
                  }
                });
              }
            });
          });
        });
      // .catch((err) => {
      //   console.error(`Error loading KML route ${kmlUrl}:`, err);
      //   reject(err);
      // });
    });
  }

  // Colors are already defined at the top of the initMap function
  // Keeping the comments for documentation
  // 12 visually distinct, contrasting colors spaced around the color wheel
  // Dark, high-contrast, visually distinct route colors

  // Ensure map instance is globally accessible for toggling
  if (!window.mapInstance && typeof map !== "undefined") {
    window.mapInstance = map;
  }

  // We need to allow buttons to be built each time initMap runs
  // This ensures buttons are properly created with all styles and icons

  // Dynamically build download buttons for each route
  // --- Centralized highlight/dim logic ---
  function setRouteHighlight(activeIndex) {
    // Polylines
    if (window.routePolylines) {
      window.routePolylines.forEach((polyline, idx) => {
        if (polyline) {
          polyline.setOptions({
            strokeOpacity: activeIndex == null ? 0.6 : idx === activeIndex ? 1.0 : 0.3,
            zIndex: activeIndex == null ? 1 : idx === activeIndex ? 2 : 1,
          });
        }
      });
    }
    // Markers
    if (window.routeMarkers) {
      window.routeMarkers.forEach((markers, idx) => {
        if (!markers) return;
        const isActive = activeIndex == null ? null : idx === activeIndex;
        markers.forEach((marker) => {
          if (!marker) return;
          // SVG
          if (marker._svgIconPaths) {
            const { iconPath, polylineColor } = marker._svgIconPaths;
            const cache = window.svgIconCache[iconPath] && window.svgIconCache[iconPath][polylineColor];
            if (cache) {
              const iconObj = {
                url: isActive === null ? cache.full : isActive ? cache.full : cache.dim,
                scaledSize: new google.maps.Size(25, 25),
                anchor: new google.maps.Point(12.5, 12.5),
              };
              if (
                typeof iconObj === "string" ||
                (iconObj && (typeof iconObj.url === "string" || typeof iconObj.path === "string"))
              ) {
                marker.setIcon(iconObj);
              }
            }
          } else if (marker._isCircle) {
            // Circle
            const icon = marker.getIcon();
            const newIcon = { ...icon };
            if (isActive === null) {
              newIcon.strokeOpacity = 1.0;
              newIcon.fillOpacity = 1.0;
            } else {
              newIcon.strokeOpacity = isActive ? 1.0 : 0.3;
              newIcon.fillOpacity = isActive ? 1.0 : 0.3;
            }
            marker.setIcon(newIcon);
          }
          // Use the marker._isCustomIcon flag set at creation for robust z-indexing
          // Custom markers (z-index 10) should always be above standard markers (z-index 1)
          // When highlighted, add 1 to the z-index to bring that marker to the top of its category
          const newZ = (marker._isCustomIcon ? 10 : 1) + (isActive === null ? 0 : isActive ? 1 : 0);
          marker.setZIndex(newZ);
          // Marker zIndex updated
        });
      });
    }
  }

  async function addRouteDownloadButtons(routes) {
    const table = document.querySelector(".route-table");
    if (!table) {
      console.error("[addRouteDownloadButtons] No .route-table found in DOM");
      return;
    }

    // Remove old route rows if re-running
    Array.from(table.querySelectorAll(".route-download-row")).forEach((row) => row.remove());

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      if (!route.kmlUrl) continue;
      const routeColor = route.color || colors[i % colors.length];
      // Get mileage for this route (if available)
      const mileage =
        window.routePolylines && window.routePolylines[i] ? window.routePolylines[i].__mileageMiles : null;

      const tr = document.createElement("tr");
      tr.className = "route-download-row";
      // --- Checkbox TD ---
      const tdCheckbox = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.style.marginRight = "8px";
      // Set accent color to match route line color
      if ("accentColor" in checkbox.style) {
        checkbox.style.accentColor = routeColor;
      } else {
        // Fallback for browsers that do not support accentColor
        checkbox.style.outline = `2px solid ${routeColor}`;
      }
      checkbox.addEventListener("change", function () {
        // Toggle polyline
        if (window.routePolylines && window.routePolylines[i]) {
          window.routePolylines[i].setMap(this.checked ? window.mapInstance : null);
        }
        // Toggle markers
        if (window.routeMarkers && window.routeMarkers[i]) {
          window.routeMarkers[i].forEach((marker) => marker.setMap(this.checked ? window.mapInstance : null));
        }
      });
      tdCheckbox.appendChild(checkbox);
      tr.appendChild(tdCheckbox);
      // --- Mileage TD ---
      const mileageTd = document.createElement("td");
      mileageTd.className = "route-mileage-cell";
      mileageTd.textContent = mileage !== null ? mileage.toFixed(1) + " mi" : "--";

      // Label TD
      const labelTd = document.createElement("td");
      labelTd.className = "route-label-cell";

      // Show human-friendly route name (e.g., 'Oakland to Mt Madonna')
      let friendlyName = route.name || "";
      // Canonical roles and their alternate terms
      const roleTerms = {
        MEET: ["MEET", "MEETING"],
        CAMP: ["CAMP", "CAMPGROUND", "CAMPING", "CAMPSITE"],
        GAS: ["GAS", "FUEL"],
        CHARGE: ["CHARGE", "CHARGER"],
        FOOD: ["FOOD", "LUNCH", "DINNER", "BREAKFAST"],
        HOTEL: ["HOTEL", "LODGING", "MOTEL", "AIRBNB", "SLEEP", "STAY"],
        DRINKS: ["DRINKS", "BAR", "COCKTAILS", "BEER", "BEERS"],
        COFFEE: ["COFFEE", "CAFE"],
        POI: ["POI", "STOP"],
        VIEW: ["VIEW", "SCENIC", "LOOKOUT"],
        GROCERY: ["GROCERY", "GROCERIES"],
        START: ["START", "BEGIN"],
        FINISH: ["FINISH", "END"],
        HOME: ["HOME", "HOUSE"],
        BREAK: ["BREAK", "REST"],
        WTF: ["WTF", "WEIRD", "RANDOM"],
      };
      // Build regex and lookup for alternates
      const allTerms = Object.values(roleTerms).flat();
      const roleRegex = new RegExp(`^(${allTerms.join("|")})\\b\\s*-\\s*(.*)$`, "i");
      const roleMatch = friendlyName.match(roleRegex);
      let iconHtml = "";
      if (roleMatch) {
        // Find canonical role
        let foundRole = null;
        for (const [canonical, terms] of Object.entries(roleTerms)) {
          if (terms.some((t) => t.toUpperCase() === roleMatch[1].toUpperCase())) {
            foundRole = canonical;
            break;
          }
        }
        const iconMap = {
          MEET: "icon-meet.svg",
          CAMP: "icon-camp.svg",
          GAS: "icon-gas.svg",
          CHARGE: "icon-charge.svg",
          GROCERY: "icon-grocery.svg",
          FOOD: "icon-food.svg",
          HOTEL: "icon-hotel.svg",
          DRINKS: "icon-drinks.svg",
          COFFEE: "icon-coffee.svg",
          POI: "icon-poi.svg",
          VIEW: "icon-view.svg",
          START: "icon-start.svg",
          FINISH: "icon-finish.svg",
          HOME: "icon-home.svg",
          BREAK: "icon-break.svg",
          WTF: "icon-wtf.svg",
        };
        const iconFile = iconMap[foundRole];
        if (iconFile) {
          iconHtml = `<span class="route-icon-bg" style="background:${routeColor}"><img src="/img/icons/${iconFile}" alt="${foundRole}" class="route-icon"></span>`;
        }
      }
      // Add route line icon before the label
      const routeLineIcon = `<svg class="route-table-line-icon" width="38" height="18" viewBox="0 0 38 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;margin-right:0.5em;"><circle cx="7" cy="9" r="4" fill='none' stroke='${routeColor}' stroke-width="2"/><circle cx="31" cy="9" r="4" fill='none' stroke='${routeColor}' stroke-width="2"/><line x1="11" y1="9" x2="27" y2="9" stroke='${routeColor}' stroke-width="3" stroke-linecap="round"/></svg>`;
      // --- NEW STRUCTURE ---
      const labelDiv = document.createElement("div");
      labelDiv.className = "route-label";
      labelDiv.innerHTML = routeLineIcon + iconHtml + esc(friendlyName);
      // Set CSS variable for highlight background (10% opacity)
      function hexToRgba(hex, alpha) {
        let c = hex.replace("#", "");
        if (c.length === 3)
          c = c
            .split("")
            .map((x) => x + x)
            .join("");
        const num = parseInt(c, 16);
        return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
      }
      labelDiv.style.setProperty("--route-color-bg", hexToRgba(routeColor, 0.1));
      labelTd.appendChild(labelDiv);
      tr.appendChild(labelTd);
      tr.appendChild(mileageTd);
      // --- Map highlight on hover ---
      labelDiv.addEventListener("mouseenter", () => setRouteHighlight(i));
      labelDiv.addEventListener("mouseleave", () => setRouteHighlight(null));

      // --- Download buttons TD ---
      const btnTd = document.createElement("td");
      btnTd.className = "value";
      const btnGroup = document.createElement("div");
      btnGroup.className = "btn-group btn-group-sm";

      const safeName = (friendlyName || "route").replace(/[^A-Za-z0-9._-]+/g, "-");

      // GPX (metadata-driven; no filesystem probe)
      if (route.gpxPresent && route.gpxUrl) {
        const gpxBtn = document.createElement("a");
        gpxBtn.className = "btn btn-sm btn-success gpx-btn";
        gpxBtn.href = route.gpxUrl;
        gpxBtn.download = `${safeName}.gpx`;
        gpxBtn.textContent = "GPX";
        btnGroup.appendChild(gpxBtn);
      }

      // KML (always present)
      if (route.kmlUrl) {
        const kmlBtn = document.createElement("a");
        kmlBtn.className = "btn btn-sm btn-danger kml-btn";
        kmlBtn.href = route.kmlUrl;
        kmlBtn.download = `${safeName}.kml`;
        kmlBtn.textContent = "KML";
        btnGroup.appendChild(kmlBtn);
      }

      // External URL (guard scheme; server also validates)
      if (route.externalUrl && /^https?:/i.test(route.externalUrl)) {
        const urlBtn = document.createElement("a");
        urlBtn.className = "btn btn-sm btn-primary url-btn";
        urlBtn.href = route.externalUrl;
        urlBtn.target = "_blank";
        urlBtn.rel = "noopener noreferrer";
        urlBtn.textContent = "URL";
        btnGroup.appendChild(urlBtn);
      }

      btnTd.appendChild(btnGroup);
      tr.appendChild(btnTd);
      table.appendChild(tr);

      // --- End of addRouteDownloadButtons ---
    }

    // Helper functions are already defined above
    /*
    // End of helper function definitions
    */
    // Removed duplicate calls to addRouteDownloadButtons and updateRouteLegend
  }
  // End of initMap function
};

// Add a global error handler to catch any uncaught errors
window.addEventListener("error", function (event) {
  console.error("GLOBAL ERROR CAUGHT:", event.error);
});

/**
 * Hides any element with the given selector if its <img> child fails to load.
 * @param {string} selector - CSS selector for the container (e.g. '.panel-logo')
 */
function hideContainerIfImageMissing(selector) {
  document.querySelectorAll(selector).forEach(function (container) {
    var img = container.querySelector("img");
    if (img) {
      img.onerror = function () {
        container.style.display = "none";
      };
    }
  });
}

document.addEventListener("DOMContentLoaded", function () {
  hideContainerIfImageMissing(".panel-logo");
  hideContainerIfImageMissing(".map-logo");
  // Direction arrows checkbox logic
  var arrowsCheckbox = document.getElementById("toggle-arrows");
  if (arrowsCheckbox) {
    arrowsCheckbox.checked = window.showDirectionArrows !== false;
    arrowsCheckbox.addEventListener("change", function (e) {
      window.showDirectionArrows = e.target.checked;
      if (window.routePolylines) {
        window.routePolylines.forEach(function (poly) {
          if (poly) {
            poly.set(
              "icons",
              window.showDirectionArrows
                ? [
                    {
                      icon: {
                        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
                        scale: 1.5,
                        strokeColor: poly.get("strokeColor"),
                        strokeWeight: 2,
                      },
                      offset: "0%",
                      repeat: "50px",
                    },
                  ]
                : []
            );
          }
        });
      }
    });
  }

  // Robust panel collapse/expand logic
  (function initPanelToggle() {
    const panel = document.getElementById("info-panel");
    if (!panel) {
      return;
    }
    const toggle = panel.querySelector(".collapse-toggle");
    if (!toggle) {
      return;
    }
    // Prevent duplicate event listeners
    if (toggle.dataset.collapseBound === "true") {
      return;
    }
    function setCollapsed(collapsed) {
      panel.classList.toggle("collapsed", collapsed);
      const icon = toggle.querySelector(".collapse-icon");
      if (collapsed) {
        if (icon) icon.src = "/img/icons/icon-expand.svg";
        toggle.setAttribute("aria-label", "Expand panel");
      } else {
        if (icon) icon.src = "/img/icons/icon-collapse.svg";
        toggle.setAttribute("aria-label", "Collapse panel");
      }
    }
    toggle.addEventListener("click", function (e) {
      setCollapsed(!panel.classList.contains("collapsed"));
    });
    toggle.dataset.collapseBound = "true";
    // Optionally: initialize to collapsed or expanded as desired
    // setCollapsed(panel.classList.contains("collapsed"));
  })();
});
