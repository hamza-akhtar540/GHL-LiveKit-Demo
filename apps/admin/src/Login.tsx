import { useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import TextField from "@mui/material/TextField";
import { useAuth } from "./auth";
import { Box, Stack, Typography } from "./components/sys";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "background.default", p: 2 }}>
      <Card sx={{ width: "100%", maxWidth: 400, p: 4 }}>
        <Stack component="form" onSubmit={submit} gap={2.5}>
          <Box>
            <Typography variant="h5">Admin console</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              Sign in to manage leads, bookings and follow-ups.
            </Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </Stack>
      </Card>
    </Box>
  );
}
