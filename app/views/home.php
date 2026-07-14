<?php
/**
 * Minimal public landing / listing. Grows into the full browse page in M4.
 *
 * @var array $maps
 */
?>
<!doctype html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moto-Rooter</title>
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <style>
    body { font: 400 16px/1.5 Lato, system-ui, sans-serif; margin: 0; padding: 2rem; color: #333; background: #f4f4f4; }
    h1 { margin: 0 0 0.25rem; }
    .sub { color: #777; margin-bottom: 2rem; }
    ul { list-style: none; padding: 0; display: grid; gap: 0.75rem; max-width: 640px; }
    li { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); }
    a.card { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; text-decoration: none; color: inherit; }
    .swatch { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
    .meta { color: #888; font-size: 0.85em; margin-left: auto; }
    .empty { color: #999; }
  </style>
</head>
<body>
  <h1>Moto-Rooter</h1>
  <div class="sub">Public road-trip maps</div>

  <?php if (empty($maps)): ?>
    <p class="empty">No public maps yet.</p>
  <?php else: ?>
    <ul>
      <?php foreach ($maps as $m): ?>
        <li>
          <a class="card" href="/m/<?= e($m['slug']) ?>">
            <span class="swatch" style="background: <?= e($m['color']) ?>"></span>
            <span><?= e($m['title']) ?></span>
            <span class="meta"><?= (int) $m['waypoint_count'] ?> stops &middot; <?= rtrim(rtrim(number_format((float) $m['total_miles'], 1), '0'), '.') ?> mi</span>
          </a>
        </li>
      <?php endforeach; ?>
    </ul>
  <?php endif; ?>
</body>
</html>
