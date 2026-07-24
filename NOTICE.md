# Third-party notices

Besedy's own source code is licensed under the MIT License (see [LICENSE](LICENSE)).
This file attributes third-party source that Besedy **vendors** — i.e. copies or
derives into this repository — as required by those components' licenses.

## Vendored / derived source

Files under `web/src/components/ui/` include components generated from and
adapted from [shadcn/ui](https://github.com/shadcn-ui/ui), licensed under the MIT
License:

> Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Models and runtime dependencies

- **Models.** The speech, alignment, and RAG models Besedy downloads carry their
  own licenses and access terms (some gated or non-commercial) — see the
  "Third-party models & licenses" table in [README.md](README.md).
- **Runtime dependencies.** Python and JavaScript packages are installed (not
  vendored) and retain their own licenses, predominantly MIT / Apache-2.0 / BSD.
