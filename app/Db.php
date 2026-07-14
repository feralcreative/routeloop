<?php

declare(strict_types=1);

namespace App;

use PDO;

/** Lazy PDO singleton for the app database. */
final class Db
{
    private static ?PDO $pdo = null;

    public static function conn(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $db = Config::get('db', []);
        $dsn = sprintf(
            'mysql:host=%s;dbname=%s;charset=%s',
            $db['host'] ?? '127.0.0.1',
            $db['name'] ?? '',
            $db['charset'] ?? 'utf8mb4'
        );

        self::$pdo = new PDO($dsn, $db['user'] ?? '', $db['pass'] ?? '', [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);

        return self::$pdo;
    }
}
