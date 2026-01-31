/**
 * Parses AI interpretation text into named sections.
 * Expects ## headers: Saludo, Pasado, Presente, Futuro, Síntesis, Consejo
 */
export function parseInterpretationSections(rawText) {
    const sectionNames = ['saludo', 'pasado', 'presente', 'futuro', 'sintesis', 'consejo'];

    // Match ## Header lines (case-insensitive, accent-insensitive for Síntesis/Sintesis)
    const headerRegex = /^##\s+(Saludo|Pasado|Presente|Futuro|S[ií]ntesis|Consejo)\s*$/gim;

    const matches = [...rawText.matchAll(headerRegex)];

    if (matches.length === 0) {
        // AI didn't use headers — return entire text as fallback
        return { _raw: rawText, _sectioned: false };
    }

    const sections = {};

    for (let i = 0; i < matches.length; i++) {
        const headerName = matches[i][1]
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, ''); // Remove accents

        const startIndex = matches[i].index + matches[i][0].length;
        const endIndex = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
        const content = rawText.substring(startIndex, endIndex).trim();

        const key = sectionNames.find(s => headerName.startsWith(s)) || headerName;
        sections[key] = content;
    }

    sections._sectioned = true;
    return sections;
}

/**
 * Filters sections based on futureHidden flag.
 * When futureHidden=true:
 *   - saludo, pasado, presente: sent in full
 *   - futuro: only first sentence (teaser)
 *   - sintesis, consejo: NOT sent at all
 */
export function filterSectionsForPaywall(sections, futureHidden) {
    if (!futureHidden || !sections._sectioned) {
        return sections;
    }

    const filtered = {
        saludo: sections.saludo,
        pasado: sections.pasado,
        presente: sections.presente,
        _sectioned: true,
        _futureHidden: true
    };

    // Teaser for future: first sentence only
    if (sections.futuro) {
        const firstSentence = sections.futuro.match(/^[^.!?]*[.!?]/);
        filtered.futuro = firstSentence
            ? firstSentence[0] + ' ...'
            : sections.futuro.substring(0, 100) + '...';
    }

    // sintesis and consejo are NOT included
    return filtered;
}
