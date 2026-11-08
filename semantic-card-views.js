export function normalizeManaSearchOracleText(text, cardName = '') {
  let value = String(text || '');
  if (!value) return '';
  if (cardName) {
    const escaped = String(cardName).split('').map(ch => '.^$*+?()[]{}|\\'.includes(ch) ? '\\' + ch : ch).join('');
    value = value.replace(new RegExp('\\b' + escaped + '\\b', 'gi'), 'this permanent');
  }
  value = value.replace(/\([^()]*\)/g, ' ')
    .replace(/\{T\}/gi, ' tap ').replace(/\{Q\}/gi, ' untap ')
    .replace(/\{[WUBRGC]\}/gi, ' colored mana ').replace(/\{\d+\}/g, ' generic mana ')
    .replace(/\{X\}/gi, ' X mana ').replace(/\{[^}]+\}/g, ' mana symbol ');
  const expansions = {
    cascade:' cascade reveals cards until a spell is found and casts it ',
    flashback:' flashback cast from graveyard ',
    prowess:' prowess gets plus one plus one when you cast a noncreature spell ',
    deathtouch:' deathtouch lethal damage destroys creature ',
    lifelink:' lifelink damage causes you to gain life ',
    trample:' trample excess combat damage to defending player ',
    vigilance:' vigilance does not tap to attack ', menace:' menace requires two or more blockers ',
    flying:' flying can be blocked only by flying or reach ', haste:' haste can attack and tap immediately ',
    hexproof:' hexproof cannot be targeted by opponents ',
    indestructible:' indestructible cannot be destroyed by damage or destroy effects '
  };
  for (const [keyword, expansion] of Object.entries(expansions)) {
    value = value.replace(new RegExp('\\b' + keyword + '\\b', 'gi'), ' ' + keyword + ' ' + expansion + ' ');
  }
  return value.replace(/[^a-z0-9+\-\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}
export function splitSemanticTextIntoChunks(text, { maxWords = 110, overlapWords = 28 } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const max = Math.max(48, Number(maxWords) || 110);
  const overlap = Math.max(8, Math.min(max - 16, Number(overlapWords) || 28));
  if (words.length <= max) return [words.join(' ')];
  const step = max - overlap;
  const anchor = words.slice(0, Math.min(24, Math.floor(max / 4))).join(' ');
  const chunks = [];
  for (let start = 0; start < words.length; start += step) {
    const body = words.slice(start, start + max).join(' ');
    if (!body) break;
    chunks.push(start === 0 ? body : anchor + ' … ' + body);
    if (start + max >= words.length) break;
  }
  return chunks;
}
export function buildSemanticOracleViews(card, options = {}) {
  if (!card || typeof card !== 'object') return [];
  const faces = Array.isArray(card.card_faces) && card.card_faces.length
    ? card.card_faces : [{ name: card.name, type_line: card.type_line, oracle_text: card.oracle_text }];
  const views = [];
  const seen = new Set();
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex];
    const oracle = String(face && face.oracle_text || (faceIndex === 0 ? card.oracle_text || '' : '')).trim();
    const prefix = [
      face && face.name && face.name !== card.name ? 'Card face ' + face.name + '.' : '',
      face && face.type_line || card.type_line ? 'Face type ' + (face && face.type_line || card.type_line) + '.' : ''
    ].filter(Boolean).join(' ');
    const abilities = oracle.split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (!abilities.length) {
      const metadata = [
        face && face.name || card.name,
        face && face.type_line || card.type_line,
        face && face.mana_cost || card.mana_cost,
        face && Array.isArray(face.colors) ? face.colors.join(' ') : (Array.isArray(card.colors) ? card.colors.join(' ') : ''),
        Array.isArray(card.keywords) ? card.keywords.join(' ') : '',
        Array.isArray(card.produced_mana) ? card.produced_mana.join(' ') : '',
        face && face.power || card.power,
        face && face.toughness || card.toughness,
        face && face.loyalty || card.loyalty,
        face && face.defense || card.defense
      ].filter(Boolean).join(' ');
      if (metadata) abilities.push(metadata);
    }
    for (let abilityIndex = 0; abilityIndex < abilities.length; abilityIndex++) {
      const chunks = splitSemanticTextIntoChunks(abilities[abilityIndex], options);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const text = [prefix, chunks[chunkIndex]].filter(Boolean).join(' ').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        views.push({ text, faceIndex, abilityIndex, chunkIndex });
      }
    }
  }
  return views;
}
