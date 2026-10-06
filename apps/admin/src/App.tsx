import { useMemo, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import CircularProgress from "@mui/material/CircularProgress";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { AuthProvider, useAuth } from "./auth";
import { buildTheme } from "./theme";
import { FeedbackProvider } from "./components/feedback";
import { Layout } from "./components/Layout";
import { Login } from "./Login";
import { OverviewPage } from "./pages/Overview";
import { ConversationsPage } from "./pages/Conversations";
import { LeadsPage } from "./pages/Leads";
import { BookingsPage } from "./pages/Bookings";
import { EmailsPage } from "./pages/Emails";
import { SocialPage } from "./pages/Social";
import { ContactsPage, LivePage, NeedsHumanPage, OpportunitiesPage } from "./pages/Lists";
import { Box } from "./components/sys";

type Mode = "light" | "dark";

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem("admin-mode");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage can be blocked; fall through to the system setting */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function Shell({ mode, onToggleMode }: { mode: Mode; onToggleMode(): void }) {
  const { me, loading } = useAuth();
  if (loading) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!me) return <Login />;
  return (
    <HashRouter>
      <Layout mode={mode} onToggleMode={onToggleMode}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/needs-human" element={<NeedsHumanPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/bookings" element={<BookingsPage />} />
          <Route path="/opportunities" element={<OpportunitiesPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/emails" element={<EmailsPage />} />
          <Route path="/social" element={<SocialPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}

export function App() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);

  const toggle = () =>
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("admin-mode", next);
      } catch {
        /* a preference that doesn't persist is still a working toggle */
      }
      return next;
    });

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <FeedbackProvider>
        <AuthProvider>
          <Shell mode={mode} onToggleMode={toggle} />
        </AuthProvider>
      </FeedbackProvider>
    </ThemeProvider>
  );
}
