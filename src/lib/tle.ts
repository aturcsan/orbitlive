import * as satellite from 'satellite.js'

export type Category =
  | 'starlink'
  | 'oneweb'
  | 'station'
  | 'gps'
  | 'glonass'
  | 'galileo'
  | 'beidou'
  | 'iridium'
  | 'weather'
  | 'other'

export interface SatRecord {
  name: string
  noradId: number
  line1: string
  line2: string
  satrec: satellite.SatRec
  category: Category
}

export const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  starlink: { label: 'Starlink', color: '#38e1ff' },
  oneweb: { label: 'OneWeb', color: '#a78bfa' },
  station: { label: 'Space Stations', color: '#ffffff' },
  gps: { label: 'GPS (Navstar)', color: '#4ade80' },
  glonass: { label: 'GLONASS', color: '#fb923c' },
  galileo: { label: 'Galileo', color: '#60a5fa' },
  beidou: { label: 'BeiDou', color: '#f87171' },
  iridium: { label: 'Iridium', color: '#f472b6' },
  weather: { label: 'Weather / EO', color: '#facc15' },
  other: { label: 'Other active', color: '#94a3b8' },
}

export function categorize(name: string): Category {
  const n = name.toUpperCase()
  if (n.includes('STARLINK')) return 'starlink'
  if (n.includes('ONEWEB')) return 'oneweb'
  if (n.includes('ISS') || n.includes('TIANGONG') || n.includes('CSS (') || n.includes('SPACE STATION')) return 'station'
  if (/\bGPS\b/.test(n) || n.includes('NAVSTAR')) return 'gps'
  if (n.includes('GLONASS')) return 'glonass'
  if (n.includes('GALILEO')) return 'galileo'
  if (n.includes('BEIDOU') || /^BDS/.test(n)) return 'beidou'
  if (n.includes('IRIDIUM')) return 'iridium'
  if (
    /\bNOAA\b/.test(n) || n.includes('GOES') || n.includes('METOP') || n.includes('METEOSAT') ||
    n.includes('HIMAWARI') || n.includes('FENGYUN') || n.includes('FENGYUN') || /^FY-/.test(n) ||
    n.includes('LANDSAT') || n.includes('SENTINEL') || n.includes('TERRA') || n.includes('AQUA') ||
    n.includes('SUOMI') || n.includes('ELECTRO-L') || n.includes('INSAT') || n.includes('DMSP')
  ) return 'weather'
  return 'other'
}

export function parseTLE(text: string): SatRecord[] {
  const lines = text.split(/\r?\n/)
  const out: SatRecord[] = []
  let i = 0
  while (i < lines.length) {
    let line = lines[i].trim()
    if (!line) { i++; continue }
    let name = ''
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) {
      name = line.replace(/^0 /, '').trim()
      i++
      line = (lines[i] || '').trim()
    }
    const l1 = line
    const l2 = (lines[i + 1] || '').trim()
    if (l1.startsWith('1 ') && l2.startsWith('2 ')) {
      try {
        const satrec = satellite.twoline2satrec(l1, l2)
        if (satrec && !isNaN(satrec.no)) {
          const noradId = parseInt(l1.substring(2, 7).trim(), 10)
          if (!name) name = `NORAD ${noradId}`
          out.push({ name, noradId, line1: l1, line2: l2, satrec, category: categorize(name) })
        }
      } catch {
        /* skip malformed */
      }
      i += 2
    } else {
      i++
    }
  }
  return out
}

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'
const LOCAL_SNAPSHOT = `${import.meta.env.BASE_URL}data/tle-active.txt`

export interface TLESource {
  records: SatRecord[]
  source: 'celestrak' | 'snapshot'
  fetchedAt: Date
}

/** Live CelesTrak fetch (CORS enabled, server updates every ~2h). Returns null on failure. */
export async function fetchLive(): Promise<TLESource | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(CELESTRAK_URL, { signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) {
      const text = await res.text()
      const records = parseTLE(text)
      if (records.length > 100) {
        return { records, source: 'celestrak', fetchedAt: new Date() }
      }
    }
  } catch {
    /* offline or blocked */
  }
  return null
}

/** Bundled snapshot — instant, always available. */
export async function fetchSnapshot(): Promise<TLESource> {
  const res = await fetch(LOCAL_SNAPSHOT)
  if (!res.ok) throw new Error(`snapshot fetch failed: HTTP ${res.status}`)
  const text = await res.text()
  return { records: parseTLE(text), source: 'snapshot', fetchedAt: new Date() }
}
