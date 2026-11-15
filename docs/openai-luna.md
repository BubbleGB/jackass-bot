# GPT-6 Luna compatibility and rollout

Checked **15 November 2026** against current official OpenAI documentation. This is
an additive catalog change using the existing OpenAI Responses adapter, token counter,
provider router and PostgreSQL usage ledger. GPT-5.4 Mini and Google remain supported.

## Documented contract and Galaxy choices

| Item | Official contract | Galaxy behaviour |
| --- | --- | --- |
| Model ID | `gpt-6-luna`; only that alias is currently listed | Use the documented alias; do not invent a dated snapshot |
| Reasoning efforts | `none`, `low`, `medium`, `high`, `xhigh`, `max`; API default `medium` | Explicit default `low`; never send `minimal`; omit reasoning mode to retain standard execution |
| API/output | Responses supported, including structured outputs | Existing strict `text.format` JSON schema for answer/silence/refusal; tools empty, no streaming, `store:false` |
| Context/input | 1,050,000 total context; independent 922,000 maximum input | Validate actual counted input and combined input + generation; no silent truncation |
| Output | 128,000 maximum; Responses `max_output_tokens` minimum 16 | Validate model-specific bounds; retain the existing app's smaller 32,000-token configurable ceilings |
| Input counting | `POST /v1/responses/input_tokens` accepts Responses input format, including instructions and request structure | Send the same model, trusted instructions, serialized history, effort, tools, truncation setting and full JSON format/schema as generation |
| Generation accounting | `output_tokens` includes reasoning and non-visible output/formatting; cached and cache-write tokens are input breakdowns | Record reported input + output once; retain reasoning as a breakdown, never add it or cached/cache-write tokens to total again |

The counter and generation share one body builder. Only `store`, `stream` and
`max_output_tokens` are added for generation. OpenAI documents the counter as the
exact input the model will receive, including structural tokens and schemas. That
documented input-count contract is not a claim of an independently tested hard billing
cap. No character estimate or entire-context reservation is substituted.

Reservation remains counted input + the enforced generation allowance. Actual reported
usage is recorded in full even if it exceeds the estimate; exhaustion blocks further
calls without raising the configured allowance. Timeouts retain uncertainty
conservatively. Reconciliation is idempotent in the original UTC reservation bucket.
Cache pricing/write rates affect money, not the number of tokens in this ledger; the
dashboard makes no monetary billing-cap promise. Existing refusal and bounded fallback
policies are unchanged. No new tools, stored conversation or reasoning history are sent.

## Rollout and verification limits

No database migration, dependency, Compose setting or secret change is required. Existing
saved model IDs, effort values, priorities and allowances are left intact. Staff must
explicitly choose `gpt-6-luna` through the dashboard after a separately authorised
release/deployment. Its default option reads **Galaxy default (low)**, because low is
our choice rather than OpenAI's API default. Explicit choices, including `max`, persist.

All provider responses/counts in tests are mocked; isolated PostgreSQL and browser
tests verify configuration, prior Mini selections, all effort choices, request parity,
limits and settlement. No production key or paid API call validates account eligibility,
real latency, counter/generation availability or real output quality. Those remain live
checks after rollout. The published Luna alias is not a dated snapshot and can evolve.

## Official sources

- [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Create a Response](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Count input tokens](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
- [Token counting, structural tokens and output usage](https://developers.openai.com/api/docs/guides/token-counting)

The model page supplies model-specific effort and input/output limits; generic effort
enums include values such as `minimal` that Luna does not support. The Responses
reference and counting guide supply the shared request/usage field contract.
