---
description: Run visual QA checks across users and viewports
argument-hint: [--users viewer,editor] [--filter catalog]
---

# Visual QA Workflow

Run visual QA checks on the web application, taking screenshots across multiple users and viewports, analyzing for rendering issues, and generating an HTML report.

## Arguments

Parse the following from `$ARGUMENTS`:
- `--users <names>`: Comma-separated user names to test (default: all users from config)
- `--filter <text>`: Filter pages by name substring (default: all pages)

## Workflow

### 1. Read Configuration

Read `.claude/visual-qa.json` to get:
- `baseUrl`: The base URL for the web app (default: http://localhost:3001)
- `outputDir`: Base directory for results (default: web/qa-results)
- `viewports`: List of viewport sizes to test
- `users`: List of test users with email and name
- `pages`: List of pages to screenshot

### 2. Parse Arguments

From `$ARGUMENTS`:
- If `--users` provided, filter users list to only those names
- If `--filter` provided, filter pages list to those matching the substring

### 3. Create Output Directory

Create a timestamped output directory:
```
{outputDir}/YYYYMMDD-HHMMSS/
```

Use current date/time for the timestamp.

### 4. Process Each User (SEQUENTIAL)

**Important:** Users must be processed sequentially because browser tabs share the same session. Different users need separate login sessions.

For each user in the filtered list:

1. Close any existing browser tabs to start fresh
2. Run the visual-qa-checker workflow:
   - Login as the user
   - Open all filtered pages in tabs
   - For each viewport, screenshot all pages
   - Analyze screenshots for issues
   - Save results.json

The checker should save:
- Screenshots: `{outputDir}/{user.name}/{page.name}-{viewport.name}.png`
- Results: `{outputDir}/{user.name}/results.json`

### 5. Generate Report

After all users are processed, generate the HTML report:
- Read all `results.json` files from user subdirectories
- Aggregate statistics
- Generate `{outputDir}/report.html`

### 6. Report Results

Tell the user:
- Path to the HTML report
- Summary of findings (total screenshots, errors, warnings)
- How to open the report in a browser

## Example Usage

```
/visual-qa
# Run full QA on all users and pages

/visual-qa --users viewer
# Only test as viewer user

/visual-qa --filter catalog
# Only test pages with "catalog" in the name

/visual-qa --users viewer,editor --filter settings
# Test settings page as viewer and editor
```

## Notes

- Ensure the web app is running on the configured baseUrl before starting
- The dev environment should be up: `just dev-up`
- Screenshots are analyzed using Claude's vision capabilities
- Pages with dynamic content (like Recording Detail) may need test data in the database
