import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Snackbar from "@mui/material/Snackbar";
import { ApiError } from "../api";

type Severity = "success" | "error" | "info";
interface ConfirmOpts {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface Feedback {
  notify(message: string, severity?: Severity): void;
  confirm(opts: ConfirmOpts): Promise<boolean>;
  /** Runs an action, reporting success or the server's own reason for failure. */
  run<T>(label: string, action: () => Promise<T>): Promise<T | undefined>;
}

const Ctx = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; severity: Severity } | null>(null);
  const [asking, setAsking] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => {});

  const notify = useCallback((message: string, severity: Severity = "success") => setToast({ message, severity }), []);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setAsking(opts);
      }),
    [],
  );

  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>) => {
      try {
        const out = await action();
        notify(`${label} — done`);
        return out;
      } catch (e) {
        notify(e instanceof ApiError || e instanceof Error ? e.message : String(e), "error");
        return undefined;
      }
    },
    [notify],
  );

  const settle = (ok: boolean) => {
    setAsking(null);
    resolver.current(ok);
  };

  return (
    <Ctx.Provider value={{ notify, confirm, run }}>
      {children}
      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert severity={toast?.severity ?? "info"} variant="filled" onClose={() => setToast(null)}>
          {toast?.message}
        </Alert>
      </Snackbar>
      <Dialog open={!!asking} onClose={() => settle(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{asking?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">{asking?.body}</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => settle(false)}>Cancel</Button>
          <Button variant="contained" color={asking?.danger ? "error" : "primary"} onClick={() => settle(true)}>
            {asking?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogActions>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useFeedback(): Feedback {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFeedback outside FeedbackProvider");
  return v;
}
