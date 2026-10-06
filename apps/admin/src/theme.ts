import { createTheme, type PaletteMode } from "@mui/material/styles";

export function buildTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? "#8ea2ff" : "#3f51b5" },
      secondary: { main: "#00897b" },
      background: dark ? { default: "#0f1220", paper: "#171b2e" } : { default: "#f4f6fb", paper: "#ffffff" },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      h5: { fontWeight: 700 },
      h6: { fontWeight: 650 },
      button: { textTransform: "none", fontWeight: 600 },
    },
    components: {
      MuiCard: { defaultProps: { variant: "outlined" } },
      MuiPaper: { styleOverrides: { outlined: { borderColor: dark ? "#2a3050" : "#e3e7f1" } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiDrawer: { styleOverrides: { paper: { borderRight: `1px solid ${dark ? "#2a3050" : "#e3e7f1"}` } } },
    },
  });
}
