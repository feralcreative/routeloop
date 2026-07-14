<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

use App\Router;
use App\Controllers\PageController;
use App\Controllers\PublicController;

$router = new Router();
$page   = new PageController();
$public = new PublicController();

// Pages
$router->get('/', [$page, 'home']);
$router->get('/m/{slug}', [$page, 'viewMap']);

// Public API (viewer data sources)
$router->get('/api/public/maps/{slug}', [$public, 'metadata']);
$router->get('/api/public/maps/{slug}/kml', [$public, 'kml']);
$router->get('/api/public/maps/{slug}/gpx', [$public, 'gpx']);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

$router->dispatch($method, rawurldecode($path));
