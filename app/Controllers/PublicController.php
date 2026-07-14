<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config;
use App\Db;

/**
 * Public (unauthenticated) endpoints that feed the map viewer.
 * These replace the old file-on-disk seams: routes.json, the KML fetch, and
 * the GPX/URL existence probes.
 */
final class PublicController
{
    /** GET /api/public/maps/{slug} — Seam 1: route metadata for the viewer. */
    public function metadata(array $p): void
    {
        $map  = $this->findViewable($p['slug'] ?? '');
        $slug = $map['slug'];

        // Array (length 1) — the viewer's legend renders fine with one entry.
        json_response([[
            'name'          => $map['title'],
            'color'         => $map['color'],
            'kmlUrl'        => "/api/public/maps/{$slug}/kml",
            'gpxUrl'        => $map['gpx_present'] ? "/api/public/maps/{$slug}/gpx" : null,
            'externalUrl'   => $map['external_url'] !== '' ? $map['external_url'] : null,
            'gpxPresent'    => (bool) $map['gpx_present'],
            'waypointCount' => (int) $map['waypoint_count'],
            'totalMiles'    => (float) $map['total_miles'],
        ]]);
    }

    /** GET /api/public/maps/{slug}/kml — Seam 2: gated KML stream. */
    public function kml(array $p): void
    {
        $map = $this->findViewable($p['slug'] ?? '');
        $this->streamFile($map, 'kml', 'application/vnd.google-earth.kml+xml');
    }

    /** GET /api/public/maps/{slug}/gpx — gated GPX download. */
    public function gpx(array $p): void
    {
        $map = $this->findViewable($p['slug'] ?? '');
        if (!$map['gpx_present']) {
            abort(404, 'Not found');
        }
        $this->streamFile($map, 'gpx', 'application/gpx+xml');
    }

    /**
     * Fetch a map by slug and enforce visibility. M1 has no auth, so only
     * public/unlisted are viewable; anything else 404s (never confirm a
     * private/unknown slug exists).
     */
    private function findViewable(string $slug): array
    {
        if ($slug === '') {
            abort(404, 'Not found');
        }
        $stmt = Db::conn()->prepare(
            'SELECT id, owner_id, slug, title, color, visibility, external_url,
                    gpx_present, waypoint_count, total_miles
             FROM maps WHERE slug = ? LIMIT 1'
        );
        $stmt->execute([$slug]);
        $map = $stmt->fetch();

        if (!$map || !in_array($map['visibility'], ['public', 'unlisted'], true)) {
            abort(404, 'Not found');
        }
        return $map;
    }

    /**
     * Stream a stored file. The path is built only from integer owner/map ids,
     * so it cannot escape the storage root; a realpath containment check guards
     * against symlink surprises regardless.
     */
    private function streamFile(array $map, string $ext, string $contentType): void
    {
        $base = rtrim((string) Config::get('storage_path'), '/');
        $path = $base . '/' . (int) $map['owner_id'] . '/' . (int) $map['id'] . '.' . $ext;

        $real     = realpath($path);
        $baseReal = realpath($base);
        if (
            $real === false || $baseReal === false
            || strncmp($real, $baseReal . '/', strlen($baseReal) + 1) !== 0
            || !is_file($real)
        ) {
            abort(404, 'Not found');
        }

        header('Content-Type: ' . $contentType . '; charset=utf-8');
        header('Content-Length: ' . filesize($real));
        header('X-Content-Type-Options: nosniff');
        if (isset($_GET['dl'])) {
            $safe = preg_replace('/[^A-Za-z0-9._-]+/', '-', (string) $map['title']) ?: 'route';
            header('Content-Disposition: attachment; filename="' . $safe . '.' . $ext . '"');
        }
        readfile($real);
        exit;
    }
}
