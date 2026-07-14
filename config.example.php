<?php

/**
 * Moto-Rooter configuration template.
 *
 * COPY this file to a location OUTSIDE the web root and fill in real values.
 * In production on DreamHost this lives at /home/USER/moto-config/config.php
 * (a sibling of the git checkout, never web-served, never committed).
 *
 * app/Config.php resolves the active config from, in order:
 *   1. the MOTO_CONFIG environment variable (absolute path), then
 *   2. ../moto-config/config.php relative to the repo root, then
 *   3. ./config.local.php in the repo root (git-ignored) for local dev.
 *
 * This file returns a plain PHP array. Do NOT put real secrets in the repo.
 */

return [
    // Absolute public base URL, no trailing slash. Used to build OAuth
    // redirect URIs and share links.
    'app_url' => 'https://moto-rooter.example.com',

    // MySQL connection.
    'db' => [
        'host'    => 'localhost',
        'name'    => 'moto_rooter',
        'user'    => 'moto_user',
        'pass'    => 'CHANGE_ME',
        'charset' => 'utf8mb4',
    ],

    // Google OAuth (console.cloud.google.com → Credentials → OAuth client ID).
    // Authorized redirect URI must be {app_url}/auth/google/callback
    'google' => [
        'client_id'     => '',
        'client_secret' => '',
    ],

    // GitHub OAuth (github.com → Settings → Developer settings → OAuth Apps).
    // Authorization callback URL must be {app_url}/auth/github/callback
    'github' => [
        'client_id'     => '',
        'client_secret' => '',
    ],

    // Cloudflare Turnstile (dash.cloudflare.com → Turnstile). Free.
    // Site key is public (rendered in the page); secret key stays server-side.
    'turnstile' => [
        'site_key'   => '',
        'secret_key' => '',
    ],

    // Google Maps JavaScript API browser key. This IS exposed in page source;
    // protect it with HTTP-referrer + API restrictions in the GCP console.
    'gmaps_key' => '',

    // Absolute path to the private storage root for user KML/GPX files.
    // MUST be outside the web root. On DreamHost: /home/USER/moto-storage
    'storage_path' => '/home/USER/moto-storage',

    // Default per-user storage quota in bytes (250 MB).
    'default_quota_bytes' => 262144000,
];
