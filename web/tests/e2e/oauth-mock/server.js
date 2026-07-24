/**
 * Mock OAuth2/OIDC server for development and E2E testing
 *
 * Provides a fully functional OAuth2 server that can be used to test
 * real OAuth flows without depending on external providers like Google.
 *
 * Features:
 * - OpenID Connect discovery endpoint (/.well-known/openid-configuration)
 * - JWKS endpoint for token verification
 * - Authorization and token endpoints
 * - Interactive user selection UI (for manual testing)
 * - Programmatic login via login_hint (for E2E tests)
 * - Error simulation for testing error handling
 */

const express = require("express");
const { OAuth2Server } = require("oauth2-mock-server");

const PORT = parseInt(process.env.OAUTH_MOCK_PORT || "8090", 10);
const HOST = process.env.OAUTH_MOCK_HOST || "0.0.0.0";
// Base path for when server is accessed via reverse proxy (e.g., "/mock-oauth")
// When set, form actions and redirects use this prefix
const BASE_PATH = normalizeBasePath(process.env.OAUTH_MOCK_BASE_PATH || "");

function normalizeBasePath(basePath) {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const noLeading = trimmed.replace(/^\/+/, "");
  const noTrailing = noLeading.replace(/\/+$/, "");
  return `/${noTrailing}`;
}

function getPublicPath(pathname, options = {}) {
  const { relativeWhenNoBase = false } = options;
  const cleanedPath = pathname.replace(/^\/+/, "");
  if (BASE_PATH) {
    return `${BASE_PATH}/${cleanedPath}`;
  }
  return relativeWhenNoBase ? cleanedPath : `/${cleanedPath}`;
}

function appendQuery(pathname, queryString) {
  return queryString ? `${pathname}?${queryString}` : pathname;
}

// Store login_hint from authorization request to use during token signing
// Key: OAuth authorization code, Value: login_hint email
// This allows parallel tests to work correctly by associating hints with specific flows
const codeToEmail = new Map();

// Predefined test users matching prisma/test-data.ts
const TEST_USERS = [
  {
    email: "superadmin@besedy.test",
    label: "Superadmin",
    description: "Full system access",
    category: "system",
    color: "#9333ea", // purple-600
  },
  {
    email: "admin@besedy.test",
    label: "Admin",
    description: "User/catalog management",
    category: "system",
    color: "#4f46e5", // indigo-600
  },
  {
    email: "owner@besedy.test",
    label: "Owner",
    description: "OWNER catalog access",
    category: "catalog",
    color: "#15803d", // green-700
  },
  {
    email: "editor@besedy.test",
    label: "Editor",
    description: "EDITOR catalog access",
    category: "catalog",
    color: "#a16207", // yellow-700
  },
  {
    email: "member@besedy.test",
    label: "Member",
    description: "MEMBER catalog access",
    category: "catalog",
    color: "#2563eb", // blue-600
  },
  {
    email: "viewer@besedy.test",
    label: "Viewer",
    description: "VIEWER catalog access",
    category: "catalog",
    color: "#6b7280", // gray-500
  },
  {
    email: "listener@besedy.test",
    label: "Listener",
    description: "LISTENER (no transcripts)",
    category: "catalog",
    color: "#475569", // slate-600
  },
  {
    email: "noaccess@besedy.test",
    label: "No Access",
    description: "No catalog access",
    category: "special",
    color: "#ea580c", // orange-600
  },
  {
    email: "pending@besedy.test",
    label: "Pending",
    description: "PENDING approval",
    category: "special",
    color: "#d97706", // amber-600
  },
  {
    email: "blocked@besedy.test",
    label: "Blocked",
    description: "BLOCKED user",
    category: "special",
    color: "#dc2626", // red-600
  },
];

/**
 * Generate the user selection HTML page
 */
function generateUserSelectionPage(queryString) {
  const systemUsers = TEST_USERS.filter((u) => u.category === "system");
  const catalogUsers = TEST_USERS.filter((u) => u.category === "catalog");
  const specialUsers = TEST_USERS.filter((u) => u.category === "special");
  const selectUserAction = getPublicPath("select-user", { relativeWhenNoBase: true });

  const renderUserButton = (user) => `
    <button type="submit" name="email" value="${user.email}"
            style="background: ${user.color}; color: white; border: none; padding: 10px 16px;
                   border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;
                   transition: opacity 0.2s; min-width: 120px;"
            onmouseover="this.style.opacity='0.9'"
            onmouseout="this.style.opacity='1'"
            title="${user.description}">
      ${user.label}
    </button>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test OAuth Server - User Selection</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px;
    }
    .warning-banner {
      background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      margin-bottom: 24px;
      text-align: center;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 4px 12px rgba(255, 107, 53, 0.3);
    }
    .warning-banner h1 {
      font-size: 18px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .warning-banner p {
      font-size: 13px;
      opacity: 0.9;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 32px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .card h2 {
      color: #1a1a2e;
      font-size: 20px;
      margin-bottom: 24px;
      text-align: center;
    }
    .category {
      margin-bottom: 20px;
    }
    .category-label {
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }
    .button-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .divider {
      border: none;
      border-top: 1px solid #e5e7eb;
      margin: 24px 0;
    }
    .custom-section h3 {
      font-size: 14px;
      color: #374151;
      margin-bottom: 12px;
    }
    .custom-form {
      display: flex;
      gap: 8px;
    }
    .custom-form input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .custom-form input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    .custom-form button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .custom-form button:hover {
      background: #2563eb;
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      color: #6b7280;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="warning-banner">
    <h1>&#9888; TEST OAUTH SERVER</h1>
    <p>This is a mock OAuth provider for development and testing.<br>NOT connected to Google or any real provider.</p>
  </div>

  <div class="card">
    <h2>Select a Test User</h2>

    <form method="POST" action="${appendQuery(selectUserAction, queryString)}">
      <div class="category">
        <div class="category-label">System Level</div>
        <div class="button-grid">
          ${systemUsers.map(renderUserButton).join("")}
        </div>
      </div>

      <div class="category">
        <div class="category-label">Catalog Access</div>
        <div class="button-grid">
          ${catalogUsers.map(renderUserButton).join("")}
        </div>
      </div>

      <div class="category">
        <div class="category-label">Special States</div>
        <div class="button-grid">
          ${specialUsers.map(renderUserButton).join("")}
        </div>
      </div>

      <hr class="divider">

      <div class="custom-section">
        <h3>Or enter a custom email:</h3>
        <div class="custom-form">
          <input type="email" name="custom_email" placeholder="user@example.com" />
          <button type="submit" name="use_custom" value="1">Sign In</button>
        </div>
      </div>
    </form>

    <div class="footer">
      Mock OAuth Server &bull; Port ${PORT}
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  const oauth2Server = new OAuth2Server();
  const app = express();

  // Parse form data
  app.use(express.urlencoded({ extended: true }));

  // Configure issuer URL (required for OIDC discovery)
  oauth2Server.issuer.url = `http://localhost:${PORT}`;

  // Generate RSA key for signing tokens
  await oauth2Server.issuer.keys.generate("RS256");
  console.log("[oauth-mock] Keys generated");

  // Configure authorization behavior
  oauth2Server.service.on("beforeAuthorizeRedirect", (authorizeRedirectUri, req) => {
    const simulateError = req.query?.simulate_error;
    const loginHint = req.query?.login_hint;

    // Extract authorization code from redirect URL
    let code = null;
    const actualUrl = authorizeRedirectUri?.url || authorizeRedirectUri;

    if (actualUrl) {
      if (typeof actualUrl.searchParams?.get === "function") {
        code = actualUrl.searchParams.get("code");
      }
      if (!code && actualUrl.search) {
        const params = new URLSearchParams(actualUrl.search);
        code = params.get("code");
      }
      if (!code && actualUrl.href) {
        try {
          const url = new URL(actualUrl.href);
          code = url.searchParams.get("code");
        } catch (e) {}
      }
      if (!code && typeof actualUrl === "string") {
        try {
          const url = new URL(actualUrl);
          code = url.searchParams.get("code");
        } catch (e) {}
      }
    }

    if (loginHint && code) {
      codeToEmail.set(code, loginHint);
      console.log(`[oauth-mock] Stored login_hint for code ${code.slice(0, 8)}...: ${loginHint}`);
    }

    // Handle error simulation
    if (simulateError && authorizeRedirectUri && authorizeRedirectUri.searchParams) {
      if (simulateError === "access_denied") {
        authorizeRedirectUri.searchParams.set("error", "access_denied");
        authorizeRedirectUri.searchParams.set(
          "error_description",
          "The user denied the authorization request"
        );
        authorizeRedirectUri.searchParams.delete("code");
        console.log("[oauth-mock] Simulating access_denied error");
      } else if (simulateError === "server_error") {
        authorizeRedirectUri.searchParams.set("error", "server_error");
        authorizeRedirectUri.searchParams.set(
          "error_description",
          "The authorization server encountered an unexpected condition"
        );
        authorizeRedirectUri.searchParams.delete("code");
        console.log("[oauth-mock] Simulating server_error");
      }
    }
  });

  // Configure token claims based on request
  oauth2Server.service.on("beforeTokenSigning", (token, req) => {
    const code = req.body?.code;
    let email = "testuser@example.com";

    if (code && codeToEmail.has(code)) {
      email = codeToEmail.get(code);
      console.log(`[oauth-mock] Found stored email for code: ${email}`);
    } else if (code) {
      console.log(`[oauth-mock] No stored email for code ${code.slice(0, 8)}..., using default`);
    }

    // Set standard OIDC claims
    token.payload.email = email;
    token.payload.email_verified = true;
    token.payload.name = email.split("@")[0].replace(/[._]/g, " ");
    token.payload.given_name = email.split("@")[0].split(/[._]/)[0];
    token.payload.family_name = email.split("@")[0].split(/[._]/)[1] || "User";
    token.payload.picture = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(email)}`;

    // Use a consistent subject ID based on email for reproducible tests
    token.payload.sub = `mock-oauth-${Buffer.from(email).toString("base64url")}`;

    console.log(`[oauth-mock] Token signed for: ${email}`);
  });

  // Configure userinfo endpoint
  oauth2Server.service.on("beforeUserinfo", (userInfoResponse, req) => {
    console.log("[oauth-mock] Userinfo requested");
  });

  // Custom route: User selection page (intercepts /authorize when no login_hint)
  app.get("/authorize", (req, res) => {
    const loginHint = req.query.login_hint;
    const simulateError = req.query.simulate_error;

    // If login_hint is provided (E2E tests), proceed directly to OAuth flow
    if (loginHint || simulateError) {
      console.log(`[oauth-mock] /authorize with login_hint=${loginHint}, proceeding to OAuth flow`);
      // Forward to the actual OAuth2 server
      return oauth2Server.service.requestHandler(req, res);
    }

    // Otherwise, show user selection page
    console.log("[oauth-mock] /authorize without login_hint, showing user selection page");
    const queryString = new URLSearchParams(req.query).toString();
    res.send(generateUserSelectionPage(queryString));
  });

  // Custom route: Handle user selection form submission
  app.post("/select-user", (req, res) => {
    // Determine which email to use
    let email;
    if (req.body.use_custom === "1" && req.body.custom_email) {
      email = req.body.custom_email;
    } else if (req.body.email) {
      email = req.body.email;
    } else {
      email = "testuser@example.com";
    }

    console.log(`[oauth-mock] User selected: ${email}`);

    // Rebuild the original authorize URL with login_hint added
    const params = new URLSearchParams(req.query);
    params.set("login_hint", email);

    // Redirect to /authorize with login_hint (will now proceed to OAuth flow)
    const authorizePath = getPublicPath("authorize", { relativeWhenNoBase: true });
    res.redirect(appendQuery(authorizePath, params.toString()));
  });

  // Forward all other requests to OAuth2 server (token, userinfo, jwks, discovery)
  // This catches everything not handled by /authorize or /select-user above
  app.all("*", (req, res) => {
    oauth2Server.service.requestHandler(req, res);
  });

  // Start Express server
  app.listen(PORT, HOST, () => {
    console.log(`[oauth-mock] Server started at http://${HOST}:${PORT}`);
    console.log(`[oauth-mock] Base path mode: ${BASE_PATH || "(none, relative links)"}`);
    console.log(`[oauth-mock] Discovery: http://${HOST}:${PORT}/.well-known/openid-configuration`);
    console.log(`[oauth-mock] JWKS: http://${HOST}:${PORT}/jwks`);
    console.log(`[oauth-mock] Authorize: http://${HOST}:${PORT}/authorize`);
    console.log(`[oauth-mock] Token: http://${HOST}:${PORT}/token`);
    console.log(`[oauth-mock] Userinfo: http://${HOST}:${PORT}/userinfo`);
    console.log(`[oauth-mock] User Selection UI enabled (no login_hint → show UI)`);
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("[oauth-mock] Shutting down...");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[oauth-mock] Failed to start:", err);
  process.exit(1);
});
