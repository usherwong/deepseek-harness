#!/usr/bin/env node
/**
 * Generate `build/icon.png`, the single source image electron-builder converts
 * into an `.icns` and an `.ico`.
 *
 * The icon is drawn here rather than committed as a binary so the repository
 * stays reviewable in a diff and the build needs no image toolchain: a small
 * SVG path rasterizer and `zlib` are the whole pipeline, which is also what
 * keeps `npm run icon` working identically on the Windows runner.
 */

import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
/** Samples per pixel axis; 4×4 keeps the curves free of stair-steps. */
const SUPERSAMPLE = 4

const INSET = 92
const CORNER = 208
const GRADIENT_TOP = [0x5a, 0x78, 0xff]
const GRADIENT_BOTTOM = [0x3d, 0x57, 0xe0]

/** Fraction of the canvas width the mark spans. */
const MARK_WIDTH = 0.6
/**
 * The mark's optical center sits below its bounding-box center — the tail rises
 * above the body — so the glyph is nudged up to look centered in the square.
 */
const MARK_RISE = 0.015

/** The DeepSeek whale, as published in the product's own logo. */
const MARK_PATH =
  'M26.5174 3.39471C26.235 3.2567 26.1137 3.52006 25.9487 3.65346C25.8923 3.69659 25.8446 3.75294 25.7969 3.80469C25.3846 4.24516 24.9027 4.53439 24.2737 4.49989C23.3536 4.44814 22.5682 4.73737 21.8735 5.44119C21.7258 4.57349 21.2353 4.0554 20.4889 3.72304C20.0985 3.55054 19.7034 3.37746 19.4297 3.00197C19.2388 2.73459 19.1865 2.43673 19.091 2.14289C19.0301 1.96579 18.9697 1.78466 18.7656 1.75418C18.5442 1.71968 18.4574 1.90541 18.3705 2.06067C18.0232 2.69549 17.8887 3.39471 17.9019 4.10313C17.9324 5.6965 18.6051 6.96556 19.9421 7.86834C20.0939 7.97184 20.133 8.07535 20.0852 8.22658C19.9938 8.53766 19.8857 8.83955 19.7903 9.15063C19.7293 9.34901 19.6384 9.39271 19.4257 9.30588C18.692 8.9994 18.0583 8.54571 17.4982 7.99772C16.5477 7.07827 15.6881 6.06336 14.6162 5.26869C14.3644 5.08296 14.1125 4.91045 13.8521 4.746C12.7584 3.68394 13.9952 2.81164 14.2816 2.70814C14.5812 2.60003 14.3857 2.22857 13.4179 2.23317C12.4502 2.2372 11.5646 2.56151 10.4359 2.99335C10.2708 3.05832 10.0972 3.10547 9.91951 3.14457C8.8954 2.95022 7.83162 2.90709 6.72069 3.03245C4.62877 3.26533 2.95777 4.25436 1.72954 5.94261C0.254043 7.97184 -0.0932678 10.2777 0.33167 12.6824C0.778458 15.2171 2.07225 17.3153 4.06008 18.9558C6.12152 20.6567 8.49577 21.4905 11.2047 21.3306C12.8498 21.2358 14.6812 21.0155 16.7473 19.2669C17.2682 19.5262 17.8151 19.6297 18.7219 19.7074C19.4205 19.7723 20.0933 19.6729 20.6143 19.5648C21.4302 19.3923 21.3739 18.6367 21.0789 18.4981C18.6874 17.3843 19.2124 17.8374 18.7351 17.4706C19.9501 16.033 21.8063 13.4776 22.379 9.99821C22.4353 9.61409 22.5072 9.073 22.4986 8.76192C22.494 8.57216 22.5377 8.49856 22.7545 8.47671C23.3536 8.40771 23.935 8.24383 24.4692 7.94999C26.0188 7.10357 26.6439 5.71318 26.7911 4.04678C26.8129 3.79204 26.7865 3.52869 26.5174 3.39471ZM13.0143 18.3946C10.6964 16.5724 9.5722 15.9726 9.10816 15.9985C8.67402 16.0244 8.75222 16.5212 8.84768 16.8449C8.94773 17.1646 9.07768 17.3849 9.25996 17.6655C9.38589 17.8512 9.47272 18.1272 9.13404 18.3348C8.38766 18.7965 7.08985 18.1796 7.0289 18.1491C5.51833 17.2595 4.25559 16.0853 3.36546 14.4793C2.50581 12.9337 2.0067 11.2753 1.92447 9.50542C1.90262 9.07818 2.02855 8.92695 2.45406 8.84932C3.01413 8.74582 3.59144 8.72397 4.15093 8.80619C6.51656 9.15178 8.53027 10.2092 10.2185 11.8848C11.1822 12.8388 11.9114 13.979 12.6623 15.0929C13.461 16.2757 14.3201 17.4027 15.4144 18.3268C15.8008 18.6505 16.109 18.8966 16.404 19.0783C15.5144 19.1778 14.0297 19.1991 13.0143 18.3958V18.3946ZM14.1252 11.2489C14.1252 11.0591 14.277 10.9079 14.4679 10.9079C14.511 10.9079 14.5501 10.9165 14.5852 10.9292C14.6329 10.9464 14.6766 10.9723 14.7111 11.0114C14.7721 11.0718 14.8066 11.158 14.8066 11.2489C14.8066 11.4386 14.6548 11.5899 14.4639 11.5899C14.273 11.5899 14.1252 11.4386 14.1252 11.2489ZM17.5759 13.0188C17.3545 13.1096 17.1331 13.1873 16.9203 13.1959C16.5903 13.2131 16.2303 13.0791 16.0348 12.9153C15.7312 12.6605 15.5139 12.5179 15.423 12.0734C15.3839 11.8837 15.4057 11.5899 15.4402 11.4214C15.5185 11.0585 15.4316 10.8257 15.1757 10.614C14.9676 10.4415 14.7025 10.3938 14.4115 10.3938C14.3029 10.3938 14.2034 10.3461 14.1292 10.3076C14.0079 10.2472 13.9078 10.096 14.0033 9.91023C14.0338 9.84985 14.1815 9.70322 14.216 9.67734C14.6111 9.45251 15.0665 9.52612 15.488 9.6946C15.8784 9.85445 16.174 10.1477 16.5989 10.5623C17.033 11.0631 17.1112 11.2011 17.3585 11.5772C17.554 11.871 17.7317 12.1729 17.8536 12.5185C17.9272 12.7341 17.8317 12.9107 17.5759 13.0188Z'

// ---------------------------------------------------------------- path parsing

/**
 * Split a path `d` into commands with their numeric arguments.
 *
 * Only the command set this mark uses is accepted. An unsupported letter throws
 * rather than silently dropping part of the shape, because a partially rendered
 * icon still produces a valid PNG and would ship unnoticed.
 */
function tokenizePath(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []
  const commands = []
  let index = 0
  let command = null
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) {
      command = tokens[index]
      index += 1
    } else if (command === null) {
      throw new Error(`make-icon: path starts with a number, not a command`)
    } else if (command === 'M') {
      // A repeated coordinate pair after a moveto continues as a lineto.
      command = 'L'
    } else if (command === 'm') {
      command = 'l'
    }
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 }[command.toUpperCase()]
    if (arity === undefined) throw new Error(`make-icon: unsupported path command "${command}"`)
    const args = []
    for (let taken = 0; taken < arity; taken += 1) {
      args.push(Number(tokens[index]))
      index += 1
    }
    commands.push({ command, args })
  }
  return commands
}

/** Flatten a cubic segment into line points, denser for longer curves. */
function flattenCubic(points, x0, y0, x1, y1, x2, y2, x3, y3, scale) {
  const control = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
  const steps = Math.min(64, Math.max(4, Math.ceil(control * scale / 3)))
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    const u = 1 - t
    points.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ])
  }
}

/** Convert a path `d` into closed polygons in user space. */
function flattenPath(d, scale) {
  const subpaths = []
  let current = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let previousControl = null

  const begin = () => {
    if (current !== null && current.length > 2) subpaths.push(current)
    current = [[x, y]]
  }

  for (const { command, args } of tokenizePath(d)) {
    const relative = command === command.toLowerCase()
    const upper = command.toUpperCase()
    switch (upper) {
      case 'M':
        x = relative ? x + args[0] : args[0]
        y = relative ? y + args[1] : args[1]
        begin()
        startX = x
        startY = y
        previousControl = null
        break
      case 'L':
        x = relative ? x + args[0] : args[0]
        y = relative ? y + args[1] : args[1]
        current.push([x, y])
        previousControl = null
        break
      case 'H':
        x = relative ? x + args[0] : args[0]
        current.push([x, y])
        previousControl = null
        break
      case 'V':
        y = relative ? y + args[0] : args[0]
        current.push([x, y])
        previousControl = null
        break
      case 'C':
      case 'S': {
        const [c1x, c1y] = upper === 'C'
          ? [relative ? x + args[0] : args[0], relative ? y + args[1] : args[1]]
          // A smooth curve reflects the previous control point through the
          // current point; with no previous curve the control point is the point.
          : [previousControl === null ? x : 2 * x - previousControl[0],
             previousControl === null ? y : 2 * y - previousControl[1]]
        const rest = upper === 'C' ? args.slice(2) : args
        const c2x = relative ? x + rest[0] : rest[0]
        const c2y = relative ? y + rest[1] : rest[1]
        const endX = relative ? x + rest[2] : rest[2]
        const endY = relative ? y + rest[3] : rest[3]
        flattenCubic(current, x, y, c1x, c1y, c2x, c2y, endX, endY, scale)
        previousControl = [c2x, c2y]
        x = endX
        y = endY
        break
      }
      case 'Q':
      case 'T': {
        const [qx, qy] = upper === 'Q'
          ? [relative ? x + args[0] : args[0], relative ? y + args[1] : args[1]]
          : [previousControl === null ? x : 2 * x - previousControl[0],
             previousControl === null ? y : 2 * y - previousControl[1]]
        const rest = upper === 'Q' ? args.slice(2) : args
        const endX = relative ? x + rest[0] : rest[0]
        const endY = relative ? y + rest[1] : rest[1]
        // Every quadratic has an exact cubic equivalent.
        flattenCubic(current, x, y,
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          endX + (2 / 3) * (qx - endX), endY + (2 / 3) * (qy - endY),
          endX, endY, scale)
        previousControl = [qx, qy]
        x = endX
        y = endY
        break
      }
      case 'Z':
        x = startX
        y = startY
        if (current !== null && current.length > 2) subpaths.push(current)
        current = [[x, y]]
        previousControl = null
        break
    }
  }
  if (current !== null && current.length > 2) subpaths.push(current)
  return subpaths
}

// ------------------------------------------------------------------ geometry

/** Distance from a point to a rounded rectangle's boundary; negative inside. */
function roundedRectDistance(x, y) {
  const half = (SIZE - INSET * 2) / 2
  const dx = Math.abs(x - SIZE / 2) - (half - CORNER)
  const dy = Math.abs(y - SIZE / 2) - (half - CORNER)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - CORNER
}

/**
 * Scanline coverage for a set of closed polygons under the nonzero fill rule.
 *
 * Sampling every pixel against every edge would be tens of billions of tests at
 * this resolution; intersecting one sub-scanline at a time is linear in edges.
 * @returns per-pixel coverage in 0..1.
 */
function fillPolygons(subpaths) {
  const coverage = new Float32Array(SIZE * SIZE)
  const edges = []
  for (const points of subpaths) {
    for (let index = 0; index < points.length; index += 1) {
      const [x0, y0] = points[index]
      const [x1, y1] = points[(index + 1) % points.length]
      // A horizontal edge crosses no scanline and would divide by zero.
      if (y0 !== y1) edges.push([x0, y0, x1, y1])
    }
  }

  const subRows = SIZE * SUPERSAMPLE
  const subColumns = SIZE * SUPERSAMPLE
  const share = 1 / (SUPERSAMPLE * SUPERSAMPLE)
  const crossings = []

  for (let subRow = 0; subRow < subRows; subRow += 1) {
    const y = (subRow + 0.5) / SUPERSAMPLE
    crossings.length = 0
    for (const [x0, y0, x1, y1] of edges) {
      // Half-open in y so a vertex shared by two edges is counted once.
      if (y < Math.min(y0, y1) || y >= Math.max(y0, y1)) continue
      crossings.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1])
    }
    if (crossings.length === 0) continue
    crossings.sort((left, right) => left[0] - right[0])

    const row = Math.floor(subRow / SUPERSAMPLE) * SIZE
    let winding = 0
    for (let index = 0; index < crossings.length - 1; index += 1) {
      winding += crossings[index][1]
      if (winding === 0) continue
      const from = Math.max(0, Math.ceil(crossings[index][0] * SUPERSAMPLE - 0.5))
      const to = Math.min(subColumns, Math.ceil(crossings[index + 1][0] * SUPERSAMPLE - 0.5))
      for (let subColumn = from; subColumn < to; subColumn += 1) {
        coverage[row + ((subColumn / SUPERSAMPLE) | 0)] += share
      }
    }
  }
  return coverage
}

// ----------------------------------------------------------------- rasterizer

function render() {
  // Fit the mark to the canvas from its own bounds, so editing the path never
  // requires re-deriving the placement numbers by hand.
  const unscaled = flattenPath(MARK_PATH, 1)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const points of unscaled) {
    for (const [x, y] of points) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  const scale = (SIZE * MARK_WIDTH) / (maxX - minX)
  const offsetX = (SIZE - (maxX - minX) * scale) / 2 - minX * scale
  const offsetY = (SIZE - (maxY - minY) * scale) / 2 - minY * scale - SIZE * MARK_RISE

  const placed = flattenPath(MARK_PATH, scale).map(points =>
    points.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]))
  const mark = fillPolygons(placed)

  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let y = 0; y < SIZE; y += 1) {
    const ratio = y / (SIZE - 1)
    const base = GRADIENT_TOP.map((channel, index) =>
      Math.round(channel + (GRADIENT_BOTTOM[index] - channel) * ratio))

    for (let x = 0; x < SIZE; x += 1) {
      let bodyHits = 0
      for (let subY = 0; subY < SUPERSAMPLE; subY += 1) {
        const sampleY = y + (subY + 0.5) * step
        for (let subX = 0; subX < SUPERSAMPLE; subX += 1) {
          if (roundedRectDistance(x + (subX + 0.5) * step, sampleY) <= 0) bodyHits += 1
        }
      }
      if (bodyHits === 0) continue

      const offset = (y * SIZE + x) * 4
      const alpha = bodyHits / samples
      // The mark is clipped to the body so its edge antialiases against the
      // gradient rather than against transparency outside the rounded square.
      const glyph = Math.min(mark[y * SIZE + x], alpha)
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round((base[channel] * (alpha - glyph) + 255 * glyph) / alpha)
      }
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

// ---------------------------------------------------------------- PNG writing

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // One filter byte per scanline; "none" keeps the encoder trivial and the
  // gradient compresses well regardless.
  const stride = SIZE * 4
  const raw = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(desktopRoot, 'build', 'icon.png')
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, encodePng(render()))
console.log(`make-icon: wrote ${output} (${SIZE}×${SIZE})`)
