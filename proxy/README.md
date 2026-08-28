# The blue/green proxy

`Caddyfile` is committed and shipped on every deploy.

`upstream.caddy` is **not committed**. It lives on the NAS at `<deploy path>/proxy/upstream.caddy`, holds one line, and is the single source of truth for which color is live—it is literally what Caddy is serving. `upstream.caddy.example` shows the shape.

Reading it is how `utils/deploy/lib.sh` answers "which color is live". Do not add a second marker anywhere; a second answer is an answer that can disagree.

To move traffic by hand:

```bash
DEPLOY_ENV=prod utils/deploy/deploy-utils.sh cutover green
```

That rewrites the file, validates the config, reloads, and verifies—refusing if the target is not running and healthy.
