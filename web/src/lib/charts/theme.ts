/**
 * Chart theme constants for recharts
 * Uses CSS variables from globals.css for consistent theming
 */

export const chartColors = {
  // Audio engagement
  plays: "#e11d48", // rose-600
  uniqueUsers: "#0ea5e9", // sky-500

  // User activity
  logins: "#22c55e", // green-500
  signups: "#a855f7", // purple-500

  // Security (semantic colors)
  failedLogins: "#dc2626", // red-600
  accessDenied: "#f59e0b", // amber-500
  adminActions: "#8b5cf6", // violet-500
};

export const chartConfig = {
  height: {
    desktop: 200,
    mobile: 150,
  },
  margin: {
    top: 10,
    right: 10,
    left: 0,
    bottom: 0,
  },
};

export const tooltipStyle = {
  contentStyle: {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "var(--radius)",
    fontSize: "12px",
  },
  labelStyle: {
    fontWeight: 600,
    marginBottom: "4px",
  },
};
