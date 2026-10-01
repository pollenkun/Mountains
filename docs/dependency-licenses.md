# The locked dependencies use five permissive licenses

Checked on 2026-10-01 against the project `package-lock.json` and the official npm registry metadata for each exact version. All 86 third-party package/version pairs have a declared license, and every declaration matched the registry. Workspace packages are original Mountains code and are not counted as third-party packages.

This inventory includes production dependencies, both root development dependencies (`@types/node@22.19.19` and `typescript@6.0.3`), and their transitive dependencies. It does not omit development-only entries. When the lockfile changes, regenerate this inventory and review the new versions.

The counts are MIT: 38; Apache-2.0: 35; BSD-3-Clause: 11; 0BSD: 1; Unlicense: 1. No current declaration is missing, GPL, LGPL, AGPL, or MPL. Removing the private research workspace did not remove any third-party package/version: every one remains reachable from the public workspaces or root development dependencies.

## Mountains' license does not replace an upstream license

Mountains' original code is licensed under Apache-2.0. Each third-party package retains its own license. The [ASF third-party license policy](https://www.apache.org/legal/resolved.html) lists these five license families in Category A for ASF projects. That policy is a useful reference for this review; Mountains is not an ASF project, and the policy does not waive a package's individual conditions.

If a release bundles third-party source or binaries, preserve the applicable upstream license texts and notices. A dependency list alone does not replace them:

- [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0): include the license, retain applicable attribution notices, preserve relevant upstream `NOTICE` content when present, and identify changes if upstream files were modified.
- [MIT](https://opensource.org/license/mit): retain the copyright and permission notice in copies or substantial portions.
- [BSD-3-Clause](https://opensource.org/license/bsd-3-clause): retain copyright, conditions, and disclaimer; do not use the copyright holder's or contributors' names to endorse a derived product without permission.
- [0BSD](https://spdx.org/licenses/0BSD.html) and [Unlicense](https://spdx.org/licenses/Unlicense.html): keep upstream license text available with redistributed packages, so recipients can identify its terms.

This is a metadata inventory, not an inspection of every file in each package tarball. Before a bundled release, inspect the actual included upstream `LICENSE`, `NOTICE`, and attribution files. The npm links below identify the publisher's declaration for the exact locked version.

## Exact versions and metadata sources

| Package | Locked version | Declared license | Official npm version metadata |
| --- | --- | --- | --- |
| `@anthropic-ai/sdk` | `0.124.0` | `MIT` | [npm metadata](https://registry.npmjs.org/@anthropic-ai%2Fsdk/0.124.0) |
| `@aws-sdk/client-bedrock-runtime` | `3.1127.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fclient-bedrock-runtime/3.1127.0) |
| `@aws-sdk/core` | `3.978.1` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcore/3.978.1) |
| `@aws-sdk/credential-provider-env` | `3.972.72` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-env/3.972.72) |
| `@aws-sdk/credential-provider-http` | `3.972.74` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-http/3.972.74) |
| `@aws-sdk/credential-provider-ini` | `3.973.17` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-ini/3.973.17) |
| `@aws-sdk/credential-provider-login` | `3.972.79` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-login/3.972.79) |
| `@aws-sdk/credential-provider-node` | `3.972.84` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-node/3.972.84) |
| `@aws-sdk/credential-provider-process` | `3.972.72` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-process/3.972.72) |
| `@aws-sdk/credential-provider-sso` | `3.973.16` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-sso/3.973.16) |
| `@aws-sdk/credential-provider-web-identity` | `3.972.78` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fcredential-provider-web-identity/3.972.78) |
| `@aws-sdk/eventstream-handler-node` | `3.972.35` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Feventstream-handler-node/3.972.35) |
| `@aws-sdk/middleware-eventstream` | `3.972.30` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fmiddleware-eventstream/3.972.30) |
| `@aws-sdk/middleware-websocket` | `3.972.54` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fmiddleware-websocket/3.972.54) |
| `@aws-sdk/nested-clients` | `3.997.46` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fnested-clients/3.997.46) |
| `@aws-sdk/signature-v4-multi-region` | `3.996.47` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fsignature-v4-multi-region/3.996.47) |
| `@aws-sdk/token-providers` | `3.1127.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Ftoken-providers/3.1127.0) |
| `@aws-sdk/token-providers` | `3.1138.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Ftoken-providers/3.1138.0) |
| `@aws-sdk/types` | `3.974.6` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Ftypes/3.974.6) |
| `@aws-sdk/xml-builder` | `3.972.41` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws-sdk%2Fxml-builder/3.972.41) |
| `@aws/lambda-invoke-store` | `0.3.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@aws%2Flambda-invoke-store/0.3.0) |
| `@babel/runtime` | `7.29.7` | `MIT` | [npm metadata](https://registry.npmjs.org/@babel%2Fruntime/7.29.7) |
| `@earendil-works/pi-ai` | `0.87.1` | `MIT` | [npm metadata](https://registry.npmjs.org/@earendil-works%2Fpi-ai/0.87.1) |
| `@earendil-works/pi-telemetry` | `0.87.1` | `MIT` | [npm metadata](https://registry.npmjs.org/@earendil-works%2Fpi-telemetry/0.87.1) |
| `@google/genai` | `2.21.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@google%2Fgenai/2.21.0) |
| `@protobufjs/aspromise` | `1.1.2` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Faspromise/1.1.2) |
| `@protobufjs/base64` | `1.1.2` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Fbase64/1.1.2) |
| `@protobufjs/codegen` | `2.0.5` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Fcodegen/2.0.5) |
| `@protobufjs/eventemitter` | `1.1.1` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Feventemitter/1.1.1) |
| `@protobufjs/fetch` | `1.1.1` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Ffetch/1.1.1) |
| `@protobufjs/float` | `1.0.2` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Ffloat/1.0.2) |
| `@protobufjs/path` | `1.1.2` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Fpath/1.1.2) |
| `@protobufjs/pool` | `1.1.0` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Fpool/1.1.0) |
| `@protobufjs/utf8` | `1.1.2` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/@protobufjs%2Futf8/1.1.2) |
| `@smithy/core` | `3.35.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Fcore/3.35.0) |
| `@smithy/credential-provider-imds` | `4.5.2` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Fcredential-provider-imds/4.5.2) |
| `@smithy/fetch-http-handler` | `5.8.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Ffetch-http-handler/5.8.0) |
| `@smithy/node-http-handler` | `4.12.1` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Fnode-http-handler/4.12.1) |
| `@smithy/signature-v4` | `5.7.3` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Fsignature-v4/5.7.3) |
| `@smithy/types` | `4.19.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/@smithy%2Ftypes/4.19.0) |
| `@stablelib/base64` | `1.0.1` | `MIT` | [npm metadata](https://registry.npmjs.org/@stablelib%2Fbase64/1.0.1) |
| `@types/node` | `22.19.19` | `MIT` | [npm metadata](https://registry.npmjs.org/@types%2Fnode/22.19.19) |
| `@types/retry` | `0.12.0` | `MIT` | [npm metadata](https://registry.npmjs.org/@types%2Fretry/0.12.0) |
| `agent-base` | `7.1.4` | `MIT` | [npm metadata](https://registry.npmjs.org/agent-base/7.1.4) |
| `agent-base` | `9.0.0` | `MIT` | [npm metadata](https://registry.npmjs.org/agent-base/9.0.0) |
| `base64-js` | `1.5.1` | `MIT` | [npm metadata](https://registry.npmjs.org/base64-js/1.5.1) |
| `bignumber.js` | `9.3.1` | `MIT` | [npm metadata](https://registry.npmjs.org/bignumber.js/9.3.1) |
| `bowser` | `2.14.1` | `MIT` | [npm metadata](https://registry.npmjs.org/bowser/2.14.1) |
| `buffer-equal-constant-time` | `1.0.1` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/buffer-equal-constant-time/1.0.1) |
| `data-uri-to-buffer` | `4.0.1` | `MIT` | [npm metadata](https://registry.npmjs.org/data-uri-to-buffer/4.0.1) |
| `debug` | `4.4.3` | `MIT` | [npm metadata](https://registry.npmjs.org/debug/4.4.3) |
| `ecdsa-sig-formatter` | `1.0.11` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/ecdsa-sig-formatter/1.0.11) |
| `extend` | `3.0.2` | `MIT` | [npm metadata](https://registry.npmjs.org/extend/3.0.2) |
| `fast-sha256` | `1.3.0` | `Unlicense` | [npm metadata](https://registry.npmjs.org/fast-sha256/1.3.0) |
| `fetch-blob` | `3.2.0` | `MIT` | [npm metadata](https://registry.npmjs.org/fetch-blob/3.2.0) |
| `formdata-polyfill` | `4.0.10` | `MIT` | [npm metadata](https://registry.npmjs.org/formdata-polyfill/4.0.10) |
| `gaxios` | `7.3.1` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/gaxios/7.3.1) |
| `gcp-metadata` | `8.1.2` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/gcp-metadata/8.1.2) |
| `google-auth-library` | `10.9.1` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/google-auth-library/10.9.1) |
| `google-logging-utils` | `1.1.3` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/google-logging-utils/1.1.3) |
| `http-proxy-agent` | `9.1.0` | `MIT` | [npm metadata](https://registry.npmjs.org/http-proxy-agent/9.1.0) |
| `https-proxy-agent` | `7.0.6` | `MIT` | [npm metadata](https://registry.npmjs.org/https-proxy-agent/7.0.6) |
| `https-proxy-agent` | `9.1.0` | `MIT` | [npm metadata](https://registry.npmjs.org/https-proxy-agent/9.1.0) |
| `json-bigint` | `1.0.0` | `MIT` | [npm metadata](https://registry.npmjs.org/json-bigint/1.0.0) |
| `json-schema-to-ts` | `3.1.1` | `MIT` | [npm metadata](https://registry.npmjs.org/json-schema-to-ts/3.1.1) |
| `jwa` | `2.0.1` | `MIT` | [npm metadata](https://registry.npmjs.org/jwa/2.0.1) |
| `jws` | `4.0.1` | `MIT` | [npm metadata](https://registry.npmjs.org/jws/4.0.1) |
| `long` | `5.3.2` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/long/5.3.2) |
| `ms` | `2.1.3` | `MIT` | [npm metadata](https://registry.npmjs.org/ms/2.1.3) |
| `node-domexception` | `1.0.0` | `MIT` | [npm metadata](https://registry.npmjs.org/node-domexception/1.0.0) |
| `node-fetch` | `3.3.2` | `MIT` | [npm metadata](https://registry.npmjs.org/node-fetch/3.3.2) |
| `openai` | `6.40.0` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/openai/6.40.0) |
| `p-retry` | `4.6.2` | `MIT` | [npm metadata](https://registry.npmjs.org/p-retry/4.6.2) |
| `partial-json` | `0.1.7` | `MIT` | [npm metadata](https://registry.npmjs.org/partial-json/0.1.7) |
| `protobufjs` | `7.6.6` | `BSD-3-Clause` | [npm metadata](https://registry.npmjs.org/protobufjs/7.6.6) |
| `proxy-agent-negotiate` | `1.1.0` | `MIT` | [npm metadata](https://registry.npmjs.org/proxy-agent-negotiate/1.1.0) |
| `retry` | `0.13.1` | `MIT` | [npm metadata](https://registry.npmjs.org/retry/0.13.1) |
| `safe-buffer` | `5.2.1` | `MIT` | [npm metadata](https://registry.npmjs.org/safe-buffer/5.2.1) |
| `standardwebhooks` | `1.1.1` | `MIT` | [npm metadata](https://registry.npmjs.org/standardwebhooks/1.1.1) |
| `ts-algebra` | `2.0.0` | `MIT` | [npm metadata](https://registry.npmjs.org/ts-algebra/2.0.0) |
| `tslib` | `2.8.1` | `0BSD` | [npm metadata](https://registry.npmjs.org/tslib/2.8.1) |
| `typebox` | `1.3.27` | `MIT` | [npm metadata](https://registry.npmjs.org/typebox/1.3.27) |
| `typescript` | `6.0.3` | `Apache-2.0` | [npm metadata](https://registry.npmjs.org/typescript/6.0.3) |
| `undici-types` | `6.21.0` | `MIT` | [npm metadata](https://registry.npmjs.org/undici-types/6.21.0) |
| `web-streams-polyfill` | `3.3.3` | `MIT` | [npm metadata](https://registry.npmjs.org/web-streams-polyfill/3.3.3) |
| `ws` | `8.21.3` | `MIT` | [npm metadata](https://registry.npmjs.org/ws/8.21.3) |
