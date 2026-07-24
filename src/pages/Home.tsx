import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw, Orbit, ExternalLink, Loader2, Sparkles, Sparkle } from 'lucide-react'
import { GlobeScene, type SelectionInfo } from '@/lib/globe'
import { getSatMeta, type SatMeta } from '@/lib/satmeta'
import { fetchLive, fetchSnapshot, CATEGORY_META, type SatRecord, type Category, type TLESource } from '@/lib/tle'

const RATES = [1, 10, 60, 300, 1000]
const ALL_CATS = Object.keys(CATEGORY_META) as Category[]

// camera auto-rotate speed presets
const SPINS = [
  { label: 'Off', value: 0 },
  { label: 'Slow', value: 0.08 },
  { label: 'Fast', value: 0.35 },
] as const

function fmtUTC(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<GlobeScene | null>(null)
  const simMsRef = useRef(Date.now())
  const lastWallRef = useRef(performance.now())
  const rateRef = useRef(1)
  const pausedRef = useRef(false)

  const [tle, setTle] = useState<TLESource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(fmtUTC(Date.now()))
  const [rate, setRate] = useState(1)
  const [paused, setPaused] = useState(false)
  const [cats, setCats] = useState<Set<Category>>(new Set(ALL_CATS))
  const [counts, setCounts] = useState<Partial<Record<Category, number>>>({})
  const [visibleCount, setVisibleCount] = useState(0)
  const [selected, setSelected] = useState<SatRecord | null>(null)
  const [selInfo, setSelInfo] = useState<SelectionInfo | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SatRecord[]>([])
  const [spin, setSpin] = useState<number>(0.35)
  const [starsVisible, setStarsVisible] = useState(true)
  const [meta, setMeta] = useState<SatMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const deepLinkApplied = useRef(false)

  const applyData = (scene: GlobeScene, t: TLESource) => {
    const prevSelectedId = selectedRef.current?.noradId
    setTle(t)
    scene.setData(t.records)
    const c: Partial<Record<Category, number>> = {}
    for (const r of t.records) c[r.category] = (c[r.category] ?? 0) + 1
    setCounts(c)
    setVisibleCount(t.records.filter((r) => catsRef.current.has(r.category)).length)
    // re-select across data swaps
    if (prevSelectedId) {
      const match = t.records.find((r) => r.noradId === prevSelectedId)
      if (match) scene.select(match)
    }
    // deep link: ?sat=<noradId or name>
    if (!deepLinkApplied.current) {
      const q = new URLSearchParams(window.location.search).get('sat')
      if (q) {
        const hit =
          t.records.find((r) => String(r.noradId) === q) ??
          t.records.find((r) => r.name.toUpperCase().includes(q.toUpperCase()))
        if (hit) {
          scene.select(hit)
          deepLinkApplied.current = true
        }
      }
    }
  }

  const selectedRef = useRef<SatRecord | null>(null)
  const catsRef = useRef(cats)
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { catsRef.current = cats }, [cats])

  // init scene once
  useEffect(() => {
    if (!mountRef.current) return
    let scene: GlobeScene
    try {
      scene = new GlobeScene({
        container: mountRef.current,
        getSimTime: () => {
          const now = performance.now()
          const dt = now - lastWallRef.current
          lastWallRef.current = now
          if (!pausedRef.current) simMsRef.current += dt * rateRef.current
          return simMsRef.current
        },
        getRate: () => (pausedRef.current ? 0 : rateRef.current),
        onSelect: (rec, info) => {
          setSelected(rec)
          setSelInfo(info)
        },
        onFrame: (ms) => setClock(fmtUTC(ms)),
      })
    } catch (e) {
      setError(`WebGL initialization failed: ${String(e)}`)
      return
    }
    sceneRef.current = scene
    // snapshot first for instant display; live CelesTrak swaps in when it arrives
    fetchSnapshot()
      .then((t) => applyData(scene, t))
      .catch((e) => setError(String(e)))
    fetchLive().then((t) => {
      if (t) applyData(scene, t)
    })
    return () => scene.dispose()
  }, [])

  // sync category visibility
  useEffect(() => {
    sceneRef.current?.setVisibleCategories(cats)
    if (tle) setVisibleCount(tle.records.filter((r) => cats.has(r.category)).length)
  }, [cats, tle])

  // sync camera auto-rotate speed
  useEffect(() => {
    sceneRef.current?.setSpin(spin)
  }, [spin])

  // sync starfield visibility
  useEffect(() => {
    sceneRef.current?.setStarsVisible(starsVisible)
  }, [starsVisible])

  // fetch satellite metadata (image + info link) when selection changes
  useEffect(() => {
    if (!selected) {
      setMeta(null)
      setMetaLoading(false)
      return
    }
    let cancelled = false
    setMeta(null)
    setMetaLoading(true)
    getSatMeta(selected.name).then((m) => {
      if (cancelled) return
      setMeta(m)
      setMetaLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  const searchResults = useMemo(() => {
    if (!query.trim() || !sceneRef.current) return []
    return sceneRef.current.findSat(query)
  }, [query])

  useEffect(() => setResults(searchResults), [searchResults])

  const toggleCat = (c: Category) => {
    setCats((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  const applyRate = (r: number) => {
    rateRef.current = r
    setRate(r)
    setPaused(false)
    pausedRef.current = false
  }

  const togglePause = () => {
    pausedRef.current = !pausedRef.current
    setPaused(pausedRef.current)
  }

  const resetTime = () => {
    simMsRef.current = Date.now()
    rateRef.current = 1
    setRate(1)
    pausedRef.current = false
    setPaused(false)
  }

  const selectSat = (rec: SatRecord) => {
    sceneRef.current?.select(rec)
    setQuery('')
    setResults([])
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black font-sans text-white">
      <div ref={mountRef} className="absolute inset-0" />

      {/* vignette */}
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)' }} />

      {/* header */}
      <div className="absolute left-5 top-5 select-none">
        <h1 className="text-2xl font-bold tracking-[0.25em] text-white/95">
          ORBIT<span className="text-cyan-400">LIVE</span>
        </h1>
        <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-white/40">
          Real-time SGP4 constellation tracker
        </p>
        <div className="mt-3 font-mono text-lg tabular-nums text-cyan-300/90">{clock}</div>
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-white/45">
          {paused ? (
            <>
              <Pause size={10} className="text-amber-400" />
              <span>paused</span>
            </>
          ) : (
            <>
              <Play size={10} className="text-cyan-400" />
              <span>{rate}× real time</span>
            </>
          )}
          {tle && (
            <span className="ml-3">
              {visibleCount.toLocaleString()} / {tle.records.length.toLocaleString()} satellites
            </span>
          )}
        </div>
        {tle && (
          <div className="mt-1 font-mono text-[10px] text-white/30">
            TLE: {tle.source === 'celestrak' ? 'CelesTrak live' : 'bundled snapshot'} · propagated locally in browser
          </div>
        )}
      </div>

      {/* search */}
      <div className="absolute right-5 top-5 w-64">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or NORAD ID…"
          className="w-full rounded-md border border-white/15 bg-black/60 px-3 py-2 text-sm text-white placeholder-white/30 outline-none backdrop-blur-md focus:border-cyan-400/60"
        />
        {results.length > 0 && (
          <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-white/10 bg-black/80 backdrop-blur-md">
            {results.map((r) => (
              <button
                key={r.noradId}
                onClick={() => selectSat(r)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-cyan-400/10"
              >
                <span className="truncate text-white/85">{r.name}</span>
                <span
                  className="ml-2 shrink-0 font-mono text-[10px]"
                  style={{ color: CATEGORY_META[r.category].color }}
                >
                  {r.noradId}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* legend */}
      <div className="absolute bottom-24 left-5 rounded-lg border border-white/10 bg-black/55 p-3 backdrop-blur-md">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Constellations</div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
          {ALL_CATS.map((c) => {
            const active = cats.has(c)
            return (
              <button
                key={c}
                onClick={() => toggleCat(c)}
                className={`flex items-center gap-2 text-left text-xs transition-opacity ${active ? 'opacity-100' : 'opacity-35'}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: CATEGORY_META[c].color, boxShadow: active ? `0 0 6px ${CATEGORY_META[c].color}` : 'none' }}
                />
                <span className="text-white/80">{CATEGORY_META[c].label}</span>
                <span className="font-mono text-[10px] text-white/35">{(counts[c] ?? 0).toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* time controls */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1.5 pl-2 backdrop-blur-md">
        {/* play / pause */}
        <button
          onClick={togglePause}
          title={paused ? 'Resume' : 'Pause'}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-all ${
            paused
              ? 'bg-cyan-400 text-black shadow-[0_0_12px_rgba(34,211,238,0.5)]'
              : 'text-white/80 hover:bg-white/10'
          }`}
        >
          {paused ? <Play size={15} className="ml-0.5" fill="currentColor" /> : <Pause size={15} fill="currentColor" />}
        </button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* rate presets */}
        {RATES.map((r) => (
          <button
            key={r}
            onClick={() => applyRate(r)}
            className={`rounded-full px-3 py-1 font-mono text-xs transition-colors ${
              !paused && rate === r ? 'bg-cyan-400/25 text-cyan-300' : 'text-white/55 hover:bg-white/10'
            }`}
          >
            {r}×
          </button>
        ))}

        {/* reset to now */}
        <button
          onClick={resetTime}
          title="Reset to current time"
          className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
        >
          <RotateCcw size={14} />
        </button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* camera auto-rotate */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/5 p-0.5" title="Camera auto-rotate">
          <Orbit size={13} className="mx-1.5 text-white/40" />
          {SPINS.map((s) => (
            <button
              key={s.label}
              onClick={() => setSpin(s.value)}
              className={`rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                spin === s.value ? 'bg-cyan-400/25 text-cyan-300' : 'text-white/45 hover:bg-white/10'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* starfield toggle */}
        <button
          onClick={() => setStarsVisible((v) => !v)}
          title={starsVisible ? 'Hide background stars' : 'Show background stars'}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            starsVisible ? 'text-cyan-300 hover:bg-white/10' : 'text-white/40 hover:bg-white/10'
          }`}
        >
          {starsVisible ? <Sparkles size={15} /> : <Sparkle size={15} />}
        </button>
      </div>

      {/* selected satellite panel */}
      {selected && (
        <div className="absolute bottom-24 right-5 w-72 rounded-lg border border-white/10 bg-black/60 p-4 backdrop-blur-md">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-white/95">{selected.name}</div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider" style={{ color: CATEGORY_META[selected.category].color }}>
                {CATEGORY_META[selected.category].label} · #{selected.noradId}
              </div>
            </div>
            <button
              onClick={() => { sceneRef.current?.select(null); setSelected(null) }}
              className="text-white/40 hover:text-white"
            >
              ✕
            </button>
          </div>
          {/* image + source link */}
          {metaLoading && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-white/40">
              <Loader2 size={12} className="animate-spin" />
              fetching info…
            </div>
          )}
          {meta && !metaLoading && (
            <div className="mt-3">
              {meta.imageUrl && (
                <a href={meta.pageUrl} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-white/10">
                  <img
                    src={meta.imageUrl}
                    alt={meta.title}
                    className="h-32 w-full object-cover transition-transform duration-300 hover:scale-105"
                    loading="lazy"
                  />
                </a>
              )}
              <a
                href={meta.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 hover:underline"
              >
                <ExternalLink size={11} />
                {meta.title}
                {meta.description ? <span className="text-white/40">· {meta.description}</span> : null}
              </a>
            </div>
          )}
          {selInfo && (
            <div className="mt-3 grid grid-cols-2 gap-y-1.5 font-mono text-xs">
              <span className="text-white/40">Latitude</span>
              <span className="text-right text-cyan-200">{selInfo.lat.toFixed(3)}°</span>
              <span className="text-white/40">Longitude</span>
              <span className="text-right text-cyan-200">{selInfo.lon.toFixed(3)}°</span>
              <span className="text-white/40">Altitude</span>
              <span className="text-right text-cyan-200">{selInfo.altKm.toFixed(1)} km</span>
              <span className="text-white/40">Velocity</span>
              <span className="text-right text-cyan-200">{selInfo.velKmS.toFixed(2)} km/s</span>
              <span className="text-white/40">Period</span>
              <span className="text-right text-cyan-200">{selInfo.periodMin.toFixed(1)} min</span>
              <span className="text-white/40">Inclination</span>
              <span className="text-right text-cyan-200">{selInfo.inclination.toFixed(2)}°</span>
            </div>
          )}
          <div className="mt-3 border-t border-white/10 pt-2 text-[10px] text-white/35">
            Red = trailing orbit · white = orbit ahead · cyan circle = coverage footprint
          </div>
        </div>
      )}

      {/* hint */}
      <div className="pointer-events-none absolute bottom-6 right-5 text-right text-[10px] uppercase tracking-widest text-white/25">
        drag · rotate&nbsp;&nbsp;scroll · zoom&nbsp;&nbsp;click · track
      </div>

      {/* loading / error overlay */}
      {!tle && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black">
          {error ? (
            <div className="max-w-md text-center">
              <div className="text-red-400">Failed to load TLE data</div>
              <div className="mt-2 font-mono text-xs text-white/40">{error}</div>
            </div>
          ) : (
            <>
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
              <div className="mt-5 text-sm tracking-[0.3em] text-white/60">FETCHING TLE FROM CELESTRAK…</div>
              <div className="mt-2 text-[11px] text-white/30">~12,000 active satellites · no API key required</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
