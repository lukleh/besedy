/**
 * Visual Regression Gallery Generator
 *
 * Generates an HTML gallery of all visual regression snapshots
 * for easy review before releases.
 *
 * Usage: npx tsx tests/e2e/scripts/generate-visual-report.ts
 *
 * Output: ~/.local/state/lukleh/besedy/web/test-output/visual-gallery.html
 */

import fs from "fs";
import path from "path";
import { resolveBesedyWebStateDir } from "../../../src/lib/runtime-paths";

const SNAPSHOTS_DIR = path.join(__dirname, "../snapshots");
const OUTPUT_DIR = resolveBesedyWebStateDir("test-output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "visual-gallery.html");

interface Snapshot {
  file: string;
  path: string;
  category: string;
  device: string;
}

function findSnapshots(dir: string, basePath: string = ""): Snapshot[] {
  const snapshots: Snapshot[] = [];

  if (!fs.existsSync(dir)) {
    console.log(`Snapshots directory not found: ${dir}`);
    return snapshots;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      snapshots.push(...findSnapshots(fullPath, relativePath));
    } else if (entry.name.endsWith(".png")) {
      // Parse filename to extract device/category info
      const filename = entry.name.replace(".png", "");
      const parts = filename.split("-");

      // Determine category from parent directory
      const category = basePath.split(path.sep)[0] || "general";

      // Try to identify device from filename
      let device = "unknown";
      const devicePatterns = [
        "iPhoneSE",
        "iPhone14",
        "iPhone14ProMax",
        "Pixel7",
        "GalaxyS21",
        "iPadMini",
        "iPadPro",
        "GalaxyTabS4",
        "below-md",
        "at-md",
        "below-lg",
        "at-lg",
        "desktop",
      ];

      for (const pattern of devicePatterns) {
        if (filename.toLowerCase().includes(pattern.toLowerCase())) {
          device = pattern;
          break;
        }
      }

      // Compute relative path from output file to snapshot
      const snapshotRelativePath = path.relative(
        path.dirname(OUTPUT_FILE),
        fullPath
      );

      snapshots.push({
        file: entry.name,
        path: snapshotRelativePath,
        category,
        device,
      });
    }
  }

  return snapshots;
}

function generateHTML(snapshots: Snapshot[]): string {
  // Group by category
  const categories = new Map<string, Snapshot[]>();
  const devices = new Set<string>();

  for (const snapshot of snapshots) {
    if (!categories.has(snapshot.category)) {
      categories.set(snapshot.category, []);
    }
    categories.get(snapshot.category)!.push(snapshot);
    devices.add(snapshot.device);
  }

  // Sort snapshots within each category
  for (const [_, snaps] of categories) {
    snaps.sort((a, b) => a.file.localeCompare(b.file));
  }

  const deviceOptions = Array.from(devices)
    .sort()
    .map((d) => `<option value="${d}">${d}</option>`)
    .join("\n");

  const categoryTabs = Array.from(categories.keys())
    .sort()
    .map(
      (cat, i) =>
        `<button class="tab ${i === 0 ? "active" : ""}" data-category="${cat}">${cat}</button>`
    )
    .join("\n");

  const galleryCards = snapshots
    .map(
      (s) => `
      <div class="card" data-category="${s.category}" data-device="${s.device.toLowerCase()}">
        <img src="${s.path}" alt="${s.file}" loading="lazy" onclick="openModal(this.src)">
        <div class="info">
          <span class="filename">${s.file}</span>
          <span class="badge device">${s.device}</span>
        </div>
      </div>
    `
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Visual Regression Gallery</title>
  <style>
    :root {
      --bg: #f5f5f5;
      --card-bg: #ffffff;
      --text: #333333;
      --border: #e0e0e0;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a1a;
        --card-bg: #2a2a2a;
        --text: #e0e0e0;
        --border: #404040;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      max-width: 1600px;
      margin: 0 auto;
    }

    header {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
    }

    .controls {
      display: flex;
      gap: 12px;
      margin-left: auto;
    }

    select, input {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--card-bg);
      color: var(--text);
      font-size: 14px;
    }

    .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }

    .tab {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--card-bg);
      color: var(--text);
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }

    .tab:hover { border-color: var(--primary); }
    .tab.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }

    .gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }

    .card {
      background: var(--card-bg);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }

    .card img {
      width: 100%;
      height: 200px;
      object-fit: cover;
      object-position: top;
      border-bottom: 1px solid var(--border);
      cursor: zoom-in;
    }

    .info {
      padding: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .filename {
      font-size: 12px;
      font-family: monospace;
      word-break: break-all;
    }

    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--primary);
      color: white;
    }

    .badge.device {
      background: #10b981;
    }

    .hidden { display: none !important; }

    /* Modal */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.9);
      z-index: 1000;
      padding: 20px;
      cursor: zoom-out;
    }

    .modal.show { display: flex; align-items: center; justify-content: center; }

    .modal img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }

    .stats {
      font-size: 14px;
      color: var(--text);
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <header>
    <h1>Visual Regression Gallery</h1>
    <span class="stats">${snapshots.length} snapshots</span>
    <div class="controls">
      <select id="device-filter" onchange="filterGallery()">
        <option value="">All devices</option>
        ${deviceOptions}
      </select>
      <input type="search" id="search" placeholder="Search..." oninput="filterGallery()">
    </div>
  </header>

  <div class="tabs">
    <button class="tab active" data-category="all">All</button>
    ${categoryTabs}
  </div>

  <div class="gallery">
    ${galleryCards}
  </div>

  <div class="modal" id="modal" onclick="closeModal()">
    <img id="modal-img" src="" alt="Full size">
  </div>

  <script>
    let currentCategory = 'all';

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentCategory = tab.dataset.category;
        filterGallery();
      });
    });

    // Filtering
    function filterGallery() {
      const device = document.getElementById('device-filter').value.toLowerCase();
      const search = document.getElementById('search').value.toLowerCase();

      document.querySelectorAll('.card').forEach(card => {
        const cardCategory = card.dataset.category;
        const cardDevice = card.dataset.device;
        const filename = card.querySelector('.filename').textContent.toLowerCase();

        const matchesCategory = currentCategory === 'all' || cardCategory === currentCategory;
        const matchesDevice = !device || cardDevice.includes(device);
        const matchesSearch = !search || filename.includes(search);

        card.classList.toggle('hidden', !(matchesCategory && matchesDevice && matchesSearch));
      });
    }

    // Modal
    function openModal(src) {
      document.getElementById('modal-img').src = src;
      document.getElementById('modal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('show');
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`;
}

function main(): void {
  console.log("Generating visual regression gallery...");
  console.log(`Looking for snapshots in: ${SNAPSHOTS_DIR}`);

  const snapshots = findSnapshots(SNAPSHOTS_DIR);

  if (snapshots.length === 0) {
    console.log("No snapshots found. Run visual tests first:");
    console.log("  npm run test:e2e:mobile:visual -- --update-snapshots");
    return;
  }

  console.log(`Found ${snapshots.length} snapshots`);

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Generate and write HTML
  const html = generateHTML(snapshots);
  fs.writeFileSync(OUTPUT_FILE, html);

  console.log(`Gallery generated: ${OUTPUT_FILE}`);
  console.log(`Open in browser: file://${OUTPUT_FILE}`);
}

main();
