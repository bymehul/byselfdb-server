# security & implementation

boring stuff. here's exactly how we keep things locked down.

## 1. sessions

we chose an **in-memory** architecture for a specific reason: this is a "bring your own database" tool, not a saas with user accounts.

### in-memory store
we use a native javascript `Map`.
- **zero persistence** · nothing is ever written to disk. if the server is seized, there is no database of sessions to inspect.
- **performance** · O(1) lookups. it's just a hash map.
- **isolation** · sessions exist only in the ram of the running process.

### entropy & generation
we don't write our own crypto.
- **id format** · 64-character hexadecimal string.
- **source** · `crypto.randomBytes(32)` uses the os entropy pool (csprng).
- **collision math** · $1/2^{256}$ chance. effectively impossible.

### cookie attributes
we set these flags hard. no configuration options to disable them.
- `HttpOnly` · prevents cross-site scripting (xss) from stealing the session id.
- `SameSite=Strict` · provides the highest level of protection since frontend and backend share the same custom domain.
- `Secure` · browser won't send the cookie over http. requires tls/ssl (enforced in prod).
- `Max-Age` · 86400 seconds (24 hours).

### lifecycle mgmt
- **validation** · `authMiddleware` checks presence + expiry on every single protected route.
- **auto-cleanup** · a `setInterval` runs every 5 minutes to sweep expired keys, preventing memory leaks.
- **nuclear method** · `destroyAllSessions()` is hooked into `SIGTERM` and `SIGINT`. if the server shuts down, every session is instantly killed.

## 2. ssrf protection

server-side request forgery is the biggest risk in a proxy app. we treat all user input as hostile.

### the deny list
we explicitly block connections to non-public space. you cannot use byselfdb to scan your internal network.
- **localhost** · `127.0.0.1`, `::1`, `localhost`.
- **private ipv4** · `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
- **cgnat** · `100.64.0.0/10`.
- **cloud metadata** · `169.254.169.254` (prevents aws/gcp/azure credential theft).
- **test nets** · `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`.

### dns resolution strategy
attackers try to bypass lists using dns (e.g., `localtest.me` resolves to `127.0.0.1`).
we defeat this by:
1. doing a dns lookup (`dns.promises.lookup`) on the input hostname.
2. checking the *resolved ip address* against our deny list.
3. strictly allowing only `mongodb:` and `mongodb+srv:` protocols.

## 3. rate limiting

we use `express-rate-limit` to layer defenses against abuse and brute-force.

### tiers
- **api global** · 100 req / 15 min. prevents general flooding.
- **connection endpoint** · 5 attempts / hour. this is strict. it prevents someone from using your server to brute-force mongodb passwords.
- **mutations** · 50 writes / minute. prevents rapid-fire inserts/updates/deletes if a session is compromised.

## 4. injection defense

byselfdb is a direct proxy for your queries, which is dangerous. we sanitize everything.

### recursive sanitization
before any filter or update reaches the database driver, it passes through `sanitizeFilter`.
- **recursion** · we traverse deeply nested objects/arrays.
- **operator blocking** · we remove prohibited operators starting with `$`.
- **javascript execution** · we strictly block `$where`, `$expr`, `$function`, and `$accumulator`. these specialized operators can execute arbitrary js on the database server.
- **bypasses** · we validate that keys are strings, blocking prototype pollution attacks.

## 5. connection architecture

### pooling via hashing
we don't open a new connection for every request. that would be slow.
- we hash the full connection uri (including credentials).
- `Map<string, MongoClient>` stores active clients.
- if user A and user B connect with the *exact same string*, they share a pool (efficient).
- if user A and user B differ by even one character, they get isolated pools.

### graceful shutdown
when the server receives a kill signal:
1. http server stops accepting new tcp connections.
2. session sweeper is stopped.
3. we iterate through the client map and call `close()` on every mongodb connection.
4. we explicitly clear the session map.
5. process exits with code 0.

## 6. cors configuration

cross-origin resource sharing is your first line of defense in the browser.

- **wildcards** · forbidden in production. we check `process.env.NODE_ENV`.
- **origin check** · we use the `cors` middleware to strictly whitelist `CORS_ORIGIN`.
- **credentials** · `credentials: true` is enabled, which requires an explicit origin (cannot be `*`). this prevents random sites from making authenticated requests on your behalf.
