/**
 * The login backdrop: one long glowing thread that wanders like a snake and keeps coiling back on
 * itself into a loose ball of yarn — an unwinding joke. The head steers by a slowly drifting curl
 * plus a pull toward a home point that wanders the screen; the body is a follow-the-leader chain, so
 * every coil the head draws stays laid down behind it. A pointer near the head scares it off, and a
 * pointer near any strand parts it.
 *
 * Always dark (Midnight), whatever the theme; the thread runs Green → Blue → Purple and fades to the
 * tail. Colours are read from the `--nf-*` tokens at mount (no literals, `brand-tokens.test.ts`).
 * `prefers-reduced-motion` gets one settled, still frame. Purely decorative: `aria-hidden`, no
 * pointer events of its own (it listens on `window`).
 *
 * `contained` fits it to its positioned parent instead of the viewport (Home's greeting banner): a
 * shorter, slower thread, sized by a ResizeObserver, with pointer positions taken relative to the
 * parent. `paused` freezes it on its current frame without resetting it. `tone="light"` lays it on a
 * pale Midnight-10 ground instead: the thread is painted rather than added as light (which vanishes
 * on white), a touch stronger, with Blue for the middle so it holds against the ground. Switching
 * tone repaints the current frame without restarting the thread.
 */
import { useEffect, useRef } from 'react'

type Rgb = [number, number, number]

const FULL_POINTS = 520
const CONTAINED_POINTS = 260
/** The banner's pace: time runs at this fraction, so the path keeps its shape and just slows. */
const CONTAINED_PACE = 0.4
const SEGMENT = 6
const SPEED = 2.4
const FLEE_RADIUS = 200
const PART_RADIUS = 90

function tokenRgb(name: string, fallback: Rgb): Rgb {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw)
  return m
    ? [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)]
    : fallback
}

/** Green at the head, Blue through the middle, Purple at the tail. */
function threadColour(t: number, stops: Rgb[]): Rgb {
  const scaled = t * (stops.length - 1)
  const i = Math.min(Math.floor(scaled), stops.length - 2)
  const f = scaled - i
  const [a, b] = [stops[i], stops[i + 1]]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Shortest signed difference between two angles. */
function angleDelta(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from))
}

export type ThreadTone = 'dark' | 'light'

const GROUNDS: Record<ThreadTone, string> = {
  dark: 'radial-gradient(ellipse at 50% 40%, var(--nf-midnight) 0%, var(--nf-dark-bg) 75%)',
  light:
    'radial-gradient(ellipse at 20% 0%, var(--nf-green-10) 0%, transparent 60%), radial-gradient(ellipse at 90% 100%, var(--nf-purple-10) 0%, transparent 60%), var(--nf-midnight-10)',
}

export function ThreadBackground({
  contained = false,
  paused = false,
  tone = 'dark',
}: {
  contained?: boolean
  paused?: boolean
  tone?: ThreadTone
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const toneRef = useRef(tone)
  const repaintRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const green = tokenRgb('--nf-green', [0, 229, 164])
    const purple = tokenRgb('--nf-purple', [137, 80, 255])
    const palettes: Record<ThreadTone, Rgb[]> = {
      dark: [green, tokenRgb('--nf-blue-80', [69, 137, 255]), purple],
      light: [green, tokenRgb('--nf-blue', [22, 107, 255]), purple],
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    const POINTS = contained ? CONTAINED_POINTS : FULL_POINTS
    const host = canvas.parentElement
    let width = 0
    let height = 0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = contained && host ? host.getBoundingClientRect() : null
      width = box ? box.width : window.innerWidth
      height = box ? box.height : window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    // The whole thread starts bunched at the centre and unspools from there.
    const xs = new Float32Array(POINTS).fill(width / 2)
    const ys = new Float32Array(POINTS).fill(height / 2)
    let heading = Math.random() * Math.PI * 2
    let tick = Math.random() * 10_000
    const pointer = { x: -1e4, y: -1e4, active: false }

    const pace = contained ? CONTAINED_PACE : 1
    const step = () => {
      tick += pace
      // Home drifts on a slow Lissajous so the ball rolls around the screen rather than sitting still.
      const homeX = width / 2 + Math.sin(tick * 0.0011) * width * 0.3
      const homeY = height / 2 + Math.sin(tick * 0.0017 + 1.3) * height * 0.28
      // A curl that slowly changes hand is what winds the thread into loops.
      let turn = Math.sin(tick * 0.004) * 0.045 + Math.sin(tick * 0.0173) * 0.02
      const toHome = Math.atan2(homeY - ys[0], homeX - xs[0])
      const homeDist = Math.hypot(homeX - xs[0], homeY - ys[0])
      turn += angleDelta(heading, toHome) * Math.min(homeDist / 2600, 0.06)

      let speed = SPEED * pace
      if (pointer.active) {
        const dx = xs[0] - pointer.x
        const dy = ys[0] - pointer.y
        const dist = Math.hypot(dx, dy)
        if (dist < FLEE_RADIUS) {
          const fear = 1 - dist / FLEE_RADIUS
          turn += angleDelta(heading, Math.atan2(dy, dx)) * 0.25 * fear
          speed += 5 * fear * pace
        }
      }
      heading += turn * pace

      xs[0] += Math.cos(heading) * speed
      ys[0] += Math.sin(heading) * speed
      // Soft walls: never let the head leave the screen for long.
      // A banner is short, so its walls are closer and steer harder.
      const margin = contained ? 20 : 40
      if (xs[0] < margin || xs[0] > width - margin || ys[0] < margin || ys[0] > height - margin) {
        const wall = contained ? 0.25 : 0.08
        heading += angleDelta(heading, Math.atan2(height / 2 - ys[0], width / 2 - xs[0])) * wall
      }

      for (let i = 1; i < POINTS; i++) {
        if (pointer.active) {
          const px = xs[i] - pointer.x
          const py = ys[i] - pointer.y
          const d = Math.hypot(px, py)
          if (d < PART_RADIUS && d > 0.01) {
            const push = ((PART_RADIUS - d) / PART_RADIUS) * 3
            xs[i] += (px / d) * push
            ys[i] += (py / d) * push
          }
        }
        const dx = xs[i] - xs[i - 1]
        const dy = ys[i] - ys[i - 1]
        const d = Math.hypot(dx, dy)
        if (d > SEGMENT) {
          xs[i] = xs[i - 1] + (dx / d) * SEGMENT
          ys[i] = ys[i - 1] + (dy / d) * SEGMENT
        }
      }
    }

    const CHUNK = 16
    const strand = (from: number, to: number, offset: number, phase: number) => {
      // A fibre twisted around the core line: offset along the normal by a sine down the length.
      ctx.beginPath()
      for (let i = from; i <= to && i < POINTS; i++) {
        const j = Math.min(i + 1, POINTS - 1)
        const k = Math.max(i - 1, 0)
        const nx = -(ys[j] - ys[k])
        const ny = xs[j] - xs[k]
        const nl = Math.hypot(nx, ny) || 1
        const o = offset * Math.sin(i * 0.55 + phase + tick * 0.08)
        const x = xs[i] + (nx / nl) * o
        const y = ys[i] + (ny / nl) * o
        if (i === from) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const light = toneRef.current === 'light'
      const stops = palettes[toneRef.current]
      // Added light glows on Midnight but vanishes on white: on a light ground paint it, stronger.
      const strength = light ? 1.5 : 1
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let from = 0; from < POINTS - 1; from += CHUNK) {
        const t = from / POINTS
        const [r, g, b] = threadColour(t, stops)
        const fade = (1 - t) ** 1.4
        // Glow, then the core, then two thin fibres twisting round it.
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.07 * fade * strength})`
        ctx.lineWidth = 14
        strand(from, from + CHUNK, 0, 0)
        ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.55 * fade * strength, 1)})`
        ctx.lineWidth = 1.6
        strand(from, from + CHUNK, 0, 0)
        ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.35 * fade * strength, 1)})`
        ctx.lineWidth = 0.8
        strand(from, from + CHUNK, 2.2, 0)
        strand(from, from + CHUNK, 2.2, Math.PI)
      }
      // The head: a bright bead.
      const [r, g, b] = stops[0]
      const glow = ctx.createRadialGradient(xs[0], ys[0], 0, xs[0], ys[0], 18)
      glow.addColorStop(0, `rgba(${r},${g},${b},0.9)`)
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(xs[0], ys[0], 18, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    }

    repaintRef.current = draw

    const onMove = (e: PointerEvent) => {
      const origin = contained && host ? host.getBoundingClientRect() : null
      pointer.x = e.clientX - (origin?.left ?? 0)
      pointer.y = e.clientY - (origin?.top ?? 0)
      pointer.active = true
    }
    const onLeave = () => {
      pointer.active = false
    }

    window.addEventListener('resize', resize)
    const observer =
      contained && host && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            resize()
            draw() // a resize clears the canvas; repaint so a paused thread stays visible
          })
        : null
    if (observer && host) observer.observe(host)
    let frame = 0
    if (reducedMotion) {
      for (let i = 0; i < POINTS * 3; i++) step()
      draw()
    } else {
      // Loaded paused: unspool it first, so the still frame is a thread rather than a bead.
      if (pausedRef.current) {
        for (let i = 0; i < POINTS * 3; i++) step()
        draw()
      }
      window.addEventListener('pointermove', onMove)
      document.documentElement.addEventListener('pointerleave', onLeave)
      const loop = () => {
        if (!pausedRef.current) {
          step()
          draw()
        }
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [contained])

  // A theme switch repaints the current frame in the new tone, a paused thread included.
  useEffect(() => {
    toneRef.current = tone
    repaintRef.current()
  }, [tone])

  return (
    <div
      aria-hidden="true"
      className={
        contained
          ? 'absolute inset-0 pointer-events-none'
          : 'fixed inset-0 -z-10 pointer-events-none'
      }
      style={{ background: GROUNDS[tone] }}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  )
}
