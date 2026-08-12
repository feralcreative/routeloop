// The naming convention, client side. window.TBFilename.
//
// A mirror of src/maps/filename.ts, and deliberately a mirror rather than a
// shared module: the server has no bundler to hand this file to a browser, and
// the drop box has to show a rider what it read out of their filenames *before*
// anything is uploaded — a round trip to ask the server what a filename means
// is a network call to answer a question about a string.
//
// The two must not drift, so test/filename-client.test.ts runs both over the
// same fixtures and asserts they agree. That is the arrangement twist.js and
// ride-time.js already use, and the reason those files sit outside builder.js.
//
// Read filename.ts for why the format is shaped as it is; this file carries the
// mechanics only.
(function (window) {
  "use strict";

  var MARKER = "routeloop";
  // Written: MARKER. Accepted: these. See READ_MARKERS in src/maps/filename.ts —
  // dropping the legacy marker loses day order and dates on every file a rider
  // exported under the old name, and loses them silently.
  var READ_MARKERS = [MARKER, "tankbag"];
  var MAX_FIELD = 60;
  var DAY_RE = /^d(\d{1,3})$/;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(\d{2}))?$/;
  var NATIVE_EXT = "routeloop.json";
  var COMPOUND_EXTS = [NATIVE_EXT, "tankbag.json"];

  function slugField(s, max) {
    if (max === undefined) max = MAX_FIELD;
    return String(s == null ? "" : s)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max)
      .replace(/-$/, "");
  }

  function titleFromSlug(slug) {
    return String(slug)
      .split("-")
      .filter(Boolean)
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ");
  }

  function splitExt(fileName) {
    var lower = fileName.toLowerCase();
    for (var i = 0; i < COMPOUND_EXTS.length; i++) {
      var ext = COMPOUND_EXTS[i];
      if (lower.endsWith("." + ext)) return { stem: fileName.slice(0, -(ext.length + 1)), ext: ext };
    }
    var dot = fileName.lastIndexOf(".");
    if (dot <= 0) return { stem: fileName, ext: "" };
    return { stem: fileName.slice(0, dot), ext: lower.slice(dot + 1) };
  }

  function parseDate(token) {
    var m = DATE_RE.exec(token);
    if (!m) return null;
    var y = +m[1];
    var mo = +m[2];
    var d = +m[3];
    var hh = m[4] ? +m[4] : 0;
    var mm = m[5] ? +m[5] : 0;
    var date = new Date(Date.UTC(y, mo - 1, d, hh, mm));
    // Rejects 2026-02-30 and 2026-13-01, which the Date constructor rolls over
    // silently rather than failing on.
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return { date: date, hasTime: Boolean(m[4]) };
  }

  function parseExportName(fileName) {
    var split = splitExt(fileName);
    var tokens = split.stem.split("_");
    if (tokens.length < 2 || READ_MARKERS.indexOf(tokens[0].toLowerCase()) === -1) return null;

    var rest = tokens.slice(1);
    var ride = slugField(rest[0]);
    if (!ride) return null;

    var i = 1;
    var day = null;
    var date = null;
    var hasTime = false;

    var dayMatch = i < rest.length ? DAY_RE.exec(rest[i]) : null;
    if (dayMatch) {
      var n = Number(dayMatch[1]);
      if (n >= 1) {
        day = n;
        i++;
      }
    }

    if (i < rest.length) {
      var d = parseDate(rest[i]);
      if (d) {
        date = d.date;
        hasTime = d.hasTime;
        i++;
      }
    }

    return {
      ride: ride,
      day: day,
      date: date,
      hasTime: hasTime,
      title: slugField(rest.slice(i).join("-")) || null,
      ext: split.ext,
    };
  }

  function planImport(fileNames) {
    var files = fileNames.map(function (fileName, index) {
      var p = parseExportName(fileName);
      return {
        fileName: fileName,
        index: index,
        day: p ? p.day : null,
        date: p ? p.date : null,
        hasTime: p ? p.hasTime : false,
        title: p ? p.title : null,
        ext: p ? p.ext : splitExt(fileName).ext,
        conforming: p !== null,
      };
    });

    var parsed = fileNames.map(parseExportName);
    var rides = parsed
      .filter(function (p) {
        return p !== null;
      })
      .map(function (p) {
        return p.ride;
      });

    var everyDay =
      files.length > 0 &&
      files.every(function (f) {
        return f.day != null;
      });

    if (everyDay) {
      files.sort(function (a, b) {
        return a.day - b.day || a.index - b.index;
      });
    }

    return {
      ride: rides.length > 0 ? titleFromSlug(rides[0]) : null,
      files: files,
      allConforming:
        files.length > 0 &&
        files.every(function (f) {
          return f.conforming;
        }),
      reordered:
        everyDay &&
        files.some(function (f, n) {
          return f.index !== n;
        }),
      rideConflict: rides.some(function (r) {
        return r !== rides[0];
      }),
    };
  }

  window.TBFilename = {
    MARKER: MARKER,
    slugField: slugField,
    titleFromSlug: titleFromSlug,
    splitExt: splitExt,
    parseExportName: parseExportName,
    planImport: planImport,
  };
})(window);
