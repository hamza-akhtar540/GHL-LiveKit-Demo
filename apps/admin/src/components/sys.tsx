import type { ElementType } from "react";
import MuiBox, { type BoxProps } from "@mui/material/Box";
import MuiStack, { type StackProps } from "@mui/material/Stack";
import MuiTypography, { type TypographyProps } from "@mui/material/Typography";

/**
 * MUI 9 dropped the shorthand layout props (`px`, `gap`, `fontWeight`, …) from
 * Box, Stack and Typography — they live in `sx` now. These wrappers keep the
 * pages readable by moving those props into `sx`, so every page imports layout
 * primitives from here rather than from @mui/material.
 */
const SYSTEM_KEYS = [
  "p", "px", "py", "pt", "pb", "pl", "pr",
  "m", "mx", "my", "mt", "mb", "ml", "mr",
  "gap", "flex", "minWidth", "maxWidth", "width", "height", "minHeight", "overflow",
  "display", "alignItems", "justifyContent", "alignSelf", "textAlign",
  "fontWeight", "color", "whiteSpace", "bgcolor", "flexWrap",
] as const;

type SystemProps = { [K in (typeof SYSTEM_KEYS)[number]]?: unknown };
type Polymorphic = { component?: ElementType; to?: string };

function split<P extends Record<string, unknown>>(props: P) {
  const sys: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if ((SYSTEM_KEYS as readonly string[]).includes(k)) sys[k] = v;
    else rest[k] = v;
  }
  const own = rest.sx;
  rest.sx = Array.isArray(own) ? [sys, ...own] : own ? [sys, own] : sys;
  return rest;
}

export function Box(props: BoxProps & SystemProps & Polymorphic) {
  return <MuiBox {...(split(props as Record<string, unknown>) as BoxProps)} />;
}

export function Stack(props: StackProps & SystemProps & Polymorphic & { onSubmit?: (e: React.FormEvent) => void }) {
  return <MuiStack {...(split(props as Record<string, unknown>) as StackProps)} />;
}

export function Typography(props: TypographyProps & SystemProps & Polymorphic & { noWrap?: boolean }) {
  return <MuiTypography {...(split(props as Record<string, unknown>) as TypographyProps)} />;
}
