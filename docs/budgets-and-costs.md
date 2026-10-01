# A spending cap uses local estimates, not provider invoices

`limits.maxCost` caps a task in the task model's currency. `MOUNTAINS_BUDGET` supplies the shared spending limit in that currency. DeepSeek uses USD; GLM and Kimi use CNY in this snapshot. USD also accepts legacy `MOUNTAINS_BUDGET_USD`, then defaults to 5 when no valid positive cap is supplied. CNY requires an explicit valid cap. Set a cap deliberately before any live run.

The spending record defaults to `~/.mountains/spend.jsonl`. It persists across runs. Do not erase a record merely to bypass a cap. Independent tasks must not share a currency incorrectly. A held or stale lock fails closed; investigate it rather than deleting it while another run is active.

## Reservation protection is optional by default

Without `requestGuard`, the existing path checks limits and accounts for returned usage, but a request already in flight can add cost. Do not describe this as an exact provider-side prepaid cap.

With `requestGuard`, a request reserves a conservative cost allowance before submission, then settles returned usage. Enabling model approval also enables this protection. Main and approval requests share the root budget, and approval requests have their own sublimit. A conservative reservation may refuse a request whose eventual cost would have been lower.

Unknown, inconsistent, cancelled, or failed usage is not silently priced at zero. The guarded path conservatively settles uncertain cost against its reservation and stops rather than treating that allowance as safely reusable. Missing fields are marked partial in request records.

Limits also cover turns, aggregate input and output, optional request count, and optional elapsed duration. Failed attempts and retries still matter. A smaller output allowance can make a task cheaper to reserve, but can also prevent completion.

## Rate snapshots can become outdated

`packages/providers/src/pricing.ts` contains versioned rates and time-of-day rules. The code distinguishes uncached input, cached input, cache writes where relevant, and output. It does not perform automatic provider invoice reconciliation or automatic exchange-rate lookup.

Provider discounts, holiday pricing, cache-storage charges, aliases, and service policies can change. Some special pricing is not modeled; estimates must not be advertised as exact bills or guaranteed upper bounds under future price changes. Check current provider terms before running, update rate metadata with tests when needed, and reconcile significant spending against the provider account.

Run directories store summary and per-request accounting with model, raw usage, price version, partial flags, timing, and request hash where available. They may also contain task text and source. Keep them private unless reviewed and explicitly approved for sharing.
