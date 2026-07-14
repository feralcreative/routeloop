<?php

declare(strict_types=1);

/**
 * Router script for the PHP built-in dev server (mirrors the Apache .htaccess
 * front-controller rewrite):
 *
 *   php -S 127.0.0.1:6686 -t public public/router.php
 *
 * Existing static files under public/ are served directly; everything else is
 * routed through index.php.
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = __DIR__ . $path;

if ($path !== '/' && is_file($file)) {
    return false; // let the built-in server serve the static asset
}

require __DIR__ . '/index.php';
