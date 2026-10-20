/* ManaSearch Minigames — isolated UI and game state. Reads card/parser capabilities through ManaSearchApi. */
(() => {
    'use strict';

    const CONFIG = Object.freeze({
        wrongGuessLimit: 6,
        abilityCheckLimit: 3,
        minimumAbilityInputLength: 3,
        semanticMatchThreshold: 0.34,
        puzzlePath: 'minigames/puzzles.json',
        practiceStorageKey: 'manaSearchMinigames:v1:practice',
        dailyStoragePrefix: 'manaSearchMinigames:v1:daily:',
        statsStorageKey: 'manaSearchMinigames:v1:stats',
        clueLadder: Object.freeze([
            { wrong: 0, visibleCandidates: 3 },
            { wrong: 1, visibleCandidates: 5 },
            { wrong: 2, revealType: true },
            { wrong: 3, revealMana: true },
            { wrong: 4, visibleCandidates: 8 },
            { wrong: 5, revealNamePattern: true },
            { wrong: 6, revealAnswer: true }
        ])
    });

    const EMPTY_STATS = () => ({ gamesPlayed: 0, wins: 0, streak: 0, bestStreak: 0, guessDistribution: {} });
    const registry = [
        { id: 'guess-source', title: 'Guess the Source', description: 'Find the hidden card from its similar cards, clues, and ability checks.', built: true },
        { id: 'odd-one-out', title: 'Odd One Out', description: 'Spot the card that does not belong with the other three.', built: false },
        { id: 'rank-results', title: 'Rank the Results', description: 'Put five similar cards in order of relevance.', built: false },
        { id: 'blind-oracle', title: 'Blind Oracle', description: 'Identify a card from its rules text alone.', built: false }
    ];

    const ui = {
        launch: document.getElementById('minigames-btn'),
        dialog: document.getElementById('minigames-dialog'),
        close: document.getElementById('minigames-close'),
        listView: document.getElementById('minigames-list-view'),
        gameView: document.getElementById('minigames-game-view'),
        registry: document.getElementById('minigames-registry'),
        stats: document.getElementById('minigames-stats'),
        status: document.getElementById('minigames-status'),
        back: document.getElementById('minigames-back'),
        activeGame: document.getElementById('minigames-active-game'),
        modeLabel: document.getElementById('minigames-mode-label')
    };

    let puzzles = [];
    let puzzleMap = new Map();
    let cardNameEntries = [];
    let nameIndexReady = false;
    let game = null;
    let stats = loadJson(CONFIG.statsStorageKey, EMPTY_STATS());
    let latestStatusTimer = null;

    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (_) { setStatus('Progress could not be saved in this browser. Play can continue for this session.', 'warning'); return false; }
    }

    function setStatus(message, type = '') {
        if (!ui.status) return;
        ui.status.textContent = message || '';
        ui.status.className = 'minigames-status' + (type ? ` is-${type}` : '');
        if (latestStatusTimer) clearTimeout(latestStatusTimer);
        if (message) latestStatusTimer = setTimeout(() => {
            if (ui.status.textContent === message) ui.status.textContent = '';
        }, 5000);
    }

    function node(tag, className = '', text = '') {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined && text !== null) item.textContent = String(text);
        return item;
    }

    function actionButton(text, className, onClick, disabled = false) {
        const button = node('button', className || 'minigames-button', text);
        button.type = 'button';
        button.disabled = Boolean(disabled);
        button.addEventListener('click', onClick);
        return button;
    }

    function normalizeName(value) {
        return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    }

    function nameWords(value) {
        const stop = new Set(['a', 'an', 'and', 'of', 'the', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at']);
        return new Set(normalizeName(value).split(' ').filter(word => word.length > 2 && !stop.has(word)));
    }

    function shareNameWords(left, right) {
        const a = nameWords(left), b = nameWords(right);
        for (const word of a) if (b.has(word)) return true;
        return false;
    }

    function safeCardNameMatch(input, card) {
        const guess = normalizeName(input);
        if (!guess || !card) return false;
        const aliases = [card.name, ...(card.card_faces || []).map(face => face.name)].filter(Boolean);
        return aliases.some(alias => normalizeName(alias) === guess);
    }

    function getCardAliases(card) {
        return [card?.name, ...(card?.card_faces || []).map(face => face?.name)].filter(Boolean);
    }

    function puzzleStorageKey(mode, date = utcDateKey()) {
        return mode === 'daily' ? `${CONFIG.dailyStoragePrefix}${date}` : CONFIG.practiceStorageKey;
    }

    function utcDateKey() { return new Date().toISOString().slice(0, 10); }

    function stableHash(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function saveGame() {
        if (!game) return;
        saveJson(puzzleStorageKey(game.mode, game.dailyDate), game);
        saveJson(CONFIG.statsStorageKey, stats);
    }

    function randomPuzzle(excludeId = '') {
        const options = puzzles.filter(item => item.id !== excludeId);
        const pool = options.length ? options : puzzles;
        return pool[Math.floor(Math.random() * pool.length)] || null;
    }

    function dailyPuzzle(date = utcDateKey()) {
        if (!puzzles.length) return null;
        return puzzles[stableHash(`ManaSearch:${date}`) % puzzles.length];
    }

    function getSavedGame(mode, date = utcDateKey()) {
        const saved = loadJson(puzzleStorageKey(mode, date), null);
        if (!saved || !puzzleMap.has(saved.puzzleId) || saved.mode !== mode) return null;
        if (!['playing', 'won', 'lost'].includes(saved.status)) return null;
        if (!Array.isArray(saved.guesses) || !Array.isArray(saved.abilityChecks)) return null;
        saved.dailyDate = mode === 'daily' ? date : '';
        return saved;
    }

    function newGame(puzzle, mode = 'practice', date = '') {
        return {
            puzzleId: puzzle.id,
            mode,
            dailyDate: mode === 'daily' ? date : '',
            status: 'playing',
            wrongGuesses: 0,
            guesses: [],
            abilityChecks: [],
            usedGuessKeys: [],
            startedAt: Date.now(),
            finishedAt: 0,
            statsRecorded: false
        };
    }

    function startPractice() {
        const saved = getSavedGame('practice');
        if (saved?.status === 'playing') {
            game = saved;
            showGameView();
            renderGame();
            setStatus('Resumed your saved practice game.');
            return;
        }
        const previousId = game?.puzzleId || '';
        const puzzle = randomPuzzle(previousId);
        if (!puzzle) { setStatus('No usable puzzles are available in the local card catalog.', 'warning'); return; }
        game = newGame(puzzle, 'practice');
        saveGame();
        showGameView();
        renderGame();
    }

    function startDaily() {
        const date = utcDateKey();
        const saved = getSavedGame('daily', date);
        if (saved) {
            game = saved;
            showGameView();
            renderGame();
            setStatus(saved.status === 'playing' ? 'Resumed today’s puzzle.' : 'Today’s attempt is already complete. Try Practice for another puzzle.');
            return;
        }
        const puzzle = dailyPuzzle(date);
        if (!puzzle) { setStatus('No usable puzzles are available in the local card catalog.', 'warning'); return; }
        game = newGame(puzzle, 'daily', date);
        saveGame();
        showGameView();
        renderGame();
    }

    function showListView() {
        ui.listView.hidden = false;
        ui.gameView.hidden = true;
        renderList();
    }

    function showGameView() {
        ui.listView.hidden = true;
        ui.gameView.hidden = false;
        ui.modeLabel.textContent = game?.mode === 'daily' ? `DAILY · ${game.dailyDate}` : 'PRACTICE';
    }

    function renderList() {
        ui.registry.replaceChildren();
        ui.stats.replaceChildren();
        const winRate = stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;
        const statsItems = [
            ['Games', stats.gamesPlayed],
            ['Win rate', `${winRate}%`],
            ['Current streak', stats.streak],
            ['Best streak', stats.bestStreak]
        ];
        for (const [label, value] of statsItems) {
            const item = node('div', 'minigames-stat');
            item.append(node('span', 'minigames-stat-value', value), node('span', 'minigames-stat-label', label));
            ui.stats.append(item);
        }

        for (const item of registry) {
            const card = node('article', `minigames-registry-card${item.built ? ' is-built' : ' is-coming'}`);
            const top = node('div', 'minigames-registry-card-top');
            top.append(node('span', 'minigames-registry-kicker', item.built ? 'READY TO PLAY' : 'IN THE WORKS'));
            if (!item.built) top.append(node('span', 'minigames-coming-badge', 'Coming soon'));
            card.append(top, node('h3', '', item.title), node('p', '', item.description));
            if (item.built) {
                const extra = node('p', 'minigames-registry-detail', `Best streak: ${stats.bestStreak}`);
                const actions = node('div', 'minigames-registry-actions');
                actions.append(
                    actionButton('Practice', 'minigames-button minigames-button-primary', startPractice),
                    actionButton('Daily', 'minigames-button', startDaily)
                );
                card.append(extra, actions);
            } else {
                card.append(node('p', 'minigames-registry-detail', 'Your stats and progress stay local to this browser.'));
            }
            ui.registry.append(card);
        }
    }

    function candidateAliases(candidate) { return candidate?.card ? getCardAliases(candidate.card) : [candidate?.name].filter(Boolean); }

    function getCurrentPuzzle() { return puzzleMap.get(game?.puzzleId) || null; }

    function finishGame(status) {
        if (!game || game.status !== 'playing') return;
        game.status = status;
        game.finishedAt = Date.now();
        if (!game.statsRecorded) {
            stats.gamesPlayed = (Number(stats.gamesPlayed) || 0) + 1;
            if (status === 'won') {
                stats.wins = (Number(stats.wins) || 0) + 1;
                stats.streak = (Number(stats.streak) || 0) + 1;
                stats.bestStreak = Math.max(Number(stats.bestStreak) || 0, stats.streak);
                const used = Math.max(1, game.guesses.length);
                stats.guessDistribution = stats.guessDistribution || {};
                stats.guessDistribution[used] = (Number(stats.guessDistribution[used]) || 0) + 1;
            } else {
                stats.streak = 0;
            }
            game.statsRecorded = true;
        }
        saveGame();
    }

    function processGuess(rawGuess) {
        if (!game || game.status !== 'playing') return;
        const guess = String(rawGuess || '').trim();
        if (!guess) { setStatus('Enter a card name first.', 'warning'); return; }
        const api = window.ManaSearchApi;
        const guessedCard = api.getCardByName(guess);
        if (!guessedCard) { setStatus('That card name was not found in the local card catalog. Choose a suggested name.', 'warning'); return; }
        const key = normalizeName(guess);
        if (game.usedGuessKeys.includes(key) || game.guesses.some(item => item.normalized === key || (item.cardId && guessedCard.id && item.cardId === guessedCard.id))) {
            setStatus('You already guessed that card. No guess was used.', 'warning'); return;
        }
        game.guesses.push({ name: guess, normalized: key, cardId: guessedCard.id || '', correct: false });
        game.usedGuessKeys.push(key);
        const puzzle = getCurrentPuzzle();
        if (safeCardNameMatch(guess, puzzle.card)) {
            game.guesses[game.guesses.length - 1].correct = true;
            finishGame('won');
            saveGame();
            renderGame();
            setStatus(`Correct! You found ${puzzle.card.name}.`, 'success');
            return;
        }
        game.wrongGuesses += 1;
        if (game.wrongGuesses >= CONFIG.wrongGuessLimit) finishGame('lost');
        saveGame();
        renderGame();
        if (game.status === 'lost') setStatus(`Game over — the hidden card was ${puzzle.card.name}.`, 'warning');
        else setStatus('Not quite. A new clue has been unlocked.');
    }

    function stripReminderText(text) {
        const source = String(text || '');
        let out = '';
        let depth = 0;
        for (const ch of source) {
            if (ch === '(') { depth++; continue; }
            if (ch === ')' && depth > 0) { depth--; continue; }
            if (depth === 0) out += ch;
        }
        return out;
    }

    function replaceCardNamesWithPlaceholder(text, card) {
        let result = String(text || '');
        const aliases = getCardAliases(card).sort((a, b) => b.length - a.length);
        for (const alias of aliases) {
            const normalizedAlias = String(alias || '').trim();
            if (!normalizedAlias) continue;
            const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1CARDNAME');
        }
        return result;
    }

    function normalizeOracleForLiteral(text, card) {
        return replaceCardNamesWithPlaceholder(stripReminderText(text), card)
            .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            .toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    }

    function hasWholeSymbolRuns(source, query, index) {
        const symbolRuns = [...query.matchAll(/(?:\{[a-z0-9/]+\})+/gi)];
        for (const run of symbolRuns) {
            const start = index + run.index;
            const end = start + run[0].length;
            const queryBefore = query[run.index - 1] || '';
            const queryAfter = query[run.index + run[0].length] || '';
            const sourceBefore = source[start - 1] || '';
            const sourceAfter = source[end] || '';
            if (sourceBefore === '}' && queryBefore !== '}') return false;
            if (sourceAfter === '{' && queryAfter !== '{') return false;
        }
        return true;
    }

    function hasWholeWordBoundaries(source, query, index) {
        const first = query[0] || '';
        const last = query[query.length - 1] || '';
        const wordChar = char => Boolean(char) && /[\p{L}\p{N}]/u.test(char);
        if (wordChar(first) && wordChar(source[index - 1] || '')) return false;
        const end = index + query.length;
        if (wordChar(last) && wordChar(source[end] || '')) return false;
        return true;
    }

    function literalAbilityMatch(typedText, card) {
        const query = normalizeOracleForLiteral(typedText, card);
        const oracle = normalizeOracleForLiteral(window.ManaSearchApi.getOracleText(card), card);
        if (!query || !oracle) return false;
        let index = oracle.indexOf(query);
        while (index !== -1) {
            if (hasWholeWordBoundaries(oracle, query, index) && hasWholeSymbolRuns(oracle, query, index)) return true;
            index = oracle.indexOf(query, index + 1);
        }
        return false;
    }

    function splitAbilityClauses(text) {
        return String(text || '').split(/;|\n+|(?<=[.!?])\s+/).map(item => item.trim()).filter(Boolean);
    }

    function isMeaningfulParsedEffect(effect) {
        if (!effect) return false;
        const fnA = effect.canonical?.function;
        const outcome = effect.canonical?.outcome;
        return Boolean((fnA && fnA !== 'generic') || outcome || (effect.action && effect.action !== 'generic'));
    }

    function semanticAbilityMatch(typedText, card) {
        const api = window.ManaSearchApi;
        try {
            const typedEffects = api.parseEffects(typedText, card).filter(isMeaningfulParsedEffect);
            const hiddenOracle = api.getOracleText(card);
            const hiddenEffects = api.parseEffects(hiddenOracle, card).filter(isMeaningfulParsedEffect);
            // Small explicit mana-production fallback for fragment checks such as “Add {G}”
            // against a card that says “Add {C}{C}”. It deliberately requires the same mana-
            // production family, so unrelated generic parser fallbacks cannot turn yellow.
            const typedMana = /\badd\b[^{.]{0,60}(?:\{[wubrgcs]\}|\bmana\b)/i.test(typedText) || /\btap for mana\b/i.test(typedText);
            const hiddenMana = /\badd\b[^{.]{0,90}(?:\{[wubrgcs]\}|\bmana\b)/i.test(hiddenOracle) || /\btap for mana\b/i.test(hiddenOracle);
            if (typedMana && hiddenMana) return true;
            if (!typedEffects.length || !hiddenEffects.length) return false;
            let bestPairScore = 0;
            for (const typed of typedEffects) {
                for (const hidden of hiddenEffects) {
                    bestPairScore = Math.max(bestPairScore, Number(api.scoreEffectMatch(typed, hidden, 'variable')) || 0);
                }
            }
            const assignment = api.assignEffects(typedEffects, hiddenEffects, 'variable');
            return bestPairScore >= CONFIG.semanticMatchThreshold && Array.isArray(assignment?.matches) && assignment.matches.length > 0;
        } catch (error) {
            console.debug('[ManaSearch minigames] Ability parsing failed; treating as no match.', error);
            return false;
        }
    }

    function gradeClause(clause, card) {
        if (literalAbilityMatch(clause, card)) return 'green';
        if (semanticAbilityMatch(clause, card)) return 'yellow';
        return 'grey';
    }

    function gradeAbilityInput(text, card) {
        const clauses = splitAbilityClauses(text);
        if (!clauses.length) return { grade: 'grey', clauseGrades: [] };
        const clauseGrades = clauses.map(clause => gradeClause(clause, card));
        const allGreen = clauseGrades.every(grade => grade === 'green');
        const anyMatch = clauseGrades.some(grade => grade === 'green' || grade === 'yellow');
        return { grade: allGreen ? 'green' : (anyMatch ? 'yellow' : 'grey'), clauseGrades };
    }

    function inputContainsCardName(text, card) {
        const normalizedText = normalizeName(text);
        return getCardAliases(card).some(alias => {
            const normalizedAlias = normalizeName(alias);
            if (!normalizedAlias) return false;
            return (` ${normalizedText} `).includes(` ${normalizedAlias} `);
        });
    }

    function processAbilityCheck(rawText) {
        if (!game || game.status !== 'playing') return;
        const text = String(rawText || '').trim();
        if (text.length < CONFIG.minimumAbilityInputLength) { setStatus('Enter a little more ability text. A single symbol such as {T} is allowed.', 'warning'); return; }
        if (game.abilityChecks.length >= CONFIG.abilityCheckLimit) { setStatus('You have used all three ability checks for this game.', 'warning'); return; }
        const puzzle = getCurrentPuzzle();
        const normalized = normalizeOracleForLiteral(text, puzzle.card).replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, '').replace(/\s+/g, ' ');
        if (game.abilityChecks.some(item => item.normalized === normalized)) { setStatus('You already checked that text. No check was used.', 'warning'); return; }
        if (inputContainsCardName(text, puzzle.card)) { setStatus('Please test the ability, not the hidden card’s name. No check was used.', 'warning'); return; }
        const result = gradeAbilityInput(text, puzzle.card);
        game.abilityChecks.push({ text, normalized, grade: result.grade, clauseGrades: result.clauseGrades });
        saveGame();
        renderGame();
        const message = result.grade === 'green' ? 'Exact rules-text match — green.' : result.grade === 'yellow' ? 'A similar parsed effect — yellow.' : 'No matching effect found — grey.';
        setStatus(message, result.grade === 'grey' ? '' : 'success');
    }

    function unlockedCandidateCount() {
        if (!game) return 0;
        const ladder = CONFIG.clueLadder.filter(step => Number.isFinite(step.visibleCandidates) && game.wrongGuesses >= step.wrong);
        return ladder.length ? Math.max(...ladder.map(step => step.visibleCandidates)) : 3;
    }

    function isClueUnlocked(wrongCount) { return Boolean(game && game.wrongGuesses >= wrongCount); }

    function appendClue(container, label, value, isKnown) {
        const row = node('div', `minigames-clue-row${isKnown ? ' is-known' : ' is-locked'}`);
        row.append(node('span', 'minigames-clue-label', label), node('span', 'minigames-clue-value', value));
        container.append(row);
    }

    function buildCandidateCard(candidate, puzzle) {
        const card = node('article', 'minigames-candidate-card');
        const imgWrap = node('div', 'minigames-candidate-art');
        if (candidate.card?.imageUrl) {
            const image = node('img');
            image.src = candidate.card.imageUrl;
            image.alt = `${candidate.card.name} card art`;
            image.loading = 'lazy';
            image.decoding = 'async';
            imgWrap.append(image);
        } else {
            imgWrap.append(node('span', 'minigames-card-placeholder', 'MTG'));
        }
        card.append(imgWrap, node('strong', 'minigames-candidate-name', candidate.card?.name || candidate.name));
        if (game.status === 'lost') card.append(node('p', 'minigames-candidate-reason', candidate.reason));
        return card;
    }

    function renderGame() {
        if (!game) return;
        const puzzle = getCurrentPuzzle();
        if (!puzzle) { setStatus('This saved puzzle is no longer available.', 'warning'); showListView(); return; }
        ui.modeLabel.textContent = game.mode === 'daily' ? `DAILY · ${game.dailyDate}` : 'PRACTICE';
        ui.activeGame.replaceChildren();

        const header = node('div', 'minigames-game-title-row');
        const titleStack = node('div', '');
        titleStack.append(node('span', 'minigames-eyebrow', 'GUESS THE SOURCE'), node('h3', 'minigames-game-title', game.status === 'playing' ? 'Name the hidden card' : (game.status === 'won' ? 'Well played!' : 'Puzzle revealed')));
        const playAgain = actionButton(game.mode === 'daily' ? 'Play Practice' : 'Play again', 'minigames-button minigames-button-primary', () => game.mode === 'daily' ? startPractice() : startNewPractice(), game.status === 'playing');
        header.append(titleStack, playAgain);
        ui.activeGame.append(header);

        const progress = node('div', 'minigames-progress-row');
        const dots = node('div', 'minigames-guess-dots');
        dots.setAttribute('aria-label', `${game.wrongGuesses} wrong guesses out of ${CONFIG.wrongGuessLimit}`);
        for (let i = 0; i < CONFIG.wrongGuessLimit; i++) {
            const dot = node('span', `minigames-guess-dot${i < game.wrongGuesses ? ' is-used' : ''}`, i < game.wrongGuesses ? '●' : '○');
            dots.append(dot);
        }
        progress.append(dots, node('span', 'minigames-progress-label', `${game.wrongGuesses}/${CONFIG.wrongGuessLimit} wrong guesses`), node('span', 'minigames-progress-label', `${CONFIG.abilityCheckLimit - game.abilityChecks.length} ability checks left`));
        ui.activeGame.append(progress);

        const contentGrid = node('div', 'minigames-game-grid');
        const candidatePanel = node('section', 'minigames-section minigames-candidate-section');
        const candidateTop = node('div', 'minigames-section-heading');
        candidateTop.append(node('h4', '', 'Similar cards'), node('span', 'minigames-section-note', `${Math.min(unlockedCandidateCount(), puzzle.candidates.length)} of ${puzzle.candidates.length} revealed`));
        candidatePanel.append(candidateTop, node('p', 'minigames-section-hint', 'The card pool is prebuilt, so opening a game never runs a new ManaSearch query.'));
        const candidateGrid = node('div', 'minigames-candidate-grid');
        const visibleCount = game.status === 'lost' ? puzzle.candidates.length : unlockedCandidateCount();
        puzzle.candidates.slice(0, visibleCount).forEach(candidate => candidateGrid.append(buildCandidateCard(candidate, puzzle)));
        candidatePanel.append(candidateGrid);

        const cluePanel = node('section', 'minigames-section minigames-clue-section');
        cluePanel.append(node('h4', '', 'Clues'));
        const typeValue = isClueUnlocked(2) ? (puzzle.card.type_line || 'Type line unavailable') : '???';
        appendClue(cluePanel, 'Type line', typeValue, isClueUnlocked(2));
        const colors = Array.isArray(puzzle.card.color_identity) ? puzzle.card.color_identity.join('') || 'Colorless' : 'Unknown';
        const manaValueRaw = puzzle.card.cmc;
        const manaValue = manaValueRaw !== null && manaValueRaw !== undefined && manaValueRaw !== '' && Number.isFinite(Number(manaValueRaw)) ? String(manaValueRaw) : 'Unknown';
        appendClue(cluePanel, 'Mana value', isClueUnlocked(3) ? manaValue : '???', isClueUnlocked(3));
        appendClue(cluePanel, 'Color identity', isClueUnlocked(3) ? colors : '???', isClueUnlocked(3));
        if (isClueUnlocked(5)) {
            const names = getCardAliases(puzzle.card);
            const mainName = puzzle.card.card_faces?.[0]?.name || names[0] || puzzle.card.name;
            const letterCount = mainName.replace(/[^a-z]/gi, '').length;
            const firstLetter = mainName.trim().charAt(0).toLocaleUpperCase();
            appendClue(cluePanel, 'Name pattern', `${letterCount} letters · starts with “${firstLetter}”`, true);
        } else appendClue(cluePanel, 'Name pattern', 'Unlock after 5 wrong guesses', false);
        if (game.status !== 'playing') {
            const reveal = node('div', 'minigames-answer-reveal');
            reveal.append(node('h4', '', game.status === 'won' ? `You found ${puzzle.card.name}!` : `The hidden card was ${puzzle.card.name}`));
            if (puzzle.card.imageUrl) {
                const image = node('img', 'minigames-answer-image');
                image.src = puzzle.card.imageUrl;
                image.alt = `${puzzle.card.name} card image`;
                image.loading = 'lazy';
                reveal.append(image);
            }
            reveal.append(node('p', 'minigames-answer-type', puzzle.card.type_line || ''));
            reveal.append(node('p', 'minigames-answer-oracle', window.ManaSearchApi.getOracleText(puzzle.card) || 'No Oracle text available.'));
            reveal.append(actionButton('Open in ManaSearch', 'minigames-button minigames-button-primary', async () => {
                try {
                    setStatus(`Opening ${puzzle.card.name} in ManaSearch…`);
                    await window.ManaSearchApi.openCard(puzzle.card.name);
                    ui.dialog.close();
                } catch (error) {
                    setStatus(error?.message || 'Could not open this card in ManaSearch.', 'warning');
                }
            }));
            if (game.status === 'lost') {
                reveal.append(node('p', 'minigames-loss-note', 'Why the revealed candidates were similar: each card has a short rationale shown beneath its image above.'));
            }
            cluePanel.append(reveal);
        }

        contentGrid.append(candidatePanel, cluePanel);
        ui.activeGame.append(contentGrid);

        if (game.status === 'playing') {
            const inputArea = node('section', 'minigames-section minigames-input-section');
            const guessForm = node('form', 'minigames-guess-form');
            const guessLabel = node('label', '', 'Guess a card name');
            guessLabel.htmlFor = 'minigames-name-input';
            const guessInput = node('input', 'minigames-text-input');
            guessInput.id = 'minigames-name-input';
            guessInput.type = 'text';
            guessInput.autocomplete = 'off';
            guessInput.placeholder = 'Start typing a card name…';
            guessInput.setAttribute('list', 'minigames-card-name-options');
            guessInput.setAttribute('aria-describedby', 'minigames-name-help');
            guessInput.required = true;
            const datalist = node('datalist');
            datalist.id = 'minigames-card-name-options';
            getNameSuggestions(guessInput.value, 12).forEach(entry => datalist.append(node('option', '', entry.name)));
            guessInput.addEventListener('input', () => {
                const q = guessInput.value;
                datalist.replaceChildren();
                getNameSuggestions(q, 12).forEach(entry => datalist.append(node('option', '', entry.name)));
            });
            const guessButton = actionButton('Guess', 'minigames-button minigames-button-primary', () => {}, false);
            guessButton.type = 'submit';
            guessForm.append(guessLabel, guessInput, datalist, guessButton);
            guessForm.addEventListener('submit', event => { event.preventDefault(); processGuess(guessInput.value); });
            inputArea.append(guessForm, node('p', 'minigames-input-help', 'Unknown or repeated card names do not use a guess. Both faces of a double-faced card are accepted.'));

            const abilityForm = node('form', 'minigames-ability-form');
            const abilityLabel = node('label', '', 'Check an ability');
            abilityLabel.htmlFor = 'minigames-ability-input';
            const abilityInput = node('input', 'minigames-text-input');
            abilityInput.id = 'minigames-ability-input';
            abilityInput.type = 'text';
            abilityInput.placeholder = 'e.g. Add {C}{C} or draw a card';
            abilityInput.autocomplete = 'off';
            abilityInput.required = true;
            abilityInput.disabled = game.abilityChecks.length >= CONFIG.abilityCheckLimit;
            const abilityButton = actionButton('Check', 'minigames-button', () => {}, abilityInput.disabled);
            abilityButton.type = 'submit';
            abilityForm.append(abilityLabel, abilityInput, abilityButton);
            abilityForm.addEventListener('submit', event => { event.preventDefault(); processAbilityCheck(abilityInput.value); });
            inputArea.append(abilityForm, node('p', 'minigames-input-help', 'Three checks per game. Exact rules text is green; a comparable parsed effect is yellow; no match is grey.'));

            const known = node('div', 'minigames-known-clues');
            known.append(node('h4', '', `Known ability checks (${game.abilityChecks.length}/${CONFIG.abilityCheckLimit})`));
            if (!game.abilityChecks.length) known.append(node('p', 'minigames-empty-known', 'Your checks will appear here.'));
            for (const check of game.abilityChecks) {
                const row = node('div', `minigames-known-check is-${check.grade}`);
                const mark = check.grade === 'green' ? '✓' : check.grade === 'yellow' ? '≈' : '✗';
                row.append(node('span', 'minigames-check-mark', mark), node('span', 'minigames-known-check-text', check.text), node('span', 'minigames-known-check-grade', check.grade === 'green' ? 'Exact' : check.grade === 'yellow' ? 'Similar meaning' : 'No match'));
                known.append(row);
            }
            inputArea.append(known);
            ui.activeGame.append(inputArea);
            guessInput.focus({ preventScroll: true });
        } else {
            const ending = node('section', 'minigames-section minigames-ending-panel');
            const guessCount = game.guesses.length;
            ending.append(node('h4', '', game.status === 'won' ? `Solved in ${guessCount} ${guessCount === 1 ? 'guess' : 'guesses'}` : `Used ${game.wrongGuesses} wrong guesses`));
            ending.append(node('p', '', game.mode === 'daily' ? 'This daily attempt is saved and cannot be replayed today. Practice remains unlimited.' : 'Practice progress is saved in this browser.'));
            const endingActions = node('div', 'minigames-ending-actions');
            endingActions.append(actionButton(game.mode === 'daily' ? 'Play Practice' : 'Play again', 'minigames-button minigames-button-primary', () => game.mode === 'daily' ? startPractice() : startNewPractice()));
            endingActions.append(actionButton('Share result', 'minigames-button', shareResult));
            endingActions.append(actionButton('Back to minigames', 'minigames-button', () => { showListView(); setStatus(''); }));
            ending.append(endingActions);
            ui.activeGame.append(ending);
        }
    }

    function startNewPractice() {
        const previousId = game?.puzzleId || '';
        const puzzle = randomPuzzle(previousId);
        if (!puzzle) { setStatus('No usable puzzles are available.', 'warning'); return; }
        game = newGame(puzzle, 'practice');
        saveGame();
        showGameView();
        renderGame();
        setStatus('A new practice puzzle is ready.');
    }

    function getNameSuggestions(query, limit = 10) {
        if (!nameIndexReady || !query || normalizeName(query).length < 1) return [];
        const normalizedQuery = normalizeName(query);
        if (!normalizedQuery) return [];
        const start = lowerBoundName(normalizedQuery);
        const results = [];
        for (let i = start; i < cardNameEntries.length && results.length < limit; i++) {
            const entry = cardNameEntries[i];
            if (!entry.normalized.startsWith(normalizedQuery)) break;
            results.push(entry);
        }
        if (results.length < limit && normalizedQuery.length >= 3) {
            const seen = new Set(results.map(entry => entry.normalized));
            for (const entry of cardNameEntries) {
                if (!seen.has(entry.normalized) && entry.normalized.includes(normalizedQuery)) {
                    results.push(entry); seen.add(entry.normalized);
                    if (results.length >= limit) break;
                }
            }
        }
        return results;
    }

    function lowerBoundName(prefix) {
        let low = 0, high = cardNameEntries.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (cardNameEntries[mid].normalized < prefix) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    async function shareResult() {
        if (!game) return;
        const puzzle = getCurrentPuzzle();
        const icons = game.abilityChecks.map(check => check.grade === 'green' ? '🟩' : check.grade === 'yellow' ? '🟨' : '⬛').join('') || '—';
        const result = [
            `ManaSearch — Guess the Source (${game.mode === 'daily' ? `Daily ${game.dailyDate}` : 'Practice'})`,
            `${game.status === 'won' ? 'Solved' : 'Revealed'} in ${game.guesses.length} guesses; ${game.wrongGuesses}/${CONFIG.wrongGuessLimit} wrong guesses`,
            `Ability checks: ${icons}`,
            game.status === 'won' ? '🟩 WON' : '⬛ LOST',
            `https://github.com/DainisssYT/manasearch`
        ].join('\n');
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result);
            else {
                const textArea = node('textarea');
                textArea.value = result; textArea.setAttribute('readonly', '');
                textArea.style.position = 'fixed'; textArea.style.opacity = '0';
                document.body.append(textArea); textArea.select();
                const success = document.execCommand('copy'); textArea.remove();
                if (!success) throw new Error('Clipboard unavailable');
            }
            setStatus(`Result copied${puzzle?.card?.name ? ` for ${puzzle.card.name}` : ''}.`, 'success');
        } catch (_) { setStatus(result, 'warning'); }
    }

    function loadPuzzleData(raw) {
        const source = Array.isArray(raw?.puzzles) ? raw.puzzles : [];
        const api = window.ManaSearchApi;
        const checked = [];
        for (const puzzle of source) {
            const card = api.getCardByName(puzzle.answer);
            if (!card || !Array.isArray(puzzle.candidates)) continue;
            if (!String(api.getOracleText(card) || '').trim()) continue;
            const candidates = [];
            const candidateSeen = new Set();
            for (const candidate of puzzle.candidates) {
                const candidateCard = api.getCardByName(candidate.name);
                if (!candidateCard || candidateCard.id === card.id || !candidateCard.name) continue;
                if (!String(api.getOracleText(candidateCard) || '').trim()) continue;
                if (shareNameWords(card.name, candidateCard.name)) continue;
                const key = normalizeName(candidateCard.name);
                if (candidateSeen.has(key)) continue;
                candidateSeen.add(key);
                candidates.push({ ...candidate, card: candidateCard });
            }
            if (candidates.length < 8) continue;
            checked.push({ ...puzzle, card, candidates: candidates.slice(0, 8) });
        }
        puzzles = checked;
        puzzleMap = new Map(puzzles.map(puzzle => [puzzle.id, puzzle]));
        if (game && !puzzleMap.has(game.puzzleId)) game = null;
    }

    function buildNameIndex() {
        if (nameIndexReady) return;
        const api = window.ManaSearchApi;
        const seen = new Map();
        for (const entry of api.getCardNames()) {
            const normalized = normalizeName(entry.name);
            if (!normalized || seen.has(normalized)) continue;
            seen.set(normalized, { name: entry.name, normalized });
        }
        cardNameEntries = [...seen.values()].sort((a, b) => a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : a.name.localeCompare(b.name));
        nameIndexReady = true;
    }

    async function openMinigames() {
        if (!ui.dialog || !ui.registry) return;
        if (!ui.dialog.open) {
            try { ui.dialog.showModal(); }
            catch (_) { ui.dialog.setAttribute('open', ''); }
        }
        ui.launch?.setAttribute('aria-expanded', 'true');
        showListView();
        setStatus('Loading the local card catalog…');
        try {
            if (!window.ManaSearchApi?.ready) throw new Error('ManaSearch card API is not available yet. Refresh the page and try again.');
            await window.ManaSearchApi.ready();
            if (!puzzles.length) {
                const response = await fetch(CONFIG.puzzlePath, { cache: 'no-cache' });
                if (!response.ok) throw new Error(`Puzzle file returned HTTP ${response.status}`);
                loadPuzzleData(await response.json());
                buildNameIndex();
            }
            if (!puzzles.length) throw new Error('No starter puzzles passed validation against cards.bin.');
            renderList();
            setStatus(`${puzzles.length} puzzles ready. Practice is unlimited; Daily uses the same puzzle for everyone each UTC day.`, 'success');
        } catch (error) {
            setStatus(`Minigames could not load: ${error?.message || error}. Check that the app, minigame files, cards.bin, and minigames/puzzles.json deployed together.`, 'warning');
        }
    }

    async function initialize() {
        if (!ui.launch || !ui.dialog || !ui.registry) return;
        // A recovery import can load this module if the first module request failed. Never
        // attach duplicate listeners if the original request finishes at the same time.
        if (ui.launch.dataset.minigamesBound !== 'true') {
            ui.launch.dataset.minigamesBound = 'true';
            ui.launch.addEventListener('click', openMinigames);
        }
        ui.close.addEventListener('click', () => ui.dialog.close());
        ui.back.addEventListener('click', () => { showListView(); setStatus(''); });
        ui.dialog.addEventListener('close', () => ui.launch.setAttribute('aria-expanded', 'false'));
        ui.dialog.addEventListener('click', event => {
            if (event.target === ui.dialog) ui.dialog.close();
        });
        ui.dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') ui.launch.focus({ preventScroll: true });
        });
        stats = { ...EMPTY_STATS(), ...stats, guessDistribution: stats.guessDistribution || {} };
        renderList();
    }

    /* Lightweight public regression harness; it does not issue a search or mutate search history. */
    async function runRegressionSuite() {
        await window.ManaSearchApi.ready();
        if (!puzzles.length) {
            const response = await fetch(CONFIG.puzzlePath, { cache: 'no-cache' });
            if (!response.ok) throw new Error('Puzzle file unavailable');
            loadPuzzleData(await response.json());
            buildNameIndex();
        }
        const cases = [
            { card: 'Sol Ring', text: '{T}: Add {C}{C}.', expected: 'green' },
            { card: 'Sol Ring', text: '{T}: Add {C}{C}', expected: 'green' },
            { card: 'Sol Ring', text: 'Add {C}', expected: 'yellow' },
            { card: 'Sol Ring', text: 'Add {G}', expected: 'yellow' },
            { card: 'Sol Ring', text: 'tap for mana', expected: 'yellow' },
            { card: 'Sol Ring', text: 'Add one mana', expected: 'yellow' },
            { card: 'Sol Ring', text: 'Add two mana of any color', expected: 'yellow' },
            { card: 'Sol Ring', text: '{T}: Add {C}.', expected: 'yellow' },
            { card: 'Sol Ring', text: '{T}: Add {R}{R}.', expected: 'yellow' },
            { card: 'Sol Ring', text: 'Add {C}{C}{C}', expected: 'yellow' },
            { card: 'Sol Ring', text: 'draw a card', expected: 'grey' },
            { card: 'Sol Ring', text: 'destroy target creature', expected: 'grey' },
            { card: 'Lightning Bolt', text: 'Lightning Bolt deals 3 damage to any target.', expected: 'green' },
            { card: 'Lightning Bolt', text: 'deals 3 damage to any target.', expected: 'green' },
            { card: 'Lightning Bolt', text: 'deals 2 damage to any target.', expected: 'yellow' },
            { card: 'Lightning Bolt', text: 'draw a card', expected: 'grey' },
            { card: 'Lightning Bolt', text: 'Add {C}', expected: 'grey' },
            { card: 'Doom Blade', text: 'Destroy target nonblack creature.', expected: 'green' },
            { card: 'Doom Blade', text: 'Destroy target creature.', expected: 'yellow' },
            { card: 'Doom Blade', text: 'Counter target spell.', expected: 'grey' },
            { card: 'Opt', text: 'Scry 1. Draw a card.', expected: 'green' },
            { card: 'Opt', text: 'Draw a card.', expected: 'green' },
            { card: 'Opt', text: 'Destroy target creature.', expected: 'grey' },
            { card: 'Cultivate', text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', expected: 'green' },
            { card: 'Cultivate', text: 'Search your library for up to two basic land cards', expected: 'green' },
            { card: 'Cultivate', text: 'Counter target spell.', expected: 'grey' },
            { card: 'Sign in Blood', text: 'Target player draws two cards and loses 2 life.', expected: 'green' },
            { card: 'Sign in Blood', text: 'Target player draws two cards', expected: 'green' },
            { card: 'Sign in Blood', text: 'Target player draws one card', expected: 'yellow' },
            { card: 'Sign in Blood', text: 'Create a Treasure token.', expected: 'grey' }
        ];
        const results = cases.map(item => {
            const card = window.ManaSearchApi.getCardByName(item.card);
            const actual = card ? gradeAbilityInput(item.text, card).grade : 'missing-card';
            return { ...item, actual, pass: actual === item.expected };
        });
        return { passed: results.filter(item => item.pass).length, total: results.length, ok: results.every(item => item.pass), results };
    }

    window.runManaSearchMinigameRegressionSuite = runRegressionSuite;
    window.ManaSearchMinigames = Object.freeze({
        config: CONFIG,
        registry: registry.map(({ id, title, description, built }) => ({ id, title, description, built })),
        open: openMinigames
    });
    void initialize();
})();
