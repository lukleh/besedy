---
name: visual-qa-reporter
description: Generate HTML report from visual QA results. Combines all checker results into a single browsable report.
---

# Visual QA Reporter Agent

Generate an HTML report combining all checker results.

## Input (provided in prompt)
- outputDir: path containing user subdirectories with results.json files

## Workflow

1. Use Glob to find all `*/results.json` files in outputDir
2. Read each results.json file
3. Aggregate statistics across all users
4. Generate `{outputDir}/report.html`

## Report Structure

Generate a self-contained HTML file with embedded CSS:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Visual QA Report - {timestamp}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; padding: 2rem; max-width: 1400px; margin: 0 auto; }

    header { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #e5e7eb; }
    h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 0.5rem; }
    .timestamp { color: #6b7280; }

    .summary { display: flex; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
    .summary-item { padding: 0.5rem 1rem; border-radius: 0.375rem; font-weight: 500; }
    .summary-total { background: #f3f4f6; }
    .summary-ok { background: #d1fae5; color: #065f46; }
    .summary-warning { background: #fef3c7; color: #92400e; }
    .summary-error { background: #fee2e2; color: #991b1b; }

    nav { position: sticky; top: 0; background: white; padding: 1rem 0; margin-bottom: 2rem; border-bottom: 1px solid #e5e7eb; z-index: 100; }
    nav ul { display: flex; gap: 1rem; list-style: none; flex-wrap: wrap; }
    nav a { color: #3b82f6; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    nav a.has-errors { color: #dc2626; font-weight: 600; }
    nav a.has-warnings { color: #d97706; }

    section { margin-bottom: 3rem; }
    h2 { font-size: 1.5rem; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e5e7eb; }

    .page { margin-bottom: 2rem; padding: 1rem; background: #f9fafb; border-radius: 0.5rem; }
    .page h3 { font-size: 1.125rem; margin-bottom: 1rem; }

    .viewports { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
    figure { background: white; border: 1px solid #e5e7eb; border-radius: 0.375rem; overflow: hidden; }
    figure.has-errors { border-color: #dc2626; border-width: 2px; }
    figure.has-warnings { border-color: #d97706; border-width: 2px; }
    figure img { width: 100%; height: auto; display: block; }
    figcaption { padding: 0.5rem; text-align: center; font-size: 0.875rem; background: #f9fafb; }

    .issues { margin-top: 1rem; }
    .issue { padding: 0.75rem; border-radius: 0.375rem; margin-bottom: 0.5rem; }
    .issue.error { background: #fee2e2; border-left: 4px solid #dc2626; }
    .issue.warning { background: #fef3c7; border-left: 4px solid #d97706; }
    .issue strong { display: block; margin-bottom: 0.25rem; }
    .issue .location { font-size: 0.875rem; color: #6b7280; }
    .issue .suggestion { font-size: 0.875rem; margin-top: 0.5rem; padding: 0.5rem; background: rgba(255,255,255,0.5); border-radius: 0.25rem; font-family: monospace; }

    @media print {
      nav { position: static; }
      .page { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Visual QA Report</h1>
    <p class="timestamp">Generated: {timestamp}</p>
    <div class="summary">
      <span class="summary-item summary-total">Total: {total} screenshots</span>
      <span class="summary-item summary-ok">OK: {ok}</span>
      <span class="summary-item summary-warning">Warnings: {warnings}</span>
      <span class="summary-item summary-error">Errors: {errors}</span>
    </div>
  </header>

  <nav>
    <ul>
      <!-- Links to each user section, highlighted if has issues -->
      <li><a href="#user-viewer" class="has-errors">viewer (2 errors)</a></li>
      <li><a href="#user-editor">editor</a></li>
    </ul>
  </nav>

  <main>
    <!-- Per user section -->
    <section id="user-viewer">
      <h2>viewer@besedy.test</h2>

      <article class="page">
        <h3>Catalog List</h3>

        <div class="viewports">
          <figure>
            <img src="viewer/Catalog List-desktop.png" alt="Catalog List - Desktop">
            <figcaption>Desktop (1280x800) ✓</figcaption>
          </figure>
          <figure class="has-warnings">
            <img src="viewer/Catalog List-mobile.png" alt="Catalog List - Mobile">
            <figcaption>Mobile (390x844) ⚠️ 1 warning</figcaption>
          </figure>
        </div>

        <div class="issues">
          <div class="issue warning">
            <strong>Warning: Filter dropdown overlaps table header</strong>
            <p class="location">Location: Top right, filter section</p>
            <p class="suggestion">Fix: Add z-index to dropdown or margin-top to table</p>
          </div>
        </div>
      </article>
    </section>
  </main>
</body>
</html>
```

## Styling Guidelines

- **Errors**: Red border/background (#fee2e2, #dc2626)
- **Warnings**: Yellow/amber (#fef3c7, #d97706)
- **OK**: Green checkmark (#d1fae5, #065f46)
- Screenshots displayed in responsive grid
- Sticky navigation for quick jumping between users
- Print-friendly styles (no fixed positioning)

## Output

Write the complete HTML to `{outputDir}/report.html`

Report the final path to the user so they can open it in a browser.
