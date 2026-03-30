
import fs from 'node:fs';
import path from 'node:path';

const COLS = 5;
const BG = [17, 17, 17]; // #111

// ── STL parser ────────────────────────────────────────────────────────────────
function parseSTL(buf) {
    const n = buf.readUInt32LE(80);
    if (buf.length === 84 + n * 50) return parseBinary(buf, n);
    const txt = buf.toString('ascii');
    if (txt.includes('facet normal')) return parseASCII(txt);
    return parseBinary(buf, n);
}

// Each triangle: { n: [nx,ny,nz], v: [[x,y,z],[x,y,z],[x,y,z]] }
function parseBinary(buf, n) {
    const tris = [];
    for (let i = 0, o = 84; i < n; i++, o += 50)
        tris.push({
            n: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
            v: [
                [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)],
                [buf.readFloatLE(o + 24), buf.readFloatLE(o + 28), buf.readFloatLE(o + 32)],
                [buf.readFloatLE(o + 36), buf.readFloatLE(o + 40), buf.readFloatLE(o + 44)],
            ],
        });
    return tris;
}

function parseASCII(txt) {
    const tris = [];
    const re = /facet normal\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)[\s\S]*?vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
    let m;
    while ((m = re.exec(txt)))
        tris.push({
            n: [+m[1], +m[2], +m[3]],
            v: [[+m[4], +m[5], +m[6]], [+m[7], +m[8], +m[9]], [+m[10], +m[11], +m[12]]],
        });
    return tris;
}

// ── Math ──────────────────────────────────────────────────────────────────────
const norm3 = v => { const l = Math.hypot(...v) || 1; return v.map(c => c / l); };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

// ── Render one tile ───────────────────────────────────────────────────────────
function renderTile(tris, rotation, translation, color, tileSize, PNG) {
    const TILE = tileSize;
    const RENDER = TILE * 2;
    // Bounding box
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (const v of t.v) {
        for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], v[i]); mx[i] = Math.max(mx[i], v[i]); }
    }
    const ctr = mn.map((c, i) => (c + mx[i]) / 2);
    const sc = Math.max(...mn.map((c, i) => mx[i] - c)) || 1;

    // Rotation (degrees → radians)
    const [rx, ry, rz] = ['x', 'y', 'z'].map(k => (rotation[k] || 0) * Math.PI / 180);

    function xform(v) {
        let [x, y, z] = v.map((c, i) => (c - ctr[i]) / sc);
        // Convert Z-up (OnShape) → Y-up (renderer): old Z becomes new Y, old Y becomes new -Z
        [y, z] = [z, -y];
        // Rx
        [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
        // Ry
        [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
        // Rz
        [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
        return [x + (translation.x || 0) / sc, y + (translation.y || 0) / sc, z + (translation.z || 0) / sc];
    }

    // Camera: isometric from (1,1,1) direction
    const eyeDir = norm3([1, 1, 1]);
    const eye = eyeDir.map(c => c * 2.5);
    const zCam = norm3(sub3(eye, [0, 0, 0]));
    const xCam = norm3(cross3([0, 1, 0], zCam));
    const yCam = cross3(zCam, xCam);
    const LIGHT1 = norm3([1, 2, 1.5]);

    function toCamera(wp) {
        const d = sub3(wp, eye);
        return [dot3(xCam, d), dot3(yCam, d), dot3(zCam, d)];
    }

    // Pre-pass: find projected extents to auto-fit model in tile
    let maxU = 0, maxV = 0;
    for (const tri of tris) for (const v of tri.v) {
        const vc = toCamera(xform(v));
        const depth = -vc[2];
        if (depth <= 0) continue;
        maxU = Math.max(maxU, Math.abs(vc[0] / depth));
        maxV = Math.max(maxV, Math.abs(vc[1] / depth));
    }
    // Derive f so model fills 88% of tile, preserving actual proportions
    const f = (maxU > 0 || maxV > 0) ? 0.88 / Math.max(maxU, maxV) : 2.0;

    function project(wp) {
        const vc = toCamera(wp);
        const depth = -vc[2];
        if (depth <= 0) return null;
        return [
            (f * vc[0] / depth + 1) * RENDER / 2,
            (1 - f * vc[1] / depth) * RENDER / 2,
            depth,
        ];
    }

    // Render at 2× resolution for 4× SSAA, downsample to TILE at the end
    const buf = Buffer.alloc(RENDER * RENDER * 4);
    const zbuf = new Float32Array(RENDER * RENDER).fill(Infinity);
    const nbuf = new Float32Array(RENDER * RENDER * 3); // per-pixel face normal (nx,ny,nz)
    const tbuf = new Int32Array(RENDER * RENDER).fill(-1); // per-pixel triangle ID
    for (let i = 0; i < RENDER * RENDER; i++) {
        const p = i * 4;
        buf[p] = BG[0]; buf[p + 1] = BG[1]; buf[p + 2] = BG[2]; buf[p + 3] = 255;
    }

    for (let triIdx = 0; triIdx < tris.length; triIdx++) {
        const tri = tris[triIdx];
        const wv = tri.v.map(xform);

        // Use stored STL normal for culling; fall back to computed if stored is zero
        let sn = norm3(tri.n.map((_, i) => {
            // rotate stored normal same as vertices (no translate/scale needed for normals)
            // Apply Z-up → Y-up conversion first, then user rotation
            const [x, y, z] = [tri.n[0], tri.n[2], -tri.n[1]];
            if (i === 0) return x * Math.cos(rz) * Math.cos(ry) + y * (Math.cos(rz) * Math.sin(ry) * Math.sin(rx) - Math.sin(rz) * Math.cos(rx)) + z * (Math.cos(rz) * Math.sin(ry) * Math.cos(rx) + Math.sin(rz) * Math.sin(rx));
            if (i === 1) return x * Math.sin(rz) * Math.cos(ry) + y * (Math.sin(rz) * Math.sin(ry) * Math.sin(rx) + Math.cos(rz) * Math.cos(rx)) + z * (Math.sin(rz) * Math.sin(ry) * Math.cos(rx) - Math.cos(rz) * Math.sin(rx));
            return -x * Math.sin(ry) + y * Math.cos(ry) * Math.sin(rx) + z * Math.cos(ry) * Math.cos(rx);
        }));
        // If stored normal is degenerate, compute from vertices
        if (Math.hypot(...sn) < 0.5) sn = norm3(cross3(sub3(wv[1], wv[0]), sub3(wv[2], wv[0])));

        // No backface cull — z-buffer handles open meshes correctly
        const br = 0.75 + 0.25 * Math.abs(dot3(sn, LIGHT1));
        const c = color.map(v => Math.min(255, v * br) | 0);

        const pv = wv.map(project);
        if (pv.some(p => !p)) continue;

        const [p0, p1, p2] = pv;
        const area = edge(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]);
        if (Math.abs(area) < 0.5) continue;

        const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
        const x1 = Math.min(RENDER - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
        const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
        const y1 = Math.min(RENDER - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = edge(p1[0], p1[1], p2[0], p2[1], px, py);
            const w1 = edge(p2[0], p2[1], p0[0], p0[1], px, py);
            const w2 = edge(p0[0], p0[1], p1[0], p1[1], px, py);
            if (area > 0 ? (w0 < 0 || w1 < 0 || w2 < 0) : (w0 > 0 || w1 > 0 || w2 > 0)) continue;

            const z = (w0 * p0[2] + w1 * p1[2] + w2 * p2[2]) / area;
            const idx = y * RENDER + x;
            if (z < zbuf[idx]) {
                zbuf[idx] = z;
                tbuf[idx] = triIdx;
                const pi = idx * 4;
                buf[pi] = c[0]; buf[pi + 1] = c[1]; buf[pi + 2] = c[2];
                const ni = idx * 3;
                nbuf[ni] = sn[0]; nbuf[ni + 1] = sn[1]; nbuf[ni + 2] = sn[2];
            }
        }
    }

    // Cel-shading edge pass — pure black lines at silhouettes and surface creases
    const DEPTH_THR = 0.05; // depth jump = silhouette / occlusion edge
    const NORMAL_THR = 0.5;  // dot product below this = crease between faces
    for (let y = 1; y < RENDER - 1; y++) for (let x = 1; x < RENDER - 1; x++) {
        const idx = y * RENDER + x;
        if (zbuf[idx] === Infinity) continue;
        const d = zbuf[idx];
        const ni = idx * 3;
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) for (let dx = -1; dx <= 1 && !isEdge; dx++) {
            if (dy === 0 && dx === 0) continue;
            const nidx = (y + dy) * RENDER + (x + dx);
            if (zbuf[nidx] === Infinity || Math.abs(zbuf[nidx] - d) > DEPTH_THR) {
                isEdge = true;
            } else {
                const nn = nidx * 3;
                const dot = nbuf[ni] * nbuf[nn] + nbuf[ni + 1] * nbuf[nn + 1] + nbuf[ni + 2] * nbuf[nn + 2];
                // 1. Show creases above threshold (dot < NORMAL_THR)
                // 2. Show triangle boundaries only if angle is significant (dot < 0.995)
                if (dot < NORMAL_THR || (tbuf[idx] !== tbuf[nidx] && dot < 0.995)) {
                    isEdge = true;
                }
            }
        }
        if (isEdge) { const pi = idx * 4; buf[pi] = buf[pi + 1] = buf[pi + 2] = 0; }
    }

    // Box-filter downsample 2×2 → 1×1
    const png = new PNG({ width: TILE, height: TILE });
    png.data = Buffer.alloc(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const si = ((y * 2 + dy) * RENDER + (x * 2 + dx)) * 4;
            r += buf[si]; g += buf[si + 1]; b += buf[si + 2];
        }
        const di = (y * TILE + x) * 4;
        png.data[di] = r >> 2; png.data[di + 1] = g >> 2; png.data[di + 2] = b >> 2; png.data[di + 3] = 255;
    }

    return png;
}

// ── Compose grid ──────────────────────────────────────────────────────────────
function composeGrid(tiles, tileSize, PNG) {
    const rows = Math.ceil(tiles.length / COLS);
    const W = COLS * tileSize, H = rows * tileSize;
    const out = new PNG({ width: W, height: H });
    out.data = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const p = i * 4; out.data[p] = BG[0]; out.data[p + 1] = BG[1]; out.data[p + 2] = BG[2]; out.data[p + 3] = 255;
    }
    tiles.forEach((tile, i) => {
        const col = i % COLS, row = Math.floor(i / COLS);
        for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) {
            const src = (y * tileSize + x) * 4;
            const dst = ((row * tileSize + y) * W + col * tileSize + x) * 4;
            out.data[dst] = tile.data[src];
            out.data[dst + 1] = tile.data[src + 1];
            out.data[dst + 2] = tile.data[src + 2];
            out.data[dst + 3] = 255;
        }
    });
    return out;
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function generatePreview(folderPath, rotation = '{}', translation = '{}', style = '{}', maxSamples = 25, tileSize = 280) {
    let PNG;
    try {
        ({ PNG } = await import('pngjs'));
    } catch {
        throw new Error('pngjs not installed. Run: bun add pngjs');
    }

    const absPath = path.resolve(folderPath);
    if (!fs.existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);

    const files = fs.readdirSync(absPath).filter(f => f.toLowerCase().endsWith('.stl'));
    if (files.length === 0) throw new Error(`No STL files found in ${absPath}`);

    let display = files;
    if (files.length > maxSamples) {
        console.log(`⚠️  Too many variants (${files.length}). Sampling ${maxSamples} random models for preview.`);
        display = files.sort(() => 0.5 - Math.random()).slice(0, maxSamples);
    }

    const rotCfg = JSON.parse(rotation);
    const transCfg = JSON.parse(translation);
    const styleCfg = JSON.parse(style);

    const rawColor = (styleCfg.color || '#e0641dff').replace('#', '');
    let color = [
        parseInt(rawColor.slice(0, 2), 16),
        parseInt(rawColor.slice(2, 4), 16),
        parseInt(rawColor.slice(4, 6), 16),
    ];
    // Boost dark colors so the model is always visible in the preview
    const maxCh = Math.max(...color);
    if (maxCh < 220) color = color.map(c => Math.round(c * 220 / (maxCh || 1)));

    console.log(`Rendering ${display.length} STL files...`);

    const tiles = [];
    let completed = 0;
    for (const file of display) {
        const buf = fs.readFileSync(path.join(absPath, file));
        const tris = parseSTL(buf);
        tiles.push(renderTile(tris, rotCfg, transCfg, color, tileSize, PNG));
        completed++;
        process.stdout.write(`\r   \x1b[36mRendering: [${completed}/${display.length}]\x1b[0m`);
    }
    process.stdout.write('\n');

    const grid = composeGrid(tiles, tileSize, PNG);
    const outputPath = path.join(absPath, '..', 'preview.png');
    fs.writeFileSync(outputPath, PNG.sync.write(grid));

    console.log(`✅ Preview generated: ${outputPath}`);
    return outputPath;
}
