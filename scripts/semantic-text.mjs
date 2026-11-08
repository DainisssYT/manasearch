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

function splitAbilityText(text, maxWords = 160, overlapWords = 24) {
  const paragraphs = String(text || '').split(/\n+/).map(part => part.trim()).filter(Boolean);
  const chunks = [];
  for (const paragraph of paragraphs) {
    // Keep short, complete ability lines intact. Split only unusually long lines.
    const words = paragraph.split(/\s+/);
    if (words.length <= maxWords) {
      chunks.push(paragraph);
      continue;
    }
    let start = 0;
    while (start < words.length) {
      const end = Math.min(words.length, start + maxWords);
      chunks.push(words.slice(start, end).join(' '));
      if (end === words.length) break;
      start = Math.max(start + 1, end - overlapWords);
    }
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
      oracleText: face?.oracle_text || '',
      keywords: Array.isArray(card.keywords) ? card.keywords.join(' ') : ''
    }));
    const faceOracle = faces.map(face => face.oracleText).filter(Boolean).join(' ');
    const wholeOracle = String(card.oracle_text || '').trim();
    // Some layouts expose useful card-level Oracle text in addition to (or instead of) face text.
    if (wholeOracle && wholeOracle !== faceOracle) {
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
        oracleText: wholeOracle,
        keywords: Array.isArray(card.keywords) ? card.keywords.join(' ') : ''
      });
    }
    if (!faceOracle && wholeOracle && faces.length) faces[0].oracleText = wholeOracle;
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
    oracleText: card?.oracle_text || '',
    keywords: Array.isArray(card?.keywords) ? card.keywords.join(' ') : ''
  }];
}

export function buildSemanticDocuments(cards, options = {}) {
  const maxWords = Math.max(48, Number(options.maxWords) || 140);
  const overlapWords = Math.min(maxWords - 1, Math.max(0, Number(options.overlapWords) || 24));
  const documents = [];
  for (const card of cards || []) {
    if (!card?.name) continue;
    const faces = faceDescriptors(card);
    for (const face of faces) {
      const abilities = splitAbilityText(face.oracleText, maxWords, overlapWords);
      if (!abilities.length) continue;
      const context = [
        face.name && `card face ${face.name}`,
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
        face.defense && `defense ${face.defense}`
      ].filter(Boolean).join('. ');
      for (let i = 0; i < abilities.length; i++) {
        const normalized = normalizeOracleForEmbedding(`${context}. ability ${abilities[i]}`, face.name || card.name);
        if (normalized) documents.push({ name: card.name, text: normalized, face: face.name, abilityIndex: i });
      }
    }
  }
  return documents;
}
