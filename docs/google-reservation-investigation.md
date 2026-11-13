# Google reservation investigation — 13 November 2026

PR #3 remains unmerged. This follow-up changes documentation and regression tests only.
No model/API/provider enablement, allowance or admission behavior has been changed.
No paid inference, live token count, production key, VPS or deployment was used.

## Why a single short request asks for 1,050,624 tokens

The current calculation is:

`reservation = 1,048,576 model input limit + 2,048 configured generation cap = 1,050,624`.

This uses **the model's maximum input capacity**, not a count of the actual request.
`GoogleAdapter.estimateUsage` returns that constant plus `maxGenerationTokens` and never
calls countTokens. `PostgresProviderRepository.load` uses the same floor to exclude Google
before estimation if remaining headroom is smaller. Removing only the adapter constant
would not fix admission, because the repository filter would still reject small budgets.

Available headroom is `daily allowance - known usage - uncertain usage - live reservations`.
A request does not increase the user's allowance. The temporary reservation is replaced
by known usage on settlement; a timeout or missing usage retains the conservative charge.

The configured 8,000-token context ceiling is not a provider-enforced input cap and does
not include every instruction/schema/framing token by definition. Task 4's context builder
has not been implemented. The adapter's byte/message-count guards bound request size, but
no documented conversion from those guards to a smaller Gemini metered-token maximum was
established. They cannot be substituted for a proven input-token bound.

This full-window choice was an engineering fallback, **not a Google requirement that a
short prompt costs a million tokens**. It is unnecessarily large for normal actual input,
but the evidence reviewed below does not establish a smaller strict upper bound for the
complete request. It is retained rather than silently replacing it with a heuristic.

## Documented contracts versus assumptions

| Item | Evidence and what it establishes | What it does not establish |
| --- | --- | --- |
| Model capacity | [Gemini 3.5 Flash-Lite card](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): 1,048,576 input and 65,536 output tokens | Actual size of a particular prompt |
| Counting | [countTokens reference](https://ai.google.dev/api/tokens): runs the tokenizer; accepts contents or a full generateContentRequest including steering information | A stated upper-bound inequality against all subsequently metered input, or an exact counter for this complete Interactions/schema payload |
| System instructions | [Interactions token guide](https://ai.google.dev/gemini-api/docs/interactions/tokens): system instructions are input tokens | That counting only user contents covers instructions, schema and framing |
| Output and thinking cap | [Interactions thinking guide](https://ai.google.dev/gemini-api/docs/thinking): max_output_tokens is a hard combined thought/output cutoff | An input-token cap |
| generateContent alternative | [Dedicated generateContent thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking) also documents a hard combined cutoff (REST maxOutputTokens) | That switching APIs makes its countTokens result a guaranteed upper bound |
| Effort | Same thinking guide: Gemini 3.5 Flash-Lite supports minimal/low/medium/high; minimal does not guarantee thinking is off | A zero-thinking or fixed numeric thinking budget for this model |
| Input enforcement | The reviewed [Interactions API reference](https://ai.google.dev/api/interactions-api) provides output controls; no request-level input cap was found | A supported max_input_tokens field that can enforce a smaller admission bound |

The 2,048 generation cap already includes thinking. Adding another thinking allowance on
top of it would double-reserve that component. Changing effort can reduce typical usage,
but does not resolve the input bound. Gemini 3 and 2.5 have separate input/output budgets;
the newer Gemini 4 shared-context rules should not be substituted for this model's card.

Google's [countTokens API examples](https://ai.google.dev/api/tokens) show a contents-only
count of 10 alongside later promptTokenCount of 11. This is a warning against assuming
universal equality, not proof that the same mismatch occurs for every full request.
The reference describes what is counted, but does not state `countTokens.totalTokens >=
subsequent metered input` for our exact Interactions request.

## Google-hosted clarification and remaining uncertainty

The Google developer forum provides useful additional discussion, but is not a substitute
for an explicit API guarantee:

- [22 October answer](https://discuss.ai.google.dev/t/gemini-api-counttokens/188451)
  says full generateContentRequest counting includes contents/system/tools/cache but
  excludes JSON output schemas in generationConfig.
- [28 October model-specific answer](https://discuss.ai.google.dev/t/gemini-3-5-flash-lite-counttokens-pricing-quota-schema-coverage-and-thinking-cap/189068/2)
  says Gemini 3.5 Flash-Lite counting includes structured schema tokens and the output
  cap includes thinking. These coverage descriptions differ across the two threads.
- The [5 November follow-up](https://discuss.ai.google.dev/t/gemini-3-5-flash-lite-counttokens-pricing-quota-schema-coverage-and-thinking-cap/189068/4)
  was asked specifically whether the full unchanged request count upper-bounds prompt
  usage/TPM and whether a model-specific adjustment exists. It redirects to the general
  docs and does not supply that inequality or adjustment.

I therefore cannot turn a sample count plus one token, a percentage margin, characters/4,
or a JSON-byte estimate into a documented hard input bound. Counting a schema separately
and adding it also needs a guarantee about how it is incorporated and framed. Running
paid experiments would not establish such a guarantee, and none were run.

For a short example with a mocked count of 120 and a 2,048 cap, `120 + 2,048 = 2,168`
is an attractive estimate. It is **not adopted as a strict reservation**: 120 is synthetic,
no live count was measured, and the needed complete-input upper-bound contract is missing.

## Result for the short example and small allowances

Example: one human context entry containing `Hi`, default saved personality, model
`gemini-3.5-flash-lite`, minimal effort and a 2,048 combined output cap.
The implementation still reserves **1,050,624 tokens**, irrespective of the short text.

Regression fixtures verify the following with real isolated PostgreSQL and mocked HTTP:

| Remaining headroom | Result |
| --- | --- |
| 100 / 1,000 / 2,048 / 5,000 / 50,000 | Skip Google; no HTTP call or reservation; allowance unchanged |
| 1,050,623 | Skip Google; no HTTP call or reservation; allowance unchanged |
| 1,050,624 | Reserve 1,050,624 before the mocked generation call |
| 1,050,624 allowance minus one known/uncertain/reserved token | Insufficient remaining headroom; skip |

In the positive fixture the mocked response reports 20 input, 6 visible output and
4 thinking tokens. Settlement records **30 total tokens**, releases the reservation,
and leaves the configured allowance unchanged. Those are fixture values, not a real
measurement or forecast for `Hi`. Missing/uncertain usage still retains the full charge.

## Supported options and trade-offs before changing behavior

1. **Retain this Google path:** preserve the documented-capacity fallback and strict local
   admission behavior. Cost: poor usability for small allowances. No automatic increase
   in allowances is made or recommended as a hidden workaround.
2. **Use the already supported OpenAI path:** the [OpenAI input-count guide](https://developers.openai.com/api/docs/guides/token-counting)
   expressly describes an exact model input count including schemas, paired with its
   combined generation cap. Cost: a different provider/model with its own availability,
   credentials and data policy; no provider preference is changed automatically here.
3. **Stay with Google and obtain a documented complete-input upper bound or enforceable
   smaller input cap:** then reserve that bound plus the existing generation cap and
   update both estimator and repository filter. Cost: pending provider contract evidence;
   no such guarantee was established in this investigation.
4. **Switch the Google API/model or use count-plus-padding:** generateContent supports a
   full-request counting form and the same combined output cap, but the reviewed sources
   still do not establish the required input upper bound. A model switch alone does not
   solve this. Legacy 2.5 thinking-off controls also trade reasoning quality and restricted
   new-project access without proving input accounting. Count-plus-padding can support an
   explicitly best-effort budgeting policy, but would weaken the present guarantee and is
   not adopted under this request.

No smaller Google reservation is claimed safe, and Google has not been switched or disabled.
The remaining limitation is explicit and unresolved; mocks prove our arithmetic/admission
and settlement, not provider production billing or token-count fidelity.
