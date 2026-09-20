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

// Validated categorical palette (dataviz skill default): fixed hue order,
// worst adjacent CVD Delta E 9.1 (>=8 target). Never cycle or reassign by
// rank -- a series keeps its color as the set of series changes.
export const categoricalSeriesColors = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

// Neutral, non-hued tones for aggregate "everything else" series, kept
// visually distinct from the categorical identities above.
export const neutralSeriesColor = '#898781'; // muted axis/label gray
export const unknownSeriesDash = '4 3';

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
