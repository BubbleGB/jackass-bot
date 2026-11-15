# Ambiguous-name knowledge answer investigation

Owner report: a bot mention asking “do you know Shaggy.” received unrelated Scooby-Doo
information despite one enabled entry titled “Shaggy” and a 2,000-token knowledge budget.
Investigation uses mocked Discord/provider HTTP and isolated PostgreSQL, not VPS access
or a paid model call. Live staff text was used only in a private local reproduction;
the committed regression retains the name/question with synthetic staff claims.

## Observed request trace

The normal `DiscordHandlers.handleMessage` path fetches the triggering message, accepts
the mention, queues one direct request and builds context through the shared services.
With no earlier messages, the retrieval query is the current mention/question exactly
once. `searchQuery` produces `bot-ID | know | shaggy`: this is **OR**, not AND. The
conversational word `know` does not prevent matching `shaggy`.

The supplied 150-code-point body indexes as one chunk with the `shaggy` lexeme. With
the entry titled “Shaggy”, PostgreSQL's rank for this query is positive (1.4 in the local
fixture); the sole entry is returned. Both the current question and the entire reference
survive context fitting and reach the final OpenAI/Google request inside the delimited
untrusted staff-reference envelope. No reindex, title change, stop-word expansion or
allowance increase is necessary for this reported single-entry case.

The regression checks the actual SQL-backed repository call/result, indexed body/lexeme,
positive ranking, unchanged final reference, exactly-once question, counting requests,
reservations/settlement and Discord delivery. In the injected counter fixture, knowledge
adds 60 input units to a 100-unit baseline, comfortably below 2,000. These are deliberate
mock token units, **not measured production token counts**; real counters also include
instructions/framing and Google's documented engineering margin.

## Instruction gap and change

The previous shared prompt said only “Use relevant reference facts”. It did not specify
how to resolve an ambiguous name against local knowledge, prefer relevant local material
over unrelated general lore, attribute personal claims, or avoid personal-acquaintance
claims/unsupported elaboration. Both provider regressions first failed on that missing
request contract after confirming the entry already reached the generation API.

The original fix supplied those rules whenever references were present. A subsequent
owner style amendment removes mandatory per-claim attribution and routine source,
verification or personal-acquaintance disclaimers: use the knowledge conversationally,
explain its source when asked, retain stated uncertainty and acknowledge specific gaps.
Personal acquaintance, implied independent verification and unsupported additions remain
forbidden. This changes presentation, not grounding or retrieval. References
remain untrusted user data, cannot override application permissions/instructions, and
cannot grant tools or notification recipients. Disabled/deleted/freshness checks,
Unicode/context/knowledge limits, required input and accounting remain intact. The extra
policy is counted in both providers' complete input and marginal knowledge estimates.

The handler tests cover the exact mention form, `Shaggy?`, `Who is Shaggy?` and
`Tell me about Shaggy.` with both providers. A mocked natural answer is delivered
unchanged with existing allowed mentions; explicit source and acquaintance questions
also retain their honest explanations. Existing tests cover automatic participation
and absence/disablement of knowledge. Mocked answers prove payload/delivery contracts,
not that a live model will follow the instructions. They do not reproduce a model's
internal choice to discuss Scooby-Doo. The live reply alone cannot prove that internal
cause or exclude deployment/configuration differences; the confirmed code gap is the
missing answer-grounding policy, while lookup failure was not reproduced.

## Rollout and remaining limits

Update the approved image digest; no new migration, dependency, Compose setting, secret,
command registration, entry rewrite or index rebuild. Existing model/effort selections
and allowances stay unchanged. After separately authorised rollout, repeat the original
mention against the real provider and verify relevance, natural wording, source honesty
when asked and no invented
details. No VPS deployment is performed by this change.

Retrieval remains bounded lexical matching, not semantic identity resolution. In a
separate multi-entry stress case, frequent conversational terms can rank competing
passages above a rare name at the top-eight cutoff. That is not the owner's confirmed
single-entry configuration and is not claimed as this live failure's cause. The existing
no-match/budget-omission behaviours still apply; provider refusal handling is unchanged.
