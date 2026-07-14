<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config;
use App\Db;

/** HTML pages: the landing/browse list and the single-map viewer. */
final class PageController
{
    /** GET / — minimal public listing (a precursor to the M4 browse page). */
    public function home(array $p = []): void
    {
        $rows = Db::conn()->query(
            "SELECT slug, title, color, total_miles, waypoint_count
             FROM maps WHERE visibility = 'public'
             ORDER BY created_at DESC LIMIT 50"
        )->fetchAll();

        render('home', ['maps' => $rows]);
    }

    /** GET /m/{slug} — the viewer page for a single public/unlisted map. */
    public function viewMap(array $p): void
    {
        $slug = $p['slug'] ?? '';
        $stmt = Db::conn()->prepare(
            'SELECT id, slug, title, description, color, visibility
             FROM maps WHERE slug = ? LIMIT 1'
        );
        $stmt->execute([$slug]);
        $map = $stmt->fetch();

        if (!$map || !in_array($map['visibility'], ['public', 'unlisted'], true)) {
            abort(404, 'Map not found');
        }

        render('view', [
            'map'         => $map,
            'gmapsKey'    => (string) Config::get('gmaps_key'),
            'metadataUrl' => '/api/public/maps/' . $map['slug'],
        ]);
    }
}
