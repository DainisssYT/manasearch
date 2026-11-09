// Shared semantic-document construction for the static card index.
// Keep each face and rules-text ability independently searchable so long cards do not
// lose later abilities to the embedding model's input-length limit.

const KEYWORD_EXPANSIONS = {
  cascade: 'cascade reveals cards from the top of the library until a nonland card is found and casts it',
  flashback: 'flashback allows a spell to be cast from the graveyard',
  prowess: 'prowess gets plus one plus one whenever you cast a noncreature spell',
  deathtouch: 'deathtouch makes any amount of damage lethal to a creature',
  lifelink: 'lifelink damage causes its controller to gain that much life',
  trample: 'trample assigns excess combat damage to the defending player or planeswalker',
  vigilance: 'vigilance does not tap when attacking',
  menace: 'menace requires two or more creatures to block',
  flying: 'flying can be blocked only by creatures with flying or reach',
  haste: 'haste allows attacking and tap abilities immediately',
  hexproof: 'hexproof prevents being targeted by spells and abilities opponents control',
  indestructible: 'indestructible prevents destruction by damage and destroy effects'
};

const MANA_SYMBOLS = {
  W: 'white mana', U: 'blue mana', B: 'black mana', R: 'red mana',
  G: 'green mana', C: 'colorless mana', S: 'snow mana', T: 'tap symbol',
  Q: 'untap symbol', E: 'energy counter symbol', X: 'X mana'
};

function replaceManaSymbols(text) {
  return text.replace(/\{([^}]+)\}/g, (_, raw) => {
    const symbol = raw.toUpperCase();
    if (MANA_SYMBOLS[symbol]) return ` ${MANA_SYMBOLS[symbol]} `;
    if (/^\d+$/.test(symbol)) return ` ${symbol} generic mana `;
    if (/^\d+\/[WUBRGC]$/.test(symbol)) {
      const [amount, color] = symbol.split('/');
      return ` ${amount} generic or ${MANA_SYMBOLS[color]} `;
    }
    if (/^[WUBRGC]\/P$/.test(symbol)) return ` ${MANA_SYMBOLS[symbol[0]]} or two life phyrexian mana `;
    if (/^[WUBRGC]$/.test(symbol)) return ` ${MANA_SYMBOLS[symbol]} `;
    if (/^[WUBRGC]\/([WUBRGC])$/.test(symbol)) {
      const [a, b] = symbol.split('/');
      return ` ${MANA_SYMBOLS[a]} or ${MANA_SYMBOLS[b]} hybrid mana `;
    }
    if (symbol === 'P') return 'phyrexian mana pay two life';
    return ` ${symbol.toLowerCase().replace(/[^a-z0-9/]+/g, ' ')} mana symbol `;
  });
}

export function normalizeOracleForEmbedding(text, cardName = '') {
  let value = String(text || '');
  if (!value.trim()) return '';
  if (cardName) {
    const escaped = String(cardName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), 'this card');
  }
  // Do not discard parenthetical text: reminder text can contain the only occurrence
  // of a relevant mechanic, restriction, or rules clarification on a source card.
  value = replaceManaSymbols(value)
    .replace(/[^a-z0-9+\-\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [keyword, expansion] of Object.entries(KEYWORD_EXPANSIONS)) {
    value = value.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), ` ${keyword} ${expansion} `);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function splitAbilityText(text, maxWords = 48, overlapWords = 12) {
  const paragraphs = String(text || '').split(/\n+/).map(part => part.trim()).filter(Boolean);
  const chunks = [];
  const countWords = value => String(value || '').trim().split(/\s+/).filter(Boolean).length;

  const splitOversizedClause = (clause, anchorText = '') => {
    const words = String(clause || '').trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [words.join(' ')];
    const anchorWords = anchorText ? anchorText.split(/\s+/).filter(Boolean) : [];
    const safeAnchor = anchorWords.length
      ? anchorWords.slice(0, Math.min(anchorWords.length, Math.max(4, Math.floor(maxWords * 0.45))))
      : words.slice(0, Math.min(14, Math.max(4, Math.floor(maxWords * 0.45))));
    const hasExternalAnchor = anchorWords.length > 0;
    const prefix = hasExternalAnchor ? safeAnchor : [];
    const bodyBudget = Math.max(8, maxWords - prefix.length);
    const overlap = Math.min(bodyBudget - 1, Math.max(4, overlapWords));
    const output = [];
    let start = 0;
    while (start < words.length) {
      const firstWindow = output.length === 0 && !hasExternalAnchor;
      const end = Math.min(words.length, start + (firstWindow ? maxWords : bodyBudget));
      const body = words.slice(start, end);
      const merged = firstWindow ? body : [...prefix, ...body];
      output.push(merged.join(' '));
      if (end === words.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return output;
  };

  for (const paragraph of paragraphs) {
    // A short complete Oracle ability is always retained as one semantic document.
    if (countWords(paragraph) <= maxWords) {
      chunks.push(paragraph);
      continue;
    }

    // Prefer complete sentence and semicolon-clause boundaries. When an ability needs
    // several documents, carry its opening trigger/cost clause into later documents so
    // the effect tail is not represented as an unrelated instruction.
    const clauses = paragraph.split(/(?<=[.;])\s+/).map(part => part.trim()).filter(Boolean);
    if (clauses.length > 1) {
      const firstWords = countWords(clauses[0]);
      const anchorText = firstWords <= Math.floor(maxWords * 0.60)
        ? clauses[0]
        : clauses[0].split(/\s+/).slice(0, Math.max(8, Math.floor(maxWords * 0.45))).join(' ');
      let current = [clauses[0]];
      let currentWords = firstWords;

      for (const clause of clauses.slice(1)) {
        const clauseWords = countWords(clause);
        if (clauseWords > maxWords) {
          if (current.length) chunks.push(current.join(' '));
          chunks.push(...splitOversizedClause(clause, anchorText));
          current = [anchorText];
          currentWords = countWords(anchorText);
          continue;
        }
        if (currentWords + clauseWords <= maxWords) {
          current.push(clause);
          currentWords += clauseWords;
          continue;
        }
        chunks.push(current.join(' '));
        current = [anchorText, clause];
        currentWords = countWords(anchorText) + clauseWords;
        if (currentWords > maxWords) {
          chunks.push(...splitOversizedClause(clause, anchorText));
          current = [anchorText];
          currentWords = countWords(anchorText);
        }
      }
      if (current.length && current.some((part, index) => index > 0 || part !== anchorText)) {
        chunks.push(current.join(' '));
      } else if (current.length && chunks.length === 0) {
        chunks.push(current.join(' '));
      }
      continue;
    }

    // A single uninterrupted sentence is the fallback. Retain a short opening anchor
    // (usually its trigger and initial cost) in every continuation while overlapping
    // adjacent body windows to preserve local clause context.
    chunks.push(...splitOversizedClause(paragraph));
  }
  return chunks;
}

function faceDescriptors(card) {
  if (Array.isArray(card?.card_faces) && card.card_faces.length) {
    const faces = card.card_faces.map((face, index) => ({
      name: face?.name || `${card.name} face ${index + 1}`,
      manaCost: face?.mana_cost || '',
      typeLine: face?.type_line || card.type_line || '',
      colors: Array.isArray(face?.colors) ? face.colors.join(' ') : '',
      colorIndicator: Array.isArray(face?.color_indicator) ? face.color_indicator.join(' ') : (face?.color_indicator || ''),
      power: face?.power || '',
      toughness: face?.toughness || '',
      loyalty: face?.loyalty || '',
      defense: face?.defense || '',
      handModifier: face?.hand_modifier || '',
      lifeModifier: face?.life_modifier || '',
      oracleText: face?.oracle_text || '',
      keywords: Array.isArray(card.keywords) ? card.keywords.join(' ') : ''
    }));
    const faceOracle = faces.map(face => face.oracleText).filter(Boolean).join(' ');
    const wholeOracle = String(card.oracle_text || '').trim();
    const normalizeSpacing = value => String(value || '').replace(/\s+/g, ' ').trim();
    // Some layouts expose useful card-level Oracle text in addition to (or instead of) face text.
    if (wholeOracle && normalizeSpacing(wholeOracle) !== normalizeSpacing(faceOracle)) {
      faces.push({
        name: card.name,
        manaCost: card.mana_cost || '',
        typeLine: card.type_line || '',
        colors: Array.isArray(card.colors) ? card.colors.join(' ') : '',
        colorIndicator: '',
        power: card.power || '',
        toughness: card.toughness || '',
        loyalty: card.loyalty || '',
        defense: card.defense || '',
        handModifier: card.hand_modifier || '',
        lifeModifier: card.life_modifier || '',
        oracleText: wholeOracle,
        keywords: Array.isArray(card.keywords) ? card.keywords.join(' ') : ''
      });
    }
    // If only card-level Oracle text exists, do not also emit empty face-profile rows.
    if (!faceOracle && wholeOracle) return faces.slice(-1);
    return faces;
  }
  return [{
    name: card?.name || '',
    manaCost: card?.mana_cost || '',
    typeLine: card?.type_line || '',
    colors: Array.isArray(card?.colors) ? card.colors.join(' ') : '',
    colorIndicator: '',
    power: card?.power || '',
    toughness: card?.toughness || '',
    loyalty: card?.loyalty || '',
    defense: card?.defense || '',
    handModifier: card?.hand_modifier || '',
    lifeModifier: card?.life_modifier || '',
    oracleText: card?.oracle_text || '',
    keywords: Array.isArray(card?.keywords) ? card.keywords.join(' ') : ''
  }];
}

export function buildSemanticDocuments(cards, options = {}) {
  // Keep a conservative browser/build-time word cap. The static builder additionally
  // validates every finished document with the model's actual tokenizer before embedding.
  const maxWords = Math.max(16, Number(options.maxWords) || 48);
  const overlapWords = Math.min(maxWords - 1, Math.max(0, Number(options.overlapWords) || 12));
  const documents = [];
  for (const card of cards || []) {
    if (!card?.name) continue;
    const faces = faceDescriptors(card);
    for (const face of faces) {
      const abilities = splitAbilityText(face.oracleText, maxWords, overlapWords);
      const context = [
        face.name && `card face ${face.name}`,
        card.layout && `layout ${card.layout}`,
        face.typeLine && `type ${face.typeLine}`,
        face.manaCost && `mana cost ${face.manaCost}`,
        face.colors && `colors ${face.colors}`,
        face.colorIndicator && `color indicator ${face.colorIndicator}`,
        face.keywords && `keywords ${face.keywords}`,
        Array.isArray(card.color_identity) && card.color_identity.length ? `color identity ${card.color_identity.join(' ')}` : '',
        Array.isArray(card.produced_mana) && card.produced_mana.length ? `produces ${card.produced_mana.join(' ')} mana` : '',
        Number.isFinite(Number(card.cmc)) ? `mana value ${card.cmc}` : '',
        face.power && `power ${face.power}`,
        face.toughness && `toughness ${face.toughness}`,
        face.loyalty && `loyalty ${face.loyalty}`,
        face.defense && `defense ${face.defense}`,
        face.handModifier && `hand modifier ${face.handModifier}`,
        face.lifeModifier && `life modifier ${face.lifeModifier}`
      ].filter(Boolean).join('. ');
      if (!abilities.length) {
        const profile = normalizeOracleForEmbedding(`card profile ${context}`, face.name || card.name);
        if (profile) documents.push({ name: card.name, text: profile, contextText: profile, abilityText: '', face: face.name, abilityIndex: -1, kind: 'profile' });
        continue;
      }
      for (let i = 0; i < abilities.length; i++) {
        const normalized = normalizeOracleForEmbedding(`${context}. ability ${abilities[i]}`, face.name || card.name);
        if (normalized) documents.push({ name: card.name, text: normalized, contextText: context, abilityText: abilities[i], face: face.name, abilityIndex: i });
      }
    }
  }
  return documents;
}


/**
 * Merge ranked semantic retrieval lists from the full-card intent, full Oracle text,
 * and each independently queried face/ability. Reciprocal Rank Fusion rewards cards
 * that are consistently relevant across independent views without assuming that their
 * raw cosine scores are perfectly calibrated against one another.
 *
 * The maximum calibrated cosine remains available as "similarity" for existing scoring.
 * Ability coverage is reported separately so callers can use it as a small, explicit
 * coverage signal instead of averaging vectors and diluting a strong single-ability match.
 */
export function mergeSemanticRetrievalRanks(querySets, queryViews = [], options = {}) {
  const rrfK = Math.max(1, Number(options.rrfK) || 60);
  const abilityViews = [...new Set((queryViews || [])
    .map(view => String(view || ''))
    .filter(view => /^ability-/i.test(view)))];
  const totalAbilities = abilityViews.length;
  const byCard = new Map();

  for (let queryIndex = 0; queryIndex < (querySets || []).length; queryIndex++) {
    const set = Array.isArray(querySets[queryIndex]) ? querySets[queryIndex] : [];
    const view = String(queryViews[queryIndex] || `query-${queryIndex + 1}`);
    const isAbilityView = /^ability-/i.test(view);
    for (let rankIndex = 0; rankIndex < set.length; rankIndex++) {
      const item = set[rankIndex];
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const key = name.normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!key) continue;

      let entry = byCard.get(key);
      if (!entry) {
        entry = {
          ...item,
          name,
          similarity: Number(item.similarity) || 0,
          _semanticViews: new Set(),
          _semanticAbilityViews: new Set(),
          _semanticRrfScore: 0
        };
        byCard.set(key, entry);
      }
      entry.similarity = Math.max(entry.similarity, Number(item.similarity) || 0);
      entry._semanticViews.add(view);
      if (isAbilityView) entry._semanticAbilityViews.add(view);
      // The result arrays are already sorted by similarity, so their position is the rank.
      entry._semanticRrfScore += 1 / (rrfK + rankIndex + 1);
    }
  }

  return [...byCard.values()]
    .map(entry => {
      const covered = entry._semanticAbilityViews.size;
      const views = [...entry._semanticViews];
      const maxRrf = querySets.length / (rrfK + 1);
      return {
        ...entry,
        _semanticViews: views,
        _semanticAbilityCoverage: covered,
        _semanticAbilityTotal: totalAbilities,
        _semanticAbilityCoverageRatio: totalAbilities ? covered / totalAbilities : 0,
        _semanticRrfScoreRatio: maxRrf > 0 ? entry._semanticRrfScore / maxRrf : 0
      };
    })
    .sort((a, b) =>
      (b._semanticRrfScore - a._semanticRrfScore) ||
      (b.similarity - a.similarity) ||
      String(a.name).localeCompare(String(b.name))
    );
}


/**
 * Enforce the model's real tokenizer limit before any document reaches the embedding
 * pipeline. Oversized ability documents are recursively split with overlapping word
 * windows; the original face/card context is repeated so each fragment remains grounded.
 * This is deliberately a build-time operation: end-user searches never download or
 * tokenize the full corpus.
 */
export async function enforceSemanticTokenBudget(documents, tokenizer, options = {}) {
  if (typeof tokenizer !== 'function') throw new TypeError('A Transformers.js tokenizer function is required.');
  const maxTokens = Math.max(32, Number(options.maxTokens) || 240);
  const minWords = Math.max(4, Number(options.minWords) || 8);
  const output = [];
  const pending = (documents || []).map(document => ({ ...document, chunkDepth: 0 }));

  const getTokenCount = async text => {
    const encoded = await tokenizer(text, { padding: false, truncation: false });
    const ids = encoded?.input_ids;
    const dims = Array.isArray(ids?.dims) ? ids.dims : null;
    const count = dims?.length ? Number(dims[dims.length - 1]) :
      (Number.isFinite(Number(ids?.size)) ? Number(ids.size) :
      (ArrayBuffer.isView(ids?.data) ? ids.data.length :
      (Array.isArray(ids) ? ids.length : NaN)));
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('Tokenizer returned no measurable input_ids for a semantic document.');
    }
    return count;
  };

  while (pending.length) {
    const document = pending.shift();
    const tokenCount = await getTokenCount(document.text);
    if (tokenCount <= maxTokens) {
      output.push({ ...document, tokenCount });
      continue;
    }

    const words = String(document.abilityText || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < minWords * 2 || document.chunkDepth >= 8) {
      throw new Error(
        `Semantic document for "${document.name}" (${document.face || 'card profile'}) needs ${tokenCount} tokens; cannot safely split below the ${maxTokens}-token budget.`
      );
    }

    const ratio = Math.min(0.8, maxTokens / tokenCount * 0.78);
    const chunkWords = Math.max(minWords, Math.floor(words.length * ratio));
    const overlapWords = Math.min(Math.floor(chunkWords / 4), Math.max(4, Number(options.overlapWords) || 8));
    const chunks = splitAbilityText(document.abilityText, chunkWords, overlapWords);
    if (chunks.length < 2) {
      throw new Error(`Unable to split oversized semantic ability for "${document.name}" safely.`);
    }

    for (const [index, abilityText] of chunks.entries()) {
      const normalized = normalizeOracleForEmbedding(
        `${document.contextText || ''}. ability ${abilityText}`,
        document.face || document.name || ''
      );
      pending.push({
        ...document,
        text: normalized,
        abilityText,
        chunkDepth: document.chunkDepth + 1,
        chunkIndex: (Number(document.chunkIndex) || 0) + index
      });
    }
  }

  return output;
}
