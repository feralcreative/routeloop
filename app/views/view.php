<?php
/**
 * Single-map viewer page. Provides the DOM scaffold the ported viewer expects
 * (#map, #info-panel, .route-table, #toggle-arrows) and wires the Maps key +
 * metadata URL that main.js consumes.
 *
 * @var array  $map
 * @var string $gmapsKey
 * @var string $metadataUrl
 */
?>
<!doctype html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= e($map['title']) ?> — Moto-Rooter</title>
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <link rel="stylesheet" href="/style/main.min.css">
</head>
<body>

  <div id="map"></div>

  <div id="info-panel" class="floating-panel">
    <button class="collapse-toggle" aria-label="Collapse panel">
      <img src="/img/icons/icon-collapse.svg" alt="Collapse" class="collapse-icon">
    </button>

    <h1 class="panel-title"><?= e($map['title']) ?></h1>

    <div class="panel-contents-wrapper">
      <div class="panel-content">
        <div class="details">
          <?php if (!empty($map['description'])): ?>
            <p class="description"><?= e($map['description']) ?></p>
          <?php endif; ?>
        </div>
        <div class="routes">
          <table class="route-table"></table>
          <label class="toggle-checkbox">
            <input type="checkbox" id="toggle-arrows" checked>
            Show Direction of Travel
          </label>
        </div>
      </div>
    </div>
  </div>

  <noscript><p style="padding:1em">JavaScript is required to view the map.</p></noscript>

  <script>window.MOTO = { metadataUrl: <?= json_encode($metadataUrl, JSON_UNESCAPED_SLASHES) ?> };</script>
  <script src="/js/main.js" defer></script>
  <script async defer
    src="https://maps.googleapis.com/maps/api/js?key=<?= e($gmapsKey) ?>&v=beta&libraries=maps,geometry&callback=initMap"
    onerror="console.error('Maps API failed to load')"></script>
</body>
</html>
