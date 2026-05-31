// Tiny preview proxy: port 5180 → backend on 4300.
// Keeps your old localhost:5180 bookmark working.

import http from 'http';

const PROXY_PORT = 5180;
const BACKEND = 'localhost';
const BACKEND_PORT = 4300;

http.createServer((req, res) => {
    const opts = {
        hostname: BACKEND, port: BACKEND_PORT,
        path: req.url, method: req.method, headers: req.headers
    };
    const upstream = http.request(opts, (ur) => {
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
    });
    upstream.on('error', (e) => { res.writeHead(502); res.end('backend down: ' + e.message); });
    req.pipe(upstream);
}).listen(PROXY_PORT, () => console.log(`[preview-proxy] localhost:${PROXY_PORT} → localhost:${BACKEND_PORT}`));
