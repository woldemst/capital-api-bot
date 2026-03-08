export function normalizeSymbol(value) {
    const symbol = String(value || "").trim().toUpperCase();
    return symbol || null;
}

export function normalizeSymbolList(values = []) {
    return (Array.isArray(values) ? values : [])
        .map((value) => normalizeSymbol(value))
        .filter(Boolean);
}

export function parseSymbolCsv(value) {
    return String(value || "")
        .split(",")
        .map((entry) => normalizeSymbol(entry))
        .filter(Boolean);
}

export function toUpperSymbolSet(values = []) {
    return new Set(normalizeSymbolList(values));
}
