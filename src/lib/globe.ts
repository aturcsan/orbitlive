import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as satellite from 'satellite.js'
import type { SatRecord, Category } from './tle'
import { CATEGORY_META } from './tle'

export const EARTH_RADIUS_KM = 6371
const SCALE = 1 / EARTH_RADIUS_KM // 1 scene unit = earth radius

const DEG2RAD = Math.PI / 180
const UP_Y = new THREE.Vector3(0, 1, 0)

/** lat/lon (deg, earth-fixed) -> three.js vector matching equirect texture orientation */
export function latLonToVec3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * DEG2RAD
  const theta = (lon + 180) * DEG2RAD
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

function hexColor(hex: string): THREE.Color {
  return new THREE.Color(hex)
}

export interface SelectionInfo {
  lat: number
  lon: number
  altKm: number
  velKmS: number
  periodMin: number
  inclination: number
}

interface Props {
  container: HTMLElement
  getSimTime: () => number // ms epoch
  getRate: () => number
  onSelect: (rec: SatRecord | null, info: SelectionInfo | null) => void
  onFrame?: (simMs: number) => void
}

export class GlobeScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private earth: THREE.Mesh
  private sunLight: THREE.DirectionalLight
  private stars: THREE.Points
  private satPoints: THREE.Points | null = null
  private satMat: THREE.ShaderMaterial | null = null
  private records: SatRecord[] = []
  private visible: SatRecord[] = []
  private visibleCats: Set<Category> = new Set(Object.keys(CATEGORY_META) as Category[])

  // incremental propagation state (chunked to avoid frame spikes)
  private posA: Float32Array = new Float32Array(0)
  private posB: Float32Array = new Float32Array(0)
  private tA = 0
  private tB = 0
  private propIndex = 0
  private propTarget = 0

  private orbitLine: THREE.LineSegments | null = null
  private footprint: THREE.Line | null = null
  private selSprite: THREE.Sprite | null = null
  private selected: SatRecord | null = null
  private lastSelUpdate = 0

  private raycaster = new THREE.Raycaster()
  private sunUniform = { value: new THREE.Vector3(1, 0, 0) }
  private pointer = new THREE.Vector2()
  private raf = 0
  private disposed = false
  private props: Props
  private lastFrameCb = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private spinSpeed = 0.35

  /** set camera auto-rotate speed (0 = off). honored by idle-resume too */
  setSpin(speed: number) {
    this.spinSpeed = speed
    this.controls.autoRotateSpeed = speed
    this.controls.autoRotate = speed > 0
  }

  /** toggle background starfield visibility */
  setStarsVisible(visible: boolean) {
    this.stars.visible = visible
  }

  constructor(props: Props) {
    this.props = props
    const { container } = props

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.05,
      300,
    )
    this.camera.position.set(0.4, 0.9, 3.4)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 1.35
    this.controls.maxDistance = 14
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = this.spinSpeed
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false
      if (this.idleTimer) clearTimeout(this.idleTimer)
    })
    this.controls.addEventListener('end', () => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => {
        this.controls.autoRotate = this.spinSpeed > 0
      }, 10000)
    })

    // ---- lights
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.6)
    this.scene.add(this.sunLight)
    this.scene.add(new THREE.AmbientLight(0x334466, 0.35))

    // ---- earth
    const loader = new THREE.TextureLoader()
    // use the GPU's max anisotropic filtering for crisp textures at glancing angles
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy()
    const tune = (t: THREE.Texture) => {
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = maxAniso
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      t.wrapS = THREE.RepeatWrapping
      t.wrapT = THREE.ClampToEdgeWrapping
      t.generateMipmaps = true
      return t
    }
    const dayTex = tune(loader.load(`${import.meta.env.BASE_URL}textures/earth-blue-marble.jpg`))
    const nightTex = tune(loader.load(`${import.meta.env.BASE_URL}textures/earth-night.jpg`))
    const earthMat = new THREE.MeshPhongMaterial({
      map: dayTex,
      shininess: 6,
      specular: new THREE.Color(0x223344),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: nightTex,
      emissiveIntensity: 1.1,
    })
    // blend city lights in only on the night side
    earthMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunDir = this.sunUniform
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldNormal;')
        .replace(
          '#include <defaultnormal_vertex>',
          '#include <defaultnormal_vertex>\nvWorldNormal = normalize(mat3(modelMatrix) * normal);',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWorldNormal;\nuniform vec3 uSunDir;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float dayF = smoothstep(-0.12, 0.30, dot(normalize(vWorldNormal), normalize(uSunDir)));
          totalEmissiveRadiance *= (1.0 - dayF);`,
        )
    }
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMat)
    this.scene.add(this.earth)

    // ---- atmosphere glow (two shells)
    this.scene.add(this.makeAtmosphere(1.022, 0.9, 0x4d8dff))
    this.scene.add(this.makeAtmosphere(1.14, 0.32, 0x2a5cff))

    // ---- starfield
    this.stars = this.makeStars()
    this.scene.add(this.stars)

    // ---- picking
    this.raycaster.params.Points = { threshold: 0.006 }
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)

    window.addEventListener('resize', this.onResize)

    this.animate()
  }

  private makeAtmosphere(scale: number, intensity: number, color: number): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        c: { value: intensity },
        glowColor: { value: new THREE.Color(color) },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float c;
        uniform vec3 glowColor;
        varying vec3 vNormal;
        void main() {
          float f = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.5);
          gl_FragColor = vec4(glowColor, 1.0) * f * c;
        }`,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
    return new THREE.Mesh(new THREE.SphereGeometry(scale, 64, 64), mat)
  }

  private makeStars(): THREE.Points {
    const N = 4500
    const pos = new Float32Array(N * 3)
    const col = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(120 + Math.random() * 80)
      pos.set([v.x, v.y, v.z], i * 3)
      const b = 0.35 + Math.random() * 0.65
      const tint = Math.random()
      col.set([b, b * (0.92 + tint * 0.08), b * (0.85 + (1 - tint) * 0.15)], i * 3)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    return new THREE.Points(geo, mat)
  }

  setData(records: SatRecord[]) {
    this.records = records
    this.rebuildPoints()
  }

  setVisibleCategories(cats: Set<Category>) {
    this.visibleCats = cats
    this.rebuildPoints()
    if (this.selected && !cats.has(this.selected.category)) this.clearSelection()
  }

  findSat(query: string): SatRecord[] {
    const q = query.trim().toUpperCase()
    if (!q) return []
    const out: SatRecord[] = []
    for (const r of this.records) {
      if (r.name.toUpperCase().includes(q) || String(r.noradId) === q) {
        out.push(r)
        if (out.length >= 12) break
      }
    }
    return out
  }

  private rebuildPoints() {
    if (this.satPoints) {
      this.scene.remove(this.satPoints)
      this.satPoints.geometry.dispose()
      ;(this.satPoints.material as THREE.Material).dispose()
      this.satPoints = null
    }
    this.visible = this.records.filter((r) => this.visibleCats.has(r.category))
    const n = this.visible.length
    if (n === 0) return

    const positions = new Float32Array(n * 3)
    const colors = new Float32Array(n * 3)
    const sizes = new Float32Array(n)
    this.posA = new Float32Array(n * 3)
    this.posB = new Float32Array(n * 3)

    this.visible.forEach((r, i) => {
      const c = hexColor(CATEGORY_META[r.category].color)
      colors.set([c.r, c.g, c.b], i * 3)
      sizes[i] = r.category === 'station' ? 9 : r.noradId === 25544 ? 10 : 3.4
    })

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

    this.satMat = new THREE.ShaderMaterial({
      uniforms: { scaleH: { value: this.renderer.domElement.clientHeight * 0.5 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float scaleH;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * scaleH * 0.02 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          // 50% sharper again: very tight falloff band (was smoothstep(0.29, 0.04, d))
          float alpha = smoothstep(0.145, 0.02, d);
          gl_FragColor = vec4(vColor * (1.0 + alpha * 0.6), alpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.satPoints = new THREE.Points(geo, this.satMat)
    this.satPoints.frustumCulled = false
    this.scene.add(this.satPoints)

    // warm start: propagate everything once so first frame is correct
    const simMs = this.props.getSimTime()
    this.propagateAll(simMs, this.posA)
    this.posB.set(this.posA)
    this.tA = this.tB = simMs
    this.propIndex = 0
  }

  /** propagate all visible satellites at simMs into out buffer */
  private propagateAll(simMs: number, out: Float32Array) {
    const date = new Date(simMs)
    for (let i = 0; i < this.visible.length; i++) {
      const p = satellite.propagate(this.visible[i].satrec, date)
      if (p && typeof p !== 'boolean') {
        out[i * 3] = p.position.x * SCALE
        out[i * 3 + 1] = p.position.z * SCALE
        out[i * 3 + 2] = -p.position.y * SCALE
      } else {
        out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0
      }
    }
  }

  private updateSelectionOverlays(simMs: number, gmst: number) {
    const rec = this.selected
    if (!rec) return

    // orbit path: one full period sampled in ECI
    // red = trailing 50% (behind current position), white = 50% ahead
    const periodMin = (2 * Math.PI) / rec.satrec.no
    const N = 220
    const segPos = new Float32Array(N * 2 * 3)
    const segCol = new Float32Array(N * 2 * 3)
    let prev: [number, number, number] | null = null
    for (let i = 0; i <= N; i++) {
      const t = new Date(simMs + ((i / N) - 0.5) * periodMin * 60000)
      const p = satellite.propagate(rec.satrec, t)
      const cur: [number, number, number] =
        p && typeof p !== 'boolean'
          ? [p.position.x * SCALE, p.position.z * SCALE, -p.position.y * SCALE]
          : [0, 0, 0]
      if (prev) {
        const behind = i <= N / 2
        const r = behind ? 1 : 1
        const g = behind ? 0.25 : 1
        const b = behind ? 0.25 : 1
        const o = (i - 1) * 6
        segPos.set([prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]], o)
        segCol.set([r, g, b, r, g, b], o)
      }
      prev = cur
    }
    if (!this.orbitLine) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(segPos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(segCol, 3))
      this.orbitLine = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
      )
      this.orbitLine.frustumCulled = false
      this.scene.add(this.orbitLine)
    } else {
      this.orbitLine.geometry.setAttribute('position', new THREE.BufferAttribute(segPos, 3))
      this.orbitLine.geometry.setAttribute('color', new THREE.BufferAttribute(segCol, 3))
    }

    // geodetic state now
    const now = new Date(simMs)
    const pv = satellite.propagate(rec.satrec, now)
    if (!pv || typeof pv === 'boolean') return
    const geo = satellite.eciToGeodetic(pv.position, gmst)
    const lat = satellite.degreesLat(geo.latitude)
    const lon = satellite.degreesLong(geo.longitude)
    const altKm = geo.height
    const velKmS = Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2)

    // footprint circle (earth-fixed, child of earth mesh)
    const rho = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)) // central angle
    const M = 90
    const fp = new Float32Array((M + 1) * 3)
    const latR = lat * DEG2RAD
    const lonR = lon * DEG2RAD
    for (let i = 0; i <= M; i++) {
      const az = (i / M) * 2 * Math.PI
      // destination point from (lat,lon) with angular distance rho, bearing az
      const sLat = Math.asin(
        Math.sin(latR) * Math.cos(rho) + Math.cos(latR) * Math.sin(rho) * Math.cos(az),
      )
      const sLon =
        lonR +
        Math.atan2(
          Math.sin(az) * Math.sin(rho) * Math.cos(latR),
          Math.cos(rho) - Math.sin(latR) * Math.sin(sLat),
        )
      const v = latLonToVec3(sLat / DEG2RAD, sLon / DEG2RAD, 1.002)
      fp.set([v.x, v.y, v.z], i * 3)
    }
    if (!this.footprint) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(fp, 3))
      this.footprint = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85 }),
      )
      this.footprint.frustumCulled = false
      this.earth.add(this.footprint)
    } else {
      this.footprint.geometry.setAttribute('position', new THREE.BufferAttribute(fp, 3))
    }

    // selection sprite at satellite
    if (!this.selSprite) {
      this.selSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeRingTexture(),
          color: 0xffffff,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      )
      this.selSprite.scale.setScalar(0.045)
      this.scene.add(this.selSprite)
    }
    this.selSprite.position.set(pv.position.x * SCALE, pv.position.z * SCALE, -pv.position.y * SCALE)

    this.props.onSelect(rec, {
      lat, lon, altKm, velKmS, periodMin,
      inclination: rec.satrec.inclo / DEG2RAD,
    })
  }

  select(rec: SatRecord | null) {
    this.clearSelection()
    this.selected = rec
    if (rec && !this.visibleCats.has(rec.category)) {
      this.visibleCats = new Set([...this.visibleCats, rec.category])
      this.rebuildPoints()
    }
  }

  private clearSelection() {
    this.selected = null
    for (const key of ['orbitLine', 'footprint', 'selSprite'] as const) {
      const obj = this[key]
      if (obj) {
        obj.parent?.remove(obj)
        if ('geometry' in obj) (obj as THREE.Object3D & { geometry: THREE.BufferGeometry }).geometry.dispose()
        ;(obj as unknown as { material: THREE.Material }).material.dispose()
        this[key] = null
      }
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', onUp)
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) return // was a drag
      this.handlePick(ev)
    }
    window.addEventListener('pointerup', onUp)
  }

  private handlePick(e: PointerEvent) {
    if (!this.satPoints) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.satPoints)
    if (hits.length > 0 && hits[0].index !== undefined) {
      const rec = this.visible[hits[0].index]
      this.select(rec)
    } else {
      this.clearSelection()
      this.props.onSelect(null, null)
    }
  }

  private onResize = () => {
    const { container } = this.props
    this.camera.aspect = container.clientWidth / container.clientHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(container.clientWidth, container.clientHeight)
  }

  private sunDirection(simMs: number): THREE.Vector3 {
    const d = new Date(simMs)
    const start = Date.UTC(d.getUTCFullYear(), 0, 0)
    const dayOfYear = (simMs - start) / 86400000
    const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10)) // deg
    const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
    const subLon = (12 - utcHours) * 15 // deg
    return latLonToVec3(decl, subLon, 10)
  }

  private animate = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)

    const simMs = this.props.getSimTime()
    const rate = this.props.getRate()
    const now = performance.now()

    // earth rotation + sun (sun vector is earth-fixed -> rotate into world by gmst)
    const gmst = satellite.gstime(new Date(simMs))
    this.earth.rotation.y = gmst
    const sunWorld = this.sunDirection(simMs).applyAxisAngle(UP_Y, gmst)
    this.sunLight.position.copy(sunWorld)
    this.sunUniform.value.copy(sunWorld).normalize()

    // satellite propagation: chunked full passes with double buffering + lerp
    if (this.satPoints && this.visible.length > 0) {
      if (this.propIndex === 0) {
        // next pass target: ~400ms (wall) worth of sim time ahead
        this.propTarget = simMs + 400 * Math.max(rate, 1)
      }
      const deadline = now + 7 // ms of propagation budget per frame
      const date = new Date(this.propTarget)
      while (this.propIndex < this.visible.length) {
        const end = Math.min(this.propIndex + 512, this.visible.length)
        for (let i = this.propIndex; i < end; i++) {
          const p = satellite.propagate(this.visible[i].satrec, date)
          if (p && typeof p !== 'boolean') {
            this.posB[i * 3] = p.position.x * SCALE
            this.posB[i * 3 + 1] = p.position.z * SCALE
            this.posB[i * 3 + 2] = -p.position.y * SCALE
          } else {
            this.posB[i * 3] = this.posB[i * 3 + 1] = this.posB[i * 3 + 2] = 0
          }
        }
        this.propIndex = end
        if (this.propIndex < this.visible.length && performance.now() > deadline) break
      }
      if (this.propIndex >= this.visible.length) {
        // pass complete: swap buffers
        const tmp = this.posA
        this.posA = this.posB
        this.posB = tmp
        this.tA = this.tB
        this.tB = this.propTarget
        this.propIndex = 0
      }
      const span = this.tB - this.tA
      const alpha = span > 0 ? THREE.MathUtils.clamp((simMs - this.tA) / span, 0, 1) : 1
      const attr = this.satPoints.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      for (let i = 0; i < arr.length; i++) {
        arr[i] = this.posA[i] + (this.posB[i] - this.posA[i]) * alpha
      }
      attr.needsUpdate = true
    }

    // selection overlays at ~4 Hz
    if (this.selected && now - this.lastSelUpdate > 250) {
      this.lastSelUpdate = now
      this.updateSelectionOverlays(simMs, gmst)
    } else if (this.selected && this.selSprite) {
      // keep marker glued between overlay refreshes
      const pv = satellite.propagate(this.selected.satrec, new Date(simMs))
      if (pv && typeof pv !== 'boolean') {
        this.selSprite.position.set(pv.position.x * SCALE, pv.position.z * SCALE, -pv.position.y * SCALE)
      }
    }

    if (this.props.onFrame && now - this.lastFrameCb > 200) {
      this.lastFrameCb = now
      this.props.onFrame(simMs)
    }

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.clearSelection()
    this.controls.dispose()
    this.renderer.dispose()
    this.props.container.removeChild(this.renderer.domElement)
  }
}

function makeRingTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, 6, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  return new THREE.CanvasTexture(canvas)
}
