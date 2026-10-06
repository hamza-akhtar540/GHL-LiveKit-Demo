import { describe, expect, it } from "vitest";
import { validateContactForm } from "./contact-form.js";

describe("validateContactForm", () => {
  it("accepts and normalises good input", () => {
    const r = validateContactForm({ full_name: "  Sara   Khan ", email: " Sara@Example.COM ", phone: "+92 (300) 123-4567" });
    expect(r).toEqual({ ok: true, values: { full_name: "Sara Khan", email: "Sara@example.com", phone: "+923001234567" } });
  });

  it.each(["", "a", "12345", "   "])("rejects the name %j", (name) => {
    expect(validateContactForm({ full_name: name }, ["full_name"]).ok).toBe(false);
  });

  it("accepts names in other scripts", () => {
    expect(validateContactForm({ full_name: "حمزہ راج" }, ["full_name"]).ok).toBe(true);
  });

  it.each(["plain", "a@b", "a b@c.com", "a@@b.com", "@b.com", "a@b.c"])("rejects the email %j", (email) => {
    expect(validateContactForm({ email }, ["email"]).ok).toBe(false);
  });

  it.each(["0000", "abc", "123", "+1234567890123456", "12-34"])("rejects the phone %j", (phone) => {
    expect(validateContactForm({ phone }, ["phone"]).ok).toBe(false);
  });

  it("turns a 00 prefix into +", () => {
    expect(validateContactForm({ phone: "0092 300 1234567" }, ["phone"])).toEqual({ ok: true, values: { phone: "+923001234567" } });
  });

  it("reports every bad field at once", () => {
    const r = validateContactForm({ full_name: "x", email: "no", phone: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["email", "full_name", "phone"]);
  });

  it("only checks the fields asked for", () => {
    expect(validateContactForm({ email: "a@b.com" }, ["email"]).ok).toBe(true);
  });

  it("ignores non-string input rather than throwing", () => {
    expect(validateContactForm({ email: 5, full_name: null }).ok).toBe(false);
  });
});
