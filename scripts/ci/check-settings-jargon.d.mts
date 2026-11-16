interface JargonHit { term: string; human: string; mode: string; index: number }
interface JargonRow { surface: string; hits: JargonHit[] }
interface StockEntry { surface: string; term: string; count: number; reason: string }
export function findSettingsJargon(text: string): JargonHit[];
export function compareSettingsJargon(rows: JargonRow[], baseline: StockEntry[]): string[];
export function scanSettingsJargon(root?: string): JargonRow[];
