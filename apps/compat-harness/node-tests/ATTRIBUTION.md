# Attribution

Files under `node-tests/test/` are vendored verbatim from the Node.js project
(<https://github.com/nodejs/node>) at tag `v22.0.0`, the same Node version the
harness pins in `src/manifest.json` (`nodeVersion`). Node.js is licensed under
the MIT license; the license text is reproduced below as required.

Vendored files:

- `test/common/tmpdir.js`, `test/common/arraystream.js`,
  `test/common/fixtures.js` — Node's own `test/common` helpers that
  `test/parallel/*` files `require('../common/<name>')`.
- `test/parallel/test-tls-ticket.js` — shared helper required by
  `test-tls-ticket-12.js`.
- `test/parallel/test-path-*.js` — manifest test files vendored so they run
  without a network fetch (`runner.ts` falls back to raw.githubusercontent.com
  for manifest files not vendored here).
- `test/fixtures/**` — the fixture subset the manifest's failing tests need
  (`common/fixtures.js` resolves them relative to `test/fixtures`).

`test/common/index.js` and `test/common/countdown.js` are **not** vendored: the
harness writes its own faithful equivalents (see `src/test-common.ts`) because
Node's originals depend on internals (`internal/test/binding`, real `execPath`,
native addons) that cannot exist in a browser container.

---

MIT License

Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
