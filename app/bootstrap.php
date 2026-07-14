<?php

declare(strict_types=1);

/**
 * Application bootstrap: autoloading, sessions, and view/response helpers.
 * Required by public/index.php (the single front controller).
 */

define('REPO_ROOT', dirname(__DIR__));
define('APP_ROOT', __DIR__);

// PSR-4 autoloader for the App\ namespace. Works without Composer (M1 needs no
// third-party libs); Composer's autoloader is layered on below when present.
spl_autoload_register(static function (string $class): void {
    $prefix = 'App\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $rel = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = APP_ROOT . '/' . $rel . '.php';
    if (is_file($file)) {
        require $file;
    }
});

// Composer autoload (league OAuth libraries) once installed — optional for M1.
$vendor = REPO_ROOT . '/vendor/autoload.php';
if (is_file($vendor)) {
    require $vendor;
}

// Sessions with hardened cookie flags. Secure flag on when served over HTTPS.
$isHttps = (($_SERVER['HTTPS'] ?? '') === 'on') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'httponly' => true,
    'samesite' => 'Lax',
    'secure'   => $isHttps,
]);

// --- Global helpers -------------------------------------------------------

/** HTML-escape a value for safe output in markup. */
function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Render a view template from app/views with the given data in scope. */
function render(string $view, array $data = []): void
{
    extract($data, EXTR_SKIP);
    require APP_ROOT . '/views/' . $view . '.php';
}

/** Emit a JSON response and stop. */
function json_response($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** Emit a bare error response and stop. */
function abort(int $status, string $message = ''): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message !== '' ? $message : ($status . ' Error');
    exit;
}
