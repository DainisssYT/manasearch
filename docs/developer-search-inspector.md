# ManaSearch developer search inspector

The floating **Developer inspector** is an opt-in, read-only view of the real application search. It is intended to help diagnose search-quality issues before changing retrieval or ranking logic.

## How to use it

1. Open the feature branch deployment (or run the app locally from this branch).
2. Load a source card.
3. Select the relevant Oracle text and set its Exact/Flexible mode and constraints.
4. Open **Developer inspector** in the bottom-right corner.
5. Run **Find Similar Cards** in the normal ManaSearch UI.
6. Inspect the tabs below. Use **Copy JSON** or **Download JSON** to export the current UI state, production pipeline snapshot, and the retained run history together.

## Views

- **Live state** — source card, current visible intent, controls, result cards, and recent worker traffic.
- **Pipeline** — the actual search request, retrieval stream membership, stream coverage, functional/exact-highlight query results, candidate funnel counts, timing, semantic calibration, and relevance-floor settings.
- **Candidates** — up to 300 highest-scoring candidates from the actual scoring pass, including candidates subsequently removed by the relevance floor. Each candidate includes score channels, ranking evidence, parse confidence, retrieval provenance, and relevant ranking flags.
- **Exclusions** — candidates removed between pipeline stages and the recorded hard-filter / exact-highlight rejection explanations.
- **Compare runs** — compare two retained searches, including changed inputs, retrieval-stream overlap, final cards added or removed, rank movement, and score deltas for shared candidates.
- **Timeline** — search start/finish, configuration changes, and worker activity.
- **Worker** — observed Web Worker request/response payloads.

## Reading a diagnostic

Start with a specific candidate that should or should not have appeared:

1. Check its name in **Pipeline → retrieval streams**. If absent everywhere, the problem is retrieval/query formulation.
2. If retrieved, check **Exclusions → stageLosses** and **hardFilterRejections**. This distinguishes exact-highlight and constraint exclusions from later stages.
3. If it reached **Candidates**, compare `mechanicalScore`, `functionScore`, `contextScore`, `highlightIntentScore`, `exactnessScore`, and `similarityScore`. Scores are normalized to 0–1 unless a field is explicitly a count, duration, or multiplier.
4. Inspect `rankingEvidence`, `mechanicalBreakdown`, `parse`, and `rankingIntent` to see why the scorer trusted or downweighted a match.
5. Compare the candidate's final position and the `relevanceFloor` values to determine whether it was scored well but pruned or reordered.

The `retrievalEvidence` field is provenance only: it records which streams found a card and is not itself a similarity bonus.

## Data and safety boundaries

- The inspector does not launch searches, alter constraints, change score weights, or reorder candidates. It retains the six most recent completed primary searches in page memory only; this history is cleared when the page is reloaded.
- Candidate snapshots are captured from the production `scoreCardBatch` output before relevance-floor pruning. The inspector does not run a second scorer.
- Each run snapshot retains at most 300 scored candidates and 500 filter rejection records; the session archive retains at most six runs to bound memory and export size.\n- **Download JSON** produces a versioned `manasearch-diagnostics-export-v2` file. It includes the most recent UI/pipeline state, retained completed runs, timeline, and observed worker messages. No diagnostic history is uploaded or persisted automatically.
- Worker messages are observed without replacing application message handlers or changing message payloads.
- Diagnostic exports may contain card Oracle text, search queries, and user-selected highlight text. Review the JSON before sharing it.
- The inspector is developer tooling, not a user-facing quality guarantee. Use reproducible source/highlight/constraint combinations and compare exported snapshots when tuning the search system.

## Known interpretation limits

- The candidate list is bounded to the top 300 by pre-floor similarity score; very large searches may have more scored candidates.
- `preFloorRank` is the candidate's position after score sorting but before relevance-floor pruning. Use `finalResults` for the final displayed rank. Final result rows also include `preFloorScores` alongside the final post-preference similarity score.
- Filter rejection reasons are recorded per card name at the first failing hard-filter check; a card can have more than one underlying issue that is not represented by that first reason.
- Search Deeper and Related Search are separate workflows. This snapshot currently describes the primary Find Similar Cards run.\n- Run comparison is descriptive rather than causal: changed ranks may be caused by changed source/highlight/constraints, different retrieval pools, score changes, relevance-floor pruning, or ordering preferences. The comparison output exposes these signals but does not claim which one alone caused a rank change.
