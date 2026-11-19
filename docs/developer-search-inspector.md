# ManaSearch developer search inspector

The floating **Developer inspector** is an opt-in, read-only view of the real application search. It is intended to help diagnose search-quality issues before changing retrieval or ranking logic.

## How to use it

1. Open the feature branch deployment (or run the app locally from this branch).
2. Load a source card.
3. Select the relevant Oracle text and set its Exact/Flexible mode and constraints.
4. Open **Developer inspector** in the bottom-right corner.
5. Run **Find Similar Cards** in the normal ManaSearch UI.
6. Inspect the tabs below. Use **Copy JSON** or **Download JSON** to export the current UI state, production pipeline snapshot, and retained run history together.

## Views

- **Live state** — source card, current visible intent, controls, result cards, and recent worker traffic.
- **Pipeline** — the actual search request, retrieval stream membership, stream coverage, functional/exact-highlight query results, candidate funnel counts, timing, semantic calibration, and relevance-floor settings.
- **Candidates** — up to 300 highest-scoring candidates from the actual scoring pass, including candidates subsequently removed by the relevance floor. Each candidate includes score channels, ranking evidence, parse confidence, retrieval provenance, and relevant ranking flags.
- **Trace card** — select one card and follow its recorded membership through every pipeline stage, see which retrieval streams found it, inspect hard-filter rejection evidence, review its score channels and ranking evidence, and confirm its final rank.
- **Exclusions** — candidates removed between pipeline stages and the recorded hard-filter / exact-highlight rejection explanations.
- **Compare runs** — compare two retained searches, including changed inputs, retrieval-stream overlap, final cards added or removed, rank movement, and score deltas for shared candidates.
- **Regression cases** — turn a real search into a portable test case, write down the correct expected result/ranking, export or import the case as JSON, and compare it with a later search run, including score-channel changes and candidate-pool changes for shared candidates.
- **Timeline** — search start/finish, configuration changes, and worker activity.
- **Worker** — observed Web Worker request/response payloads.

## Building a repeatable regression case

Use **Regression cases** when you find a search that behaves incorrectly and want to prevent the same failure from returning.

1. Run the problematic query normally. In the inspector, open **Regression cases** and choose the completed run under **Build from run**. Press **Build case**. The case captures the exact production request, UI state, baseline ranking, and full diagnostic pipeline. If a candidate was selected in **Trace card**, it is prefilled as the focus card.
2. Give the case a descriptive title and explain the failure in **Problem and expected behavior**. For example, note that a card with unrelated rules text ranked above a card that shares the selected mechanic.
3. Set a **Focus expectation**:
   - **Must appear** — the focus card must be in the final displayed result list.
   - **Must not appear** — the focus card must be absent from the final displayed result list.
   - **Must rank within top N** — the card must appear no lower than the maximum rank you enter.
   - **No focus assertion** — use only the ordered ranking check.
4. Edit **Expected top ranking** to the correct card names, one per line, best match first. The captured order is only a starting point; change it when the observed results are wrong. The comparison checks exact order for the listed top K, and reports overlap, missing cards, unexpected cards, and rank changes. It also compares shared candidates' numeric score channels and mechanical-breakdown fields, reports candidates newly appearing or no longer appearing in the bounded scored-candidate sample, and shows the focus card's before/after trace.
5. Choose **Download case** (or **Copy case JSON**) and keep the JSON file with the issue or code change. The case is portable and can be reviewed by another developer.
6. After updating ManaSearch, open the new build, import the case, and repeat the original search in the normal UI. Select that new completed run under **Compare against** and choose **Compare with run**.

A comparison is only valid when the source card, selected highlights, interpreted intent, constraints, methods, and ordering match the original request. When they differ, the report marks the result as **input-mismatch** instead of blaming the algorithm. Fix the input differences and rerun the case before evaluating ranking changes.

## Reading a diagnostic

Start with a specific candidate that should or should not have appeared. **Trace card** is the quickest way to see one candidate's recorded path; use **Pipeline**, **Candidates**, and **Exclusions** for the broader context:

1. Check its name in **Pipeline → retrieval streams**. If absent everywhere, the problem is retrieval/query formulation.
2. If retrieved, check **Exclusions → stageLosses** and **hardFilterRejections**. This distinguishes exact-highlight and constraint exclusions from later stages.
3. If it reached **Candidates**, compare `mechanicalScore`, `functionScore`, `contextScore`, `highlightIntentScore`, `exactnessScore`, and `similarityScore`. Scores are normalized to 0–1 unless a field is explicitly a count, duration, or multiplier.
4. Inspect `rankingEvidence`, `mechanicalBreakdown`, `parse`, and `rankingIntent` to see why the scorer trusted or downweighted a match.
5. Compare the candidate's final position and the `relevanceFloor` values to determine whether it was scored well but pruned or reordered.

The `retrievalEvidence` field is provenance only: it records which streams found a card and is not itself a similarity bonus.

## Data and safety boundaries

- The inspector does not launch searches, alter constraints, change score weights, or reorder candidates. It retains the six most recent completed primary searches in page memory only; this history is cleared when the page is reloaded.
- Candidate snapshots are captured from the production `scoreCardBatch` output before relevance-floor pruning. The inspector does not run a second scorer.
- Each run snapshot retains at most 300 scored candidates and 500 filter rejection records; the session archive retains at most six runs to bound memory and export size.
- **Download JSON** produces a versioned `manasearch-diagnostics-export-v2` file. It includes the most recent UI/pipeline state, retained completed runs, timeline, and observed worker messages.
- **Download case** produces a separate, portable `manasearch-regression-case-v1` file. It includes the original request, baseline final ranking, focus-card trace when selected, and captured production pipeline. Imports are capped at 8 MB.
- Cases and diagnostic exports stay in the browser until the developer explicitly copies or downloads them. Importing a case reads a local JSON file; no diagnostic history or case is uploaded or saved automatically.
- Diagnostic exports may contain card Oracle text, search queries, and user-selected highlight text. Review JSON before sharing it.
- The inspector is developer tooling, not a user-facing quality guarantee. Use reproducible source/highlight/constraint combinations and compare exported snapshots when tuning the search system.

## Known interpretation limits

- The candidate list is bounded to the top 300 by pre-floor similarity score; very large searches may have more scored candidates. The Trace card selector is built from captured streams, stage membership, the scored sample, rejection sample, and final results; candidates outside all retained samples cannot be individually traced.
- `preFloorRank` is the candidate's position after score sorting but before relevance-floor pruning. Use `finalResults` for the final displayed rank. Final result rows also include `preFloorScores` alongside the final post-preference similarity score.
- Filter rejection reasons are recorded per card name at the first failing hard-filter check; a card can have more than one underlying issue that is not represented by that first reason.
- Search Deeper and Related Search are separate workflows. This snapshot currently describes the primary Find Similar Cards run.
- Run comparison is descriptive rather than causal: changed ranks may be caused by changed source/highlight/constraints, different retrieval pools, score changes, relevance-floor pruning, or ordering preferences. The comparison output exposes these signals and does not claim which one alone caused a rank change.
