<?php

declare(strict_types=1);

namespace App;

/**
 * Minimal method + path-pattern router. Patterns use {name} placeholders that
 * match a single path segment and are passed to the handler as a named array.
 */
final class Router
{
    /** @var array<int,array{0:string,1:string,2:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $this->routes[] = [strtoupper($method), $pattern, $handler];
    }

    public function get(string $p, callable $h): void { $this->add('GET', $p, $h); }
    public function post(string $p, callable $h): void { $this->add('POST', $p, $h); }
    public function patch(string $p, callable $h): void { $this->add('PATCH', $p, $h); }
    public function delete(string $p, callable $h): void { $this->add('DELETE', $p, $h); }

    public function dispatch(string $method, string $path): void
    {
        $method = strtoupper($method);
        foreach ($this->routes as [$m, $pattern, $handler]) {
            if ($m !== $method) {
                continue;
            }
            if (preg_match($this->compile($pattern), $path, $matches)) {
                $params = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
                $handler($params);
                return;
            }
        }
        abort(404, 'Not found');
    }

    private function compile(string $pattern): string
    {
        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/',
            static fn (array $m): string => '(?P<' . $m[1] . '>[^/]+)',
            $pattern
        );
        return '#^' . $regex . '$#';
    }
}
