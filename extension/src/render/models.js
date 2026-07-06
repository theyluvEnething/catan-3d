/**
 * src/render/models.js — load the Blender-made GLB meshes once and hand out clones.
 *
 * pieces.glb (modeled in Blender, see assets/models/) holds six named meshes at the extension's
 * world scale (hex circumradius = 1): HexTile, Settlement, City, Road, Token, Robber. We load it
 * once, keep each node's geometry, and return fresh clones (with a per-call material) so scene.js
 * can place + recolor them exactly like the old procedural meshes.
 *
 * ponytail: geometry-only clones. We reuse each template's BufferGeometry (shared, cheap) and only
 * clone the Mesh + assign a material — no per-piece geometry copies.
 */
import * as THREE from "../../vendor/three.module.js";
import { GLTFLoader } from "../../vendor/GLTFLoader.js";

const NAMES = ["HexTile", "Settlement", "City", "Road", "Token", "Robber"];

let _loadPromise = null;      // Promise<Map<name, THREE.BufferGeometry>>
let _geo = null;              // resolved Map once loaded (null until then)

function glbUrl() {
  return (typeof chrome !== "undefined" && chrome.runtime?.getURL)
    ? chrome.runtime.getURL("assets/models/pieces.glb")
    : new URL("../../assets/models/pieces.glb", import.meta.url).href;
}

/** Kick off (or reuse) the one-time GLB load. Resolves to a Map name -> BufferGeometry. */
export function loadModels() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = new Promise((resolve) => {
    try {
      new GLTFLoader().load(
        glbUrl(),
        (gltf) => {
          const map = new Map();
          gltf.scene.traverse((o) => {
            if (o.isMesh && NAMES.includes(o.name) && !map.has(o.name)) {
              o.geometry.computeVertexNormals();
              // The GLB carries no UVs (exported without texcoords to stay tiny). The tile material
              // is a TWO-material array [topTexture, sideColor] (makeTileMaterial), so the hex needs
              // a planar XZ->UV projection AND two material groups (up-facing = top, else = side).
              // Other pieces use a single flat-color material, so they need neither.
              if (o.name === "HexTile") { assignHexGroups(o.geometry); planarUV(o.geometry); }
              map.set(o.name, o.geometry);
            }
          });
          _geo = map;
          resolve(map);
        },
        undefined,
        (err) => { console.warn("[catan3d/models] GLB load failed; using procedural fallback", err); resolve(null); }
      );
    } catch (e) {
      console.warn("[catan3d/models] GLTFLoader unavailable; procedural fallback", e);
      resolve(null);
    }
  });
  return _loadPromise;
}

/**
 * Add a planar XZ->UV projection to a geometry (top-down), normalized over its bounding box in X/Z.
 * Used for the hex tile so its top-down canvas texture maps correctly (the GLB has no UVs).
 */
function planarUV(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = bb.max.x - bb.min.x || 1;
  const sz = bb.max.z - bb.min.z || 1;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / sx;
    uv[i * 2 + 1] = (pos.getZ(i) - bb.min.z) / sz;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Split the hex geometry into two material groups so a [top, side] material array works:
 * group 0 = upward-facing triangles (top + dome, get the resource texture), group 1 = everything
 * else (sides + bevel, get the flat side color). Requires a non-indexed geometry so we can reorder
 * triangles; toNonIndexed() gives us that.
 */
function assignHexGroups(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const norm = g.attributes.normal;
  const triCount = pos.count / 3;
  // classify each triangle by its average normal Y
  const tops = [], sides = [];
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const ny = (norm.getY(i) + norm.getY(i + 1) + norm.getY(i + 2)) / 3;
    (ny > 0.5 ? tops : sides).push(t);
  }
  // reorder vertices so all top tris come first, then side tris (contiguous groups)
  const order = tops.concat(sides);
  const attrs = Object.keys(g.attributes);
  const src = {}; const dst = {};
  for (const a of attrs) { src[a] = g.attributes[a]; dst[a] = new Float32Array(src[a].array.length); }
  let w = 0;
  for (const t of order) {
    for (let k = 0; k < 3; k++) {
      const from = (t * 3 + k);
      for (const a of attrs) {
        const it = src[a].itemSize;
        for (let c = 0; c < it; c++) dst[a][w * it + c] = src[a].getComponent(from, c);
      }
      w++;
    }
  }
  for (const a of attrs) g.setAttribute(a, new THREE.BufferAttribute(dst[a], src[a].itemSize));
  g.clearGroups();
  g.addGroup(0, tops.length * 3, 0);                 // top → material 0
  g.addGroup(tops.length * 3, sides.length * 3, 1);  // sides → material 1
  // copy back into the original geometry reference used by the map
  geo.copy(g);
}

/** True once the GLB is loaded and a given model is available. */
export function hasModel(name) { return !!(_geo && _geo.get(name)); }

/**
 * A fresh Mesh for a model name with the given material, or null if the GLB isn't loaded yet / the
 * name is missing (caller should fall back to its procedural mesh). Geometry is shared.
 */
export function makeModel(name, material) {
  const g = _geo && _geo.get(name);
  if (!g) return null;
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
