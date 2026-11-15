# GPT-6 Luna support plan

Goal: add `gpt-6-luna` through the existing OpenAI Responses/counting/accounting path;
Galaxy default effort `low`, without changing existing saved model/effort/allowances.

Official evidence checked 15 November 2026: OpenAI model page, Responses create/count
references and token-counting/reasoning guides. Luna efforts none/low/medium/high/xhigh/max;
API default medium; context 1,050,000, input maximum 922,000, output maximum 128,000;
Responses max_output_tokens minimum 16. Supports strict structured outputs. Counting
shares token-bearing generation fields; cached/reasoning/cache-write breakdowns are not
additional usage. Keep revised practical-allowance policy and full settlement.

- [x] Write focused unit/configuration/PG settlement/browser regressions; observe RED.
- [x] Add catalog entry and model-specific input/context/output validation, remove the
  OpenAI counter's hard-coded Mini limit. Reuse body builder/adapter/ledger. Preserve
  Mini and Google. Label the dashboard default as Galaxy's, not the API's default.
- [x] Verify saved Mini selections remain unchanged, Luna requires explicit selection,
  all six effort choices/default appear and persist, invalid effort fails closed.
- [ ] Document official sources, aliases/limits and rollout; full checks, one independent
  review/fix pass, commit/push/PR and AMD64/native ARM64 CI; leave unmerged.

Review focus: never silently switch stored model, effort or allowance; counter/generation
request parity; independent maximum input vs shared context/output bound; no cached or
reasoning double-count; uncertain settlement/exhaustion; unsupported effort/minimum cap;
no production calls, keys, registry publication, VPS or rollout.
