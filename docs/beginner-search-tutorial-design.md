# Beginner Search Tutorial Design

## Purpose

Help a new ManaSearch user complete and understand one useful card search. The tutorial should teach the path from choosing a source card to interpreting results, while keeping the rest of the interface available to explore.

The first search is the success point. A user should leave knowing how to:

1. Choose one or more source cards.
2. Optionally highlight the ability or phrase they care about.
3. Start a search with sensible defaults.
4. Read why a result matched and make a simple adjustment.
5. Find Preferences and switch between dark and light appearance if they want.

The tutorial is optional, skippable, and replayable. It does not require an account or send user activity anywhere.

## Experience principles

- **Teach a task, not the whole interface.** Guide the user through a first search. Do not explain every filter, ranking option, or parser detail up front.
- **Let users act.** The guide points to the real control and waits for the user to use it. It should not change their source cards, theme, highlights, or constraints on their behalf.
- **Respect what is already done.** If a user has selected a card or finished a step before starting the guide, acknowledge it and move on.
- **Keep explanations close to the controls.** Give a short instruction beside the thing it describes. Put longer explanations behind optional help.
- **Keep choices reversible.** Make Back, Skip, Exit, and Replay easy to find. Changing the theme during the tour is the user's choice.
- **Make progress and feedback clear.** Show the current step, what action is expected, and a visible response after each action.

## How the tutorial should feel

The tutorial should feel like a calm guide sitting beside the page: helpful, direct, and easy to ignore when the user already knows what to do. Use short sentences and familiar terms. Prefer “Choose a card to search from” to parser or ranking terminology.

Keep each step to one idea. Use a small popover or panel with a clear heading, one or two short sentences, and a specific action. Avoid long paragraphs, celebratory interruptions, or blocking dialogs that require reading before the user can use the app.

Use ManaSearch's existing visual style: the same dark or light theme, purple accent, button shapes, text sizes, and spacing. The guide should feel like part of the product rather than a separate help site. Give the focused control a clear outline or spotlight, while dimming surrounding content only enough to direct attention.

## Recommended walkthrough

The tour should have a short opening, a few task steps, and a useful ending. Show progress such as “Step 3 of 7.” Counts should reflect the actual remaining steps if completed steps are skipped.

### 1. Welcome

**Purpose:** Establish what the user will do and let them choose whether to start.

**Suggested copy:** “Let’s find cards related to one you like. You’ll choose a source card, optionally highlight an ability, and search.”

Offer **Start guide** and **Skip**. Avoid a multi-screen welcome sequence.

### 2. Preferences and appearance (optional)

**Purpose:** Show where Preferences are and how to change appearance without making theme setup a requirement for searching.

Point to the Preferences control and say: “You can change the app’s appearance and other display choices here. Try dark or light mode if you prefer.” Provide **Open Preferences** and **Skip this step**. If the user opens Preferences, point out the dark/light setting, then wait for them to close Preferences or continue.

Do not switch themes automatically. If the user changes the theme, keep the guide open and update its colors with the app. If they make no change, continue normally. The step should be marked optional so skipping it never feels like an incomplete setup.

### 3. Choose a source card

**Purpose:** Explain the card that anchors the search.

**Suggested copy:** “Choose the card whose effects or wording you want to find similar cards for.” Point to the source card picker or current source card. If a card is already selected, explain that it is ready and offer to continue.

Mention multiple sources briefly: “You can add another source card too.” Do not force users to add one during their first search. If they add multiple sources, the tutorial should continue with the current set and not clear or replace it.

### 4. Highlight a phrase (optional)

**Purpose:** Teach how to focus the search while explaining that a highlight is optional.

**Suggested copy:** “Select a phrase in the type line or Oracle text to focus on that part of the card. With no highlight, ManaSearch uses the whole card.” Point directly to the Oracle text or type line.

Let the user select text themselves. When a highlight is active, acknowledge it and continue. If selecting text is difficult on a touch screen, offer a concise hint to tap or drag across the phrase. Let users continue without a highlight.

### 5. Search settings and source-card constraints

**Purpose:** Explain where the main search choices live without turning the tour into a settings lesson.

Point out the search method and result order controls. **Suggested copy:** “These choices affect how cards are found and ranked. The defaults are a good place to start.” Briefly note that constraints on the source card can narrow results or express a preference. Do not enumerate every constraint here.

If Live Search is visible in its short default form, describe it as a quick summary of what ManaSearch understood. Offer an optional “Show details” action for the longer explanation. Do not require opening it before searching.

### 6. Run the search

**Purpose:** Make the main action obvious and confirm that it worked.

Point to **Find Similar Cards**. **Suggested copy:** “Ready? Start the search to see cards that match your source and highlight.” If required information is missing, explain exactly what is needed and point to the relevant control.

After the user starts the search, show a clear in-progress state. Keep the action visibly busy or disabled while the same search is running, and provide a status message such as “Searching for similar cards…” Do not let the guide advance as if results were already available.

### 7. Understand the results

**Purpose:** Teach users how to make sense of the outcome, not just where the results are.

When results load, point to one result's name, match score, and explanation. **Suggested copy:** “The score summarizes the match. The explanation shows which parts of the cards are similar.” Use the actual result explanation when possible rather than a generic example.

Let users open a result or continue exploring. Do not imply that a high score guarantees a perfect match.

### 8. Refine and finish

**Purpose:** Show one safe next step and leave the user in control.

Offer a short refinement: change the highlighted phrase, adjust a source-card constraint, or try another source card. **Suggested copy:** “If these results are too broad or too narrow, adjust one choice and search again.” Point to one relevant control at a time.

Finish with **Explore results**, **Search again**, and **Replay guide**. Do not require a second search to complete the tutorial.

## Popover and page behavior

- Keep the active control visible. Scroll it into view before showing its explanation, accounting for sticky headers and the viewport edge.
- Place the popover where it does not cover the control or its required action. Reposition it when the page resizes or a panel opens.
- The highlight should not prevent the user from clicking, typing, or selecting text in the target control.
- Keep **Back**, **Skip**, and **Exit guide** in consistent positions. Use a clear primary button for the expected action.
- If the target is missing, hidden, or removed by a layout change, choose a sensible fallback step or explain how to reveal it. Never strand the user on a blank spotlight.
- Avoid advancing on a click anywhere on the page. Advance after a meaningful action or when the user chooses **Next**.
- If the user performs a later step early, mark it complete and avoid asking them to repeat it.

## Mobile and accessibility

- On narrow screens, use a readable bottom sheet or a compact panel that does not cover the target control. Keep the current instruction and its actions visible without awkward scrolling.
- Make all guide actions keyboard accessible. Move focus to the guide when a step changes and return focus sensibly when the guide closes.
- Support Escape to exit, but do not make dismissal the only way to leave.
- Announce step changes and search status to screen readers. Give the highlighted target a meaningful accessible name and avoid relying on color alone to show focus.
- Respect reduced-motion preferences. Use a simple outline or fade instead of a moving spotlight when reduced motion is enabled.
- Check text contrast in both themes and at browser zoom levels. The popover should follow the active theme immediately.

## Handling search problems

An empty result set should lead to a useful recovery, not a dead end. Say that no cards matched the current choices and offer a small number of relevant actions, such as broadening the highlight or relaxing a constraint. If the search is still running, show progress. If a local catalog or index is unavailable, explain what the user needs to load or build before retrying.

Do not silently clear settings, highlights, or source cards to make the tutorial progress. If a change would help, suggest it and let the user decide.

## Tutorial entry points and completion state

Keep a visible **Show guide** or **Replay guide** entry point so users can return later. Also make contextual help available beside unfamiliar controls, so a user does not need to restart the whole tour to learn one setting.

If the app records whether the guide was completed or dismissed, keep that state local to the browser using the app's existing preference approach. Do not add accounts, remote analytics, or behavioral tracking for the tutorial.

## Review checklist

- Can a new user finish a useful search without learning every setting?
- Can a user skip or exit from every step?
- Does the guide recognize existing source cards, highlights, and completed actions?
- Does the Preferences step explain dark/light mode without changing it for the user?
- Does the guide work in both themes and on a narrow phone screen?
- Are loading, no-results, and unavailable-index states understandable?
- Can keyboard and screen-reader users follow and leave the tour?
- Does the guide preserve all user selections when it closes?
