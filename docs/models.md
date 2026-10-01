# Model adapters exist; live provider behavior still needs checking

The repository contains Chat Completions adapter paths for DeepSeek, GLM, and Kimi. Their unit tests use local fixtures. This preparation did not use live accounts or confirm current model availability, prices, or service limits.

| Provider | Registered model in this snapshot | Key environment variable | Thinking configuration | Cost currency |
| --- | --- | --- | --- | --- |
| DeepSeek | `deepseek-flash` | `DEEPSEEK_API_KEY` | enabled, `low` / `high` / `max` or `default` | USD |
| Zhipu BigModel | `glm-5.3-flash` | `ZHIPU_API_KEY` | enabled, typically `max`; `default` omits an explicit effort | CNY |
| Moonshot | `kimi-k2.7-code` | `MOONSHOT_API_KEY` | must be enabled, effort `default` | CNY |

These identifiers and options describe the checked-in capability table. A model alias may route to different weights later. Do not interpret a local table entry as a provider availability promise.

The default endpoints in the code are `https://api.deepseek.com`, `https://open.bigmodel.cn/api/paas/v4`, and `https://api.moonshot.cn/v1`. Check your provider's current account documentation before a live run: [DeepSeek](https://api-docs.deepseek.com/), [BigModel](https://docs.bigmodel.cn/), and [Moonshot](https://platform.moonshot.cn/docs/intro). An endpoint override does not grant permission to send a provider key to an untrusted host.

For GLM, override both `model` and `thinking.effort`; set a CNY `MOUNTAINS_BUDGET`. For Kimi, use:

```json
{
  "model": "kimi-k2.7-code",
  "thinking": { "enabled": true, "effort": "default" }
}
```

Kimi does not use the DeepSeek effort strings. Provider-specific response usage is normalized, but absent usage remains partial. Costs use the repository's versioned rate table, not an invoice.

The provider package exposes an exact-input adapter and the engine has an exact-preflight API. **The CLI does not wire that exact-preflight option.** Enabling CLI `requestGuard` is budget reservation and conservative checking, not a promise of an exact tokenizer limit. GLM and Kimi exact input counting has not been calibrated by this preparation.

The main CLI permits a loopback proxy to supply its own authorization when no key is set. This is intended for a trusted local proxy and is not a reason to leave an external endpoint unauthenticated. Approval models use independent credentials; see [approvals](approvals.md).
