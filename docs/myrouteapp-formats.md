# Getting MyRoute-app routes into routeloop with the least loss

The question this document answers: of the file types MyRoute-app (MRA) offers under **Save As**, which one carries the most intact route intent—waypoints, their semantics, the calculated line, and POIs—into routeloop?

Every factual claim is footnoted. Claims sourced from community forums rather than official MRA documentation are marked as such inline, because the technical detail here lives almost entirely in forum posts.

A naming caution: **MyRoute-app** (myrouteapp.com, the motorcycle route planner) is a different product from **MyRouteOnline** (myrouteonline.com, a fleet/delivery route optimizer). Search results conflate them constantly. Everything below is MyRoute-app.

## The answer

**Save As → `.GPX 1.1 (route, track, POI)`.** One file, and it is the only option that carries all three layers of the route with the waypoint semantics still labeled.

Nothing else comes close, and the runners-up all lose something specific and unrecoverable:

- GPX 1.0 flattens every shaping point into a via point.[^1]
- GPX 1.2 deletes shaping points from the waypoint list entirely.[^2]
- GPX 1.1 (track, POI) drops the waypoint list altogether.[^3]
- Everything else is either device-proprietary, POI-only, or human-readable-only.

The rest of this document is why, what is still lost even at the best setting, and what to do about it in the importer.

## What an MRA GPX 1.1 file actually contains

Three independent layers in one document.

**`<rte>`—the route as authored.** An ordered list of `<rtept>` elements, each carrying a human-readable `<name>` (MRA appears to reverse-geocode these into street addresses) and an `<extensions>` block declaring the point's class.[^4]

```xml
<rtept lat="56.257381439208984" lon="-4.935779571533203">
  <name>Cairndow</name>
  <extensions>
    <trp:ViaPoint/>
  </extensions>
</rtept>
```

The two classes are `<trp:ViaPoint/>` and `<trp:ShapingPoint/>`.[^5] A via point is a stop the device announces and treats as a mandatory arrival; a shaping point only bends the line and should pass silently. That distinction is the single most valuable thing in the file and the thing most of the other formats destroy.

The `trp:` prefix is a TomTom-lineage namespace rather than Garmin's `gpxx:`, which matters if routeloop's parser is written against Garmin conventions—it will see no `gpxx:RoutePointExtension` in this variant and must key off `trp:` instead.

**`<trk>`—the calculated line.** A dense polyline of the actual road geometry MRA computed between the waypoints, named `Track-<routename>`.[^4]

```xml
<trk>
  <name>Track-test</name>
  <trkseg>
    <trkpt lon="4.570600" lat="47.767940" />
```

This is the ground truth for what the rider planned. It is independent of whatever routing engine consumes the file, which is exactly why it is worth keeping.

**`<wpt>`—POIs.** MRA writes POIs into the exported GPX correctly.[^6] Worth noting the asymmetry: MRA *exports* POIs fine but does not *import* them back—an MRA alpha tester states flatly that neither the web planner nor the app picks up POIs from a GPX on import.[^6] That is MRA's problem, not routeloop's, but it means "round-trips cleanly through MRA" is not a test you can use to validate your own parsing.

## Format-by-format loss analysis

Ranked by how much survives. Loss column describes what is gone relative to the route as it existed in MRA.

| Save As option | Route waypoints | Via/shaping distinction | Calculated line | POIs | Verdict |
| --- | --- | --- | --- | --- | --- |
| `.GPX 1.1 (route, track, POI)` | Yes | Yes, explicit `trp:` extensions | Yes, as `<trk>` | Yes | **Use this** |
| `.GPX 1.2 (route, track, POI)` | Via points only | Shaping points removed from list | Yes | Yes | Lossy, and MRA-specific |
| `.GPX 1.0 (route, track, POI)` | Yes | No, all become via points | Yes | Yes | Semantics destroyed |
| `.GPX 1.1 (track, POI)` | No | N/A | Yes | Yes | Geometry only |
| `.ITN (route)` | Yes, capped | No | No | No | TomTom itinerary, worst case |
| `.TPF` / `.TRF (route)` | Yes | Unverified | Unverified | Unverified | TomTom-proprietary |
| `.TAR.GZ (route)` | Unverified | Unverified | Unverified | Unverified | BMW container |
| `.KML` / `.KMZ (route)` | Weak | No | Yes | Partial | Geometry, no routing semantics |
| `.OV2 (POI)` / `.CSV (POI)` | No | N/A | No | Yes | POIs only, by design |
| `.PDF` | No | N/A | No | No | Human-readable roadbook |

### Why GPX 1.2 loses despite sounding newer

MRA's GPX 1.2 strips shaping points out of the `<rte>` waypoint list and instead embeds the shape as `gpxx:rpt` route point extension data—Garmin's "hidden" or "ghost" points—inside the via points that remain.[^2] MRA describes the resulting behavior as "navigation works based on the track, only viapoints are used and shown".[^14]

Two problems for an importer. First, the shaping points a rider deliberately placed are no longer addressable as waypoints, so routeloop cannot show them, let them be edited, or round-trip them. Second, this is a house designation rather than a ratified GPX version—the published GPX schemas I am aware of are 1.0 and 1.1, and a forum analysis reports that standard software such as Garmin BaseCamp does not read MRA's 1.2 as intended.[^1] I have not verified the schema-registry point against Topografix myself.

There is also a live defect trail around it: Garmin outdoor devices reportedly fail to display even the surviving via points from an MRA 1.2 export, with users routing the file through BaseCamp as a workaround.[^2] Treat GPX 1.2 as a device-delivery encoding, not an interchange format.

### Why GPX 1.0 loses

MRA's 1.0 export produces a track and an accurate route, "but with all waypoints shown as via points".[^1] Every shaping point is silently promoted. This is almost certainly a schema constraint rather than an MRA choice—GPX 1.0 has no `<extensions>` element in which to carry the distinction, so there is nowhere to put it. I have not confirmed that against the 1.0 schema, but the behavior is consistent with it.

The failure mode is nasty because it is invisible: the file parses fine, the geometry is right, and every shaping point has quietly become an announced stop. A rider importing a 40-waypoint route would get 38 spurious arrival announcements.

### Why the track-only variant loses

`.GPX 1.1 (track, POI)` writes the route as a track with no route waypoints at all.[^3] MRA recommends it specifically for the Garmin Zumo XT, which behaves badly with waypoint routes.[^14] That is a device workaround, not an interchange choice—it subtracts the `<rte>` layer and adds nothing the combined variant does not already have, since the combined variant contains the same `<trk>`.

### Why none of the device formats are candidates

`.ITN` is a TomTom itinerary: waypoints only, no calculated line, and every waypoint becomes an announced stop.[^7] It also carries a maximum waypoint count that MRA warns about without publishing.[^7] Third-party documentation puts the ceiling at 32 or 48 on pre-2014 TomTom devices, 255 on later ones, and 100 on the Rider range—figures worth verifying per device rather than trusting.[^8]

`.TPF`, `.TRF`, and `.TAR.GZ` are proprietary containers aimed at TomTom and BMW head units.[^7] Writing parsers for them buys nothing GPX 1.1 does not already provide.

`.KML`/`.KMZ` carry geometry but have no concept of via versus shaping points, so the semantics are gone the moment you choose them.

## What is still lost at the best setting

GPX 1.1 (route, track, POI) is the best available, not lossless. Things that plausibly do not survive, none of which I have been able to confirm without a sample file:

- **Routing preferences.** MRA's avoid-highways, curviness, and vehicle-profile settings are planner state, not GPX fields. If routeloop re-routes rather than following the `<trk>`, the line will drift.
- **Multi-day and segment structure.** Whether MRA's day splits survive as separate `<trk>` segments, separate files, or not at all is unverified.
- **Route description, notes, and attached media.** Unverified whether MRA writes these into `<desc>`/`<cmt>` or drops them.
- **POI categories and icons.** Whether MRA maps its POI types onto `<sym>` values, and what vocabulary it uses, is unverified.
- **MRA's internal route ID**, which would otherwise be the natural key for detecting re-imports of the same route.
- **Timing and schedule data**, if MRA holds any.

## Implications for the routeloop importer

- **Store both layers, do not collapse them.** `<rte>` is the rider's intent, `<trk>` is MRA's computed geometry. Keeping only the waypoints means routeloop's own router decides the road and the line moves; keeping only the track means the route is uneditable. Both, linked, is the only faithful representation.
- **Key point class off the `trp:` namespace,** and treat *absence* of a class element as needing an explicit decision rather than a silent default. Do not assume Garmin's `gpxx:RoutePointExtension` will be present in the 1.1 variant.
- **Detect and warn on the lossy variants.** A file with `<rtept>` elements but no `<extensions>` is almost certainly a GPX 1.0 export with the semantics already flattened; a file whose rtepts carry `gpxx:rpt` children is likely MRA's 1.2. In both cases routeloop should say so rather than importing a subtly wrong route silently. The `creator` attribute on the `<gpx>` root is the obvious place to confirm MRA provenance, though I have not verified what MRA writes there.
- **Do not use MRA round-tripping as a correctness test.** MRA discards POIs on import, so a route that comes back diminished may well be MRA's fault, not yours.[^6]
- **Ignore the mobile app as an export path.** It is a narrower door in both directions and adds nothing here.

## The one thing worth doing before writing any parser

Export a single real, moderately complex route—mixed via and shaping points, a few POIs, a multi-day split if MRA supports one—from the same MRA account, once in each of GPX 1.1, 1.0, and 1.2. Diff the three files. That resolves every "unverified" flag in this document in about ten minutes, and it is the only way to know what MRA writes for `creator`, `<desc>`, `<sym>`, and day segmentation. Everything above is assembled from documentation and forum reports, not from a file I have inspected.

<!--| PAGE-BREAK -->

## Appendix A: MRA's Export path, for future reference

Kept because it is a useful model if routeloop ever grows a direct-to-device feature of its own.

MRA separates writing a route out into two mechanisms with different format lists.[^7] **Save As** downloads a file and you pick the format—that is everything discussed above. **Export** pushes a route directly onto a connected device through the MRA Connector, a small desktop helper for Windows and macOS.[^7][^9] In the Export path you pick a *device profile*, not a format, and MRA chooses the encoding for you.

| Option as MRA labels it | Underlying format | Stated target |
| --- | --- | --- |
| TomTom (ITN) | `.itn` | Older TomTom devices that cannot read GPX 1.1 |
| TomTom Rider (GPX 1.1) | `.gpx` | Newer TomTom devices |
| Garmin old (GPX 1.0) | `.gpx` | Older Garmin devices without GPX 1.1 support |
| Garmin new (GPX 1.1) | `.gpx` | Generally the best choice for Garmin |
| Interphone (KML) | `.kml` | Interphone units |
| BMW Car (TAR.GZ) | `.tar.gz` | BMW car navigation |
| BMW Motorcycle (GPX 1.1) | `.gpx` | BMW motorcycle navigation |

Design details worth stealing. Exporting GPX 1.1 to a TomTom writes **two** files to the device—the route, plus a duplicate prefixed `Track-`—and MRA's guidance is to ride the `Track-` file because it follows the planned line more accurately.[^10] The device treats an `.ITN` as a genuine route with every waypoint as a stop, rendered as a solid arrow, while a `.GPX` is read as a track showing only start and end, rendered as a dotted arrow.[^10] That solid-versus-dotted affordance is a neat way to make an invisible data-model difference visible to a rider.

The Connector's format menu is also deliberately narrower than Save As: a forum regular reports there is no track-only or POI-only option inside the Connector.[^1] Device targets get opinionated defaults; the file-download path gets the full matrix.

The full Save As list, for completeness: GPX 1.1 (route, track, POI), GPX 1.2 (route, track, POI), GPX 1.1 (track, POI), GPX 1.0 (route, track, POI), ITN (route), TPF (route), TRF (route), KML (route), KMZ (route), OV2 (POI), CSV (POI), TAR.GZ (route), PDF, HD BoomBox 2019 (track), HD BoomBox pre-2019 (route), Email route, and plan.tomtom.[^7][^11]

## Appendix B: What MRA itself accepts on import

Relevant only if routeloop ever needs to push routes back the other way.[^12]

| Import as | Accepted extensions |
| --- | --- |
| Routes | GPX, ITN, TRF, TPF, KML, KMZ, TAR.GZ |
| Route-tracks and tracklogs | GPX, KMZ, KML |
| POIs | OV2, GPX, CSV |

Absent from both directions: `.FIT`, `.TCX`, `.GeoJSON`, and any polyline-encoded format. GPX is the only realistic channel in either direction.

The mobile app is far narrower—`.GPX` only, imported via the OS share sheet, and a route imported on the phone **stays on the phone** rather than appearing in the web account.[^13] Combined with the POI-discard behavior noted earlier,[^6] MRA's import side is materially weaker than its export side.

## Sources

[^1]: MRA Community Forum, "The Different .gpx Export & Save As Options", <https://forum.myrouteapp.com/topic/1958/the-different-gpx-export-save-as-options>. Community source, not official MRA documentation. Source for the per-version waypoint behavior comparison (1.0 flattening all waypoints to via points, 1.1 preserving the distinction as authored, 1.2 carrying via points only), the claim that GPX 1.2 is MRA-specific and not read as intended by Garmin BaseCamp, and the observation that the Connector offers no track-only or POI-only option.

[^2]: MRA Community Forum, "Add option for stripping shaping points in gpx export", <https://forum.myrouteapp.com/topic/6684/add-option-for-stripping-shaping-points-in-gpx-export>. Community source. Source for GPX 1.2 stripping shaping points from the waypoint list while preserving shape as `gpxx:rpt` route point extension data, and for the reported failure of via points to display on Garmin outdoor devices from a 1.2 export together with the BaseCamp workaround.

[^3]: MyRoute-app Support, "General information about 'Export' and 'Save As'", <https://support.myrouteapp.com/en/support/solutions/articles/12000108033-general-information-about-export-and-save-as->. Source for `.GPX 1.1 (track, POI)` being the route saved as a track without waypoints. Note this article replaced the older, now-404 article `12000079899-general-information-about-export-and-save-as`.

[^4]: data-integration.dev, "How I used a MyRouteApp GPX with my Beeline moto II", <https://data-integration.dev/posts/mra-beeline/>. Third-party technical write-up with quoted XML from a real MRA export. Source for the `<rte>`/`<rtept>` structure with reverse-geocoded `<name>` values, the `<trp:ViaPoint/>` extension, and the separate `<trk>` named `Track-<routename>` carrying the dense calculated line.

[^5]: Zumo User Forums, "XT2 and MyRouteApp - Shaping & Via Points", <https://zumouserforums.co.uk/viewtopic.php?t=2979>. Third-party forum. Source for both `<trp:ViaPoint/>` and `<trp:ShapingPoint/>` appearing in MRA GPX 1.1 route point extensions, and for the three-way distinction between via points, shaping points, and route point extension "ghost" points. Accessed via search-result excerpt; the site returned HTTP 403 to direct fetching, so this is a second-hand reading of the thread rather than a full review of it.

[^6]: MRA Community Forum, "Exported and reimported route-track loses POI", <https://forum.myrouteapp.com/topic/10452/exported-and-reimported-route-track-losts-poi>. Community source. Includes a statement from MRA alpha tester Con Hennekels that neither the MRA web planner nor the MRA app imports POIs present in a GPX, while confirming POIs are written correctly on export.

[^7]: MyRoute-app Support, "General information about 'Export' and 'Save As'", <https://support.myrouteapp.com/en/support/solutions/articles/12000108033-general-information-about-export-and-save-as->. Primary source for the full Export device list, the full Save As format list, the Export-versus-Save-As distinction, and the note that ITN carries a maximum waypoint count.

[^8]: Wikipedia, "Itinerary file", <https://en.wikipedia.org/wiki/Itinerary_file>. Third-party source for the TomTom ITN waypoint ceilings (32 or 48 on pre-2014 devices, 255 on later ones, 100 on the Rider range). MRA itself states only that a maximum exists.

[^9]: MyRoute-app Support, "Exporting and saving routes to devices with MyRoute-app" (article folder), <https://support.myrouteapp.com/en/support/solutions/folders/12000008675>. Contains the Connector installation articles for Windows and macOS and the per-device export walkthroughs.

[^10]: MyRoute-app Support, "TomTom - Exporting with the Connector", <https://support.myrouteapp.com/en/support/solutions/articles/12000103832-tomtom-exporting-with-the-connector>. Source for the ITN-as-route versus GPX-as-track distinction on TomTom devices, the solid/dotted arrow rendering, and the duplicate `Track-` file the Connector writes.

[^11]: MyRoute-app Support, "TomTom - Export with plan.tomtom", <https://support.myrouteapp.com/en/support/solutions/articles/12000103834-tomtom-export-with-plan-tomtom>. Source for the plan.tomtom hand-off target.

[^12]: MyRoute-app Support, "Manual 'Uploading routes, tracks and POIs'", <https://support.myrouteapp.com/en/support/solutions/articles/12000105325-manual-uploading-routes-tracks-and-pois->. Primary source for MRA's accepted import extensions. The article does not state file size limits, batch limits, or archive-handling details.

[^13]: MRA Community Forum threads on mobile GPX import, principally "How to bring an external .GPX file into my route App for navigation", <https://forum.myrouteapp.com/topic/10345/how-to-bring-an-external-.gpx-file-into-my-route-app-for-navigation>, and "How do I upload gpx file using the app on ios?", <https://forum.myrouteapp.com/topic/5392/how-do-i-upload-gpx-file-using-the-app-on-ios>. Community sources. Source for the GPX-only restriction on the mobile app, the share-sheet import mechanism, and the fact that app-side imports do not propagate to the web account.

[^14]: MyRoute-app Support, "Garmin - Export", <https://support.myrouteapp.com/en/support/solutions/articles/12000103419-garmin-export>. Source for MRA's own behavioral descriptions of GPX 1.1 ("navigation works based on waypoints, all waypoints (shaping + via) are used and shown") versus GPX 1.2 ("navigation works based on the track, only viapoints are used and shown"), and for the Zumo XT track-only and Tread/XT2 GPX-1.1-only guidance.
