# Google reservation investigation and revised design — 13 November 2026

PR #3 remains unmerged. The user explicitly revised allowances to practical usage safeguards
and superseded the old reject-unbounded-model rule in the [handoff](galaxy-neegy-handoff.md).
Both providers and their selected models remain. No paid inference, live token count,
production key, VPS access or deployment was used.

## Why the previous request needed 1,050,624 tokens

The superseded implementation reserved `1,048,576 model input limit + 2,048 generation cap`.
It used the entire context capacity rather than the actual request. Both the Google adapter
and repository admission prefilter enforced that floor. This was an engineering fallback
under the former strict-bound requirement, never a Google requirement or a short prompt's
actual cost. Both full-window admission sites have now been removed.

## Revised request-based reservation

1. Build the actual Interactions body once through a shared deterministic builder.
2. POST to `v1beta/models/gemini-3.5-flash-lite:countTokens` using the documented
   `generateContentRequest` form. Project the actual `system_instruction` to
   `systemInstruction.parts`, and the entire serialized context/history to user text.
   This includes the mode, bot instructions, saved personality, supplied history text,
   authors, IDs and timestamps. No input is replaced by a shorter user-only sample.
3. Include `JSON.stringify(response_format)` as another **count-only** text part. This
   includes MIME/type metadata and the entire structured-output schema. It is a tokenizer
   proxy for native schema handling, not an assertion that native schema compilation uses
   this representation or exactly this many tokens. It is not duplicated in generation text.
4. Reserve `count + max(32, ceil(count * 0.10)) + maxGenerationTokens`. The margin is an
   **engineering estimate**, not a guaranteed upper bound. It allows some room for API
   framing/schema differences; its adequacy has not been measured using live calls.
5. Keep byte/message/instruction and model/context checks. The count plus margin plus
   generation ceiling must fit the existing conservative catalog context check. This is
   an estimated fit check; Google still enforces its own model limits. Task 4's configured
   history-token selection is not implemented here.
6. Atomically admit only if known + uncertain + reserved + new estimate <= daily allowance.
   The cheap repository filter needs at least the generation ceiling before counting; it
   does not reserve an entire context window. The ledger is authoritative after races.

The unchanged Interactions request enforces `generation_config.max_output_tokens`, with
no tools, streaming, background execution, reasoning summaries or retained remote history.
A failed/malformed count prevents generation rather than falling back to a guessed count.
Count calls do not increment generation-attempt counters; they remain subject to transport
errors, quotas and the shared 60-second attempt deadline.

## Documented contracts versus engineering assumptions

| Item | Official evidence | Limit of the claim |
| --- | --- | --- |
| Model capacity | [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): 1,048,576 input, 65,536 output | Capacity is not the size or cost of this request |
| Token counting | [countTokens reference](https://ai.google.dev/api/tokens): native tokenizer, contents or generateContentRequest | No verified exact counter for all Interactions-native framing/schema representation |
| Full input | [Interactions token guide](https://ai.google.dev/gemini-api/docs/interactions/tokens): count input before sending, system instructions count as input; inspect reported usage afterward | Counting user text alone would omit instructions/history/schema |
| Schema proxy | Serialize and tokenize the complete response format alongside actual text | Our engineering projection, not a documented native schema count or upper bound |
| Margin | max(32 tokens, 10% rounded up) | Engineering estimate only; can still underestimate |
| Generation cap | [Thinking guide](https://ai.google.dev/gemini-api/docs/thinking): max_output_tokens is an infrastructure-enforced combined thought/output cutoff | Does not cap input; do not add thinking again |
| Effort | Same guide: minimal/low/medium/high, dynamic thinking | Minimal is not thinking-off or a numeric thinking budget |
| Input enforcement | [Interactions reference](https://ai.google.dev/api/interactions-api): output controls and model input capacity | No verified request-level max_input_tokens control for a smaller hard billing bound |

Gemini 3 input and output budgets are separate; this implementation retains the stricter
existing combined context-fit check. It does not substitute newer Gemini 4 rules. Google
examples and forum discussions do not establish universal count/usage equality. We no
longer require such equality to support a model, and do not describe estimates as guarantees.

## Short-request example and small allowances

Example fixture: a context entry containing `Hi`, current saved instructions and complete
output schema, default 2,048 total generation limit, with **mocked** tokenizer result 120.
The revised reservation is **120 + 32 + 2,048 = 2,200 tokens**. The 120 is a synthetic
counter response, not a live measurement or prediction for `Hi`; the 32 is an engineering
margin. Only the combined generation limit has the documented hard enforcement described
above. A real request uses its actual counter response in this formula.

| Remaining allowance | Fixture result |
| --- | --- |
| 100 / 1,000 | Skip before counting because generation cap alone cannot fit |
| 2,048 / 2,199 | Count request, then deny reservation; no generation |
| 2,200 / 5,000 | Reserve 2,200, then generate |
| 2,200 allowance minus one known/uncertain/reserved token | Deny the 2,200 reservation |
| 500 with explicitly configured 256 generation cap | Reserve 120 + 32 + 256 = 408 |

Known fixture usage of 20 input + 6 visible output + 4 thoughts settles to 30, releasing
unused headroom. A timeout retains 408 uncertain tokens in the 500-token case and leaves
only 92 available, preventing another such call even after provider backoff expires.
The allowance remains unchanged throughout. Lower generation ceilings require an explicit
staff setting and can truncate answers/thinking; they are not silently adjusted for funding.

## Overshoot, settlement and exhaustion

Reported actual usage replaces the estimate in full, even above reservation or allowance.
Underestimation logs only `usage_estimate_exceeded` with identifiers, not keys/conversation.
It does not permanently disable healthy configuration. New admission includes the full
actual amount plus all outstanding/uncertain charges. Exhaustion blocks further calls.

For example, allowance 100 admits two concurrent reservations of 40 each. If each reports
60 actual tokens, settlement records 120, not 80 or 100. No third call is admitted afterward;
already in-flight calls may still complete. This is an expected overshoot risk under the
revised policy. Settlement is idempotent and stays in the reservation's original UTC date,
including verified reports replacing uncertain charges after midnight. New-day allowance
is independent. No automatic allowance increases, automatic refunds of unknown usage or
provider billing-cap promises are made. Timeout charges are conservative estimates, not
proof of the maximum usage incurred remotely.

## OpenAI audit

The [official token-counting guide](https://developers.openai.com/api/docs/guides/token-counting)
describes `/v1/responses/input_tokens` as exact for input, including request formatting and
schemas. The [generated request types](https://github.com/openai/openai-node/blob/master/src/resources/responses/input-tokens.ts)
accept the fields used here. Counting and generation share model, complete instructions,
serialized context, reasoning effort, empty tools, disabled truncation and full text format/
schema. A regression compares every field, excluding only generation's store, stream and
max_output_tokens controls. No remote conversation or previous response can add hidden input.

OpenAI reservation remains the documented counter result + combined generation cap, with
no extra engineering margin. This verifies our payload coverage against the documentation;
mocks do not prove real model acceptance or final metered usage. Both providers use the
same honest full-actual reconciliation, uncertain-timeout treatment and exhaustion checks.
Practical allowances are not guaranteed hard token or monetary billing caps for either.
