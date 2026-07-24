// Satellite metadata lookup (image + info link) via Wikipedia / Wikimedia.
// Wikipedia has good coverage of notable satellites (stations, GPS, weather,
// science missions). For mass-constellation birds (Starlink, OneWeb, ...) we
// synthesize a representative article. Results are cached per name.

export interface SatMeta {
  title: string
  description?: string
  imageUrl?: string
  pageUrl: string
}

const cache = new Map<string, SatMeta | null>()

// clean a TLE name into a Wikipedia-friendly search term
function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical e.g. "(NAVSTAR 78)"
    .replace(/\b\d{1,2}[A-Z]?\b/g, ' ') // drop trailing block/plane numbers
    .replace(/\s+/g, ' ')
    .trim()
}

// well-known satellites -> their canonical Wikipedia article titles
const ALIASES: [RegExp, string][] = [
  [/^ISS\b|ZARYA|SPACE STATION/i, 'International Space Station'],
  [/TIANGONG|CSS/i, 'Tiangong space station'],
  [/HUBBLE/i, 'Hubble Space Telescope'],
  [/LANDSAT 8/i, 'Landsat 8'],
  [/LANDSAT 9/i, 'Landsat 9'],
  [/TERRA/i, 'Terra (satellite)'],
  [/AQUA/i, 'Aqua (satellite)'],
  [/SUOMI/i, 'Suomi NPP'],
  [/SENTINEL-1/i, 'Sentinel-1'],
  [/SENTINEL-2/i, 'Sentinel-2'],
  [/SENTINEL-3/i, 'Sentinel-3'],
  [/SENTINEL-5/i, 'Sentinel-5P'],
  [/SENTINEL-6/i, 'Sentinel-6 Michael Freilich'],
]

// mass constellations -> representative article
const CONSTELLATION: [RegExp, string][] = [
  [/STARLINK/i, 'Starlink'],
  [/ONEWEB/i, 'OneWeb'],
  [/\bGPS\b|NAVSTAR/i, 'GPS satellite blocks'],
  [/GLONASS/i, 'GLONASS'],
  [/GALILEO/i, 'Galileo (satellite navigation)'],
  [/BEIDOU|^BDS/i, 'BeiDou'],
  [/IRIDIUM/i, 'Iridium satellite constellation'],
  [/GOES/i, 'Geostationary Operational Environmental Satellite'],
  [/\bNOAA\b/i, 'Polar-orbiting operational environmental satellite'],
  [/METOP/i, 'MetOp'],
]

function resolveTitle(name: string): string {
  for (const [re, title] of ALIASES) if (re.test(name)) return title
  for (const [re, title] of CONSTELLATION) if (re.test(name)) return title
  return cleanName(name)
}

// a summary is only accepted if it's clearly about a space object —
// prevents showing unrelated articles (weapons, people, ...) for obscure names
const SPACE_TERMS = /satellite|spacecraft|space station|space telescope|orbit|rocket|NASA|ESA|constellation/i

function isSpaceRelated(j: { title?: string; description?: string; extract?: string }): boolean {
  const text = `${j.title ?? ''} ${j.description ?? ''} ${(j.extract ?? '').slice(0, 300)}`
  return SPACE_TERMS.test(text)
}

async function fetchSummary(title: string): Promise<SatMeta | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const j = await res.json()
  if (j.type === 'disambiguation' || !j.content_urls) return null
  if (!isSpaceRelated(j)) return null
  return {
    title: j.title ?? title,
    description: j.description,
    imageUrl: j.thumbnail?.source ?? j.originalimage?.source,
    pageUrl: j.content_urls.desktop.page,
  }
}

/** look up image + info link for a satellite; null if nothing found */
export async function getSatMeta(name: string): Promise<SatMeta | null> {
  const key = name.toUpperCase()
  if (cache.has(key)) return cache.get(key) ?? null

  // only curated exact/constellation matches are looked up — never an open
  // search, so an obscure name can never surface an unrelated article/image
  const meta = await fetchSummary(resolveTitle(name)).catch(() => null)

  cache.set(key, meta)
  return meta
}
